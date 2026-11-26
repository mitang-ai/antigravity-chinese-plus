'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const guardian = require('../core/guardian-core');

const REPO_ROOT = path.resolve(__dirname, '..');

test('compareSemver compares multi-part version strings accurately', () => {
  assert.equal(guardian.compareSemver('3.6.0', '3.5.0'), 1);
  assert.equal(guardian.compareSemver('v3.6.0', '3.6.0'), 0);
  assert.equal(guardian.compareSemver('3.5.9', '3.6.0'), -1);
  assert.equal(guardian.compareSemver('3.10.0', '3.9.9'), 1);
});

test('syncRuntimeFromDir creates self-contained runtime with @electron/asar and manifest', t => {
  const tmpPlus = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plus-home-'));
  t.after(() => fs.rmSync(tmpPlus, { recursive: true, force: true }));

  const res = guardian.syncRuntimeFromDir(REPO_ROOT, { plusHome: tmpPlus });
  assert.equal(res.version, require('../package.json').version);
  assert.ok(fs.existsSync(path.join(res.runtimeDir, 'cli.js')));
  assert.ok(fs.existsSync(path.join(res.runtimeDir, 'dist', 'zh-CN.bundle.json')));
  assert.ok(fs.existsSync(path.join(res.runtimeDir, 'core', 'guardian-core.js')));
  assert.ok(fs.existsSync(path.join(res.runtimeDir, 'node_modules', '@electron', 'asar', 'package.json')));
  assert.ok(fs.existsSync(path.join(res.runtimeDir, 'plugins', 'chinese-toolkit', 'sidecars', 'i18n_guardian', 'sidecar.json')));

  const manifest = guardian.loadManifest(tmpPlus);
  assert.equal(manifest.autoPreserveOnClientUpdate, true);
  assert.equal(manifest.version, res.version);
});

test('ensurePluginInstalledAndEnabled merges plugin enablement without clobbering existing config', t => {
  const tmpGemini = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gemini-home-'));
  t.after(() => fs.rmSync(tmpGemini, { recursive: true, force: true }));

  const cfgPath = path.join(tmpGemini, 'config', 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    plugins: {
      'cache-sentinel': { enabled: true },
      'notion': { enabled: false }
    },
    userSettings: { themeMode: 'THEME_MODE_DARK' }
  }, null, 2));

  const targetPlugin = path.join(tmpGemini, 'config', 'plugins', 'chinese-toolkit');
  const res = guardian.ensurePluginInstalledAndEnabled(
    path.join(REPO_ROOT, 'plugins', 'chinese-toolkit'),
    { pluginTargetDir: targetPlugin, geminiHome: tmpGemini }
  );

  assert.equal(res.enabled, true);
  assert.ok(fs.existsSync(path.join(targetPlugin, 'sidecars', 'i18n_guardian', 'main.mjs')));
  const updated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(updated.plugins['chinese-toolkit'].enabled, true);
  assert.equal(updated.plugins['cache-sentinel'].enabled, true);
  assert.equal(updated.plugins['notion'].enabled, false);
  assert.equal(updated.userSettings.themeMode, 'THEME_MODE_DARK');
});

test('ensureLegacyTranslationPreserved builds staged package for simulated newly updated official asar', async t => {
  const asarLib = require('@electron/asar');
  const tmpPlus = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plus-preserve-'));
  const tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-client-'));
  t.after(() => {
    fs.rmSync(tmpPlus, { recursive: true, force: true });
    fs.rmSync(tmpApp, { recursive: true, force: true });
  });

  guardian.syncRuntimeFromDir(REPO_ROOT, { plusHome: tmpPlus });

  // 构建模拟官方刚升级的原生 app.asar（不含中文注入标记）
  const srcExtract = path.join(tmpApp, 'raw');
  fs.mkdirSync(path.join(srcExtract, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(srcExtract, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.99.0' }));
  fs.writeFileSync(path.join(srcExtract, 'dist', 'preload.js'), '"use strict";\n// clean upstream 2.99.0 preload\n');
  const mockAsar = path.join(tmpApp, 'resources', 'app.asar');
  fs.mkdirSync(path.dirname(mockAsar), { recursive: true });
  await asarLib.createPackage(srcExtract, mockAsar);

  const prevPlus = process.env.AGY_PLUS_HOME;
  process.env.AGY_PLUS_HOME = tmpPlus;
  try {
    const stateBefore = guardian.inspectSystemState({
      plusHome: tmpPlus,
      customPath: mockAsar,
      findAsarPath: () => mockAsar,
      isProcessRunning: () => true
    });
    assert.equal(stateBefore.client.version, '2.99.0');
    assert.equal(stateBefore.client.patched, false);
    assert.equal(stateBefore.client.stagedState, 'none');

    // 因为 mock 宿主 "isProcessRunning: () => true" + runRuntimeInstall 带 ANTIGRAVITY_AGENT=1，
    // 真实跑 install 时对 mockAsar 会因为磁盘上文件无锁而直接原位注入成功，或有锁时生成 staged；两者都证明旧版词库已立即被自动应用到 2.99.0！
    const res = guardian.ensureLegacyTranslationPreserved({
      plusHome: tmpPlus,
      customPath: mockAsar,
      findAsarPath: () => mockAsar,
      isProcessRunning: () => false
    });
    assert.ok(res.action === 'patched_inline' || res.action === 'legacy_staged_created');
    assert.equal(res.state.client.patched || res.state.client.stagedState === 'ready', true);

    // 校验 staged.meta.json 使用 getAsarFingerprint 后，inspectSystemState 必须精准识别为 ready 而非 stale
    const cli = require('../cli');
    const stagedPath = path.join(path.dirname(mockAsar), 'app.asar.staged');
    const stagedMetaPath = path.join(path.dirname(mockAsar), 'app.asar.staged.meta.json');
    fs.copyFileSync(mockAsar, stagedPath);
    fs.writeFileSync(stagedMetaPath, JSON.stringify({
      sourceFingerprint: cli.getAsarFingerprint(mockAsar),
      stagedFingerprint: cli.getAsarFingerprint(stagedPath),
      timestamp: Date.now()
    }));
    const stagedStateCheck = guardian.inspectSystemState({
      plusHome: tmpPlus,
      customPath: mockAsar,
      findAsarPath: () => mockAsar,
      isProcessRunning: () => true
    });
    assert.equal(stagedStateCheck.client.stagedState, 'ready');
  } finally {
    if (prevPlus === undefined) delete process.env.AGY_PLUS_HOME;
    else process.env.AGY_PLUS_HOME = prevPlus;
  }
});

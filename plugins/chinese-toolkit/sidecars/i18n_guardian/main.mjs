/**
 * @fileoverview Antigravity 中文汉化守护驾驶舱 (i18n Guardian) Sidecar 后端服务。
 *
 * 位于用户数据目录 ~/.gemini/config/plugins/chinese-toolkit/ 之下，客户端官方更新不会将其清除：
 * - 启动时自动探测客户端 app.asar 状态：若官方刚刚更新，自动使用本地持久化的旧版词库构建 app.asar.staged；
 * - 联网检测 GitHub Release 新版本，提供驾驶舱内一键在线下载更新并构建新版预注入包；
 * - 更新或兼容构建完成后主动触发前端重启请求弹窗，并协调优雅重启原子切换。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Sidecar 由 Antigravity.exe (ELECTRON_RUN_AS_NODE=1) 拉起，关闭 .asar 虚拟目录拦截以正常读写物理 app.asar
process.noAsar = true;

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const NO_STORE = { 'Cache-Control': 'no-store' };

function getGeminiHome() {
  return process.env.GEMINI_HOME || join(homedir(), '.gemini');
}

function getPlusHome() {
  return process.env.AGY_PLUS_HOME || join(getGeminiHome(), 'antigravity-chinese-plus');
}

/**
 * 动态加载 Antigravity 内置 sidecar_sdk。
 */
async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const candidates = [
      join(getGeminiHome(), 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
      join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        return await import(pathToFileURL(p).href);
      }
    }
    throw new Error('未找到 Antigravity 内置 sidecar_sdk，请在 Antigravity 插件环境中运行。');
  }
}

/**
 * 解析并加载 guardian-core.js（优先外置持久目录，缺失时回退本地源码仓库）。
 */
function loadGuardianCore() {
  const plusHome = getPlusHome();
  const candidates = [
    join(plusHome, 'runtime', 'core', 'guardian-core.js'),
    resolve(__dirname, '..', '..', '..', '..', 'core', 'guardian-core.js'),
  ];
  try {
    const manifestPath = join(plusHome, 'manifest.json');
    if (existsSync(manifestPath)) {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (m?.sourceRepoDir) {
        candidates.push(join(m.sourceRepoDir, 'core', 'guardian-core.js'));
      }
    }
  } catch {}
  for (const c of candidates) {
    if (existsSync(c)) {
      return require(c);
    }
  }
  throw new Error('未找到核心守护模块 guardian-core.js，请重新运行 cli.js install-plugin。');
}

const { SidecarApp, Response } = await loadSidecarSdk();
const guardianCore = loadGuardianCore();

const app = new SidecarApp();

let busyTask = null;
let lastAutoPreserve = null;

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function resolveSnapshot() {
  const state = guardianCore.inspectSystemState({ plusHome: getPlusHome() });
  return {
    ok: true,
    state,
    busyTask,
    lastAutoPreserve,
  };
}

// 启动后台非阻塞自动检查与旧译传承守护
setTimeout(async () => {
  try {
    const manifest = guardianCore.loadManifest(getPlusHome());
    if (manifest.autoPreserveOnClientUpdate !== false) {
      const state = guardianCore.inspectSystemState({ plusHome: getPlusHome() });
      if (state.client.found && !state.client.patched && state.client.stagedState !== 'ready' && state.runtimeReady) {
        busyTask = 'preserving';
        try {
          const res = guardianCore.ensureLegacyTranslationPreserved({ plusHome: getPlusHome() });
          lastAutoPreserve = {
            at: Date.now(),
            action: res.action,
            needsRestart: res.needsRestart,
            clientVersion: res.state?.client?.version || '',
          };
        } finally {
          busyTask = null;
        }
      }
    }
    if (manifest.autoCheckUpdates !== false) {
      await guardianCore.checkLatestRelease({ plusHome: getPlusHome(), force: false });
    }
  } catch (err) {
    console.error('[i18n_guardian] 启动自愈巡检异常:', err?.message || err);
  }
}, 600);

// 静态资源与页面路由
app.page('/', () => new Response(readFileSync(join(__dirname, 'index.html'), 'utf8'), {
  contentType: 'text/html; charset=utf-8',
  headers: NO_STORE,
}));

for (const [route, [file, contentType]] of Object.entries({
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
})) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), 'utf8'), { contentType, headers: NO_STORE }),
    'GET'
  );
}

app.api('/api/status', () => resolveSnapshot(), 'GET');

app.api('/api/check-update', async () => {
  const release = await guardianCore.checkLatestRelease({ plusHome: getPlusHome(), force: true });
  return {
    ...resolveSnapshot(),
    release,
  };
}, 'POST');

app.api('/api/preserve-legacy', async () => {
  if (busyTask) {
    return { ok: false, error: '已有任务正在执行中，请稍候…' };
  }
  busyTask = 'preserving';
  try {
    const res = guardianCore.ensureLegacyTranslationPreserved({ plusHome: getPlusHome() });
    lastAutoPreserve = {
      at: Date.now(),
      action: res.action,
      needsRestart: res.needsRestart,
      clientVersion: res.state?.client?.version || '',
    };
    return {
      ok: true,
      action: res.action,
      needsRestart: res.needsRestart,
      state: res.state,
      busyTask: null,
      lastAutoPreserve,
    };
  } catch (err) {
    return { ok: false, error: err?.message || '构建旧版兼容汉化包失败' };
  } finally {
    busyTask = null;
  }
}, 'POST');

app.api('/api/online-update', async (data = {}) => {
  if (busyTask) {
    return { ok: false, error: '已有任务正在执行中，请稍候…' };
  }
  busyTask = 'updating';
  try {
    const res = await guardianCore.applyOnlineUpdate({
      plusHome: getPlusHome(),
      mirrorPrefix: typeof data.mirrorPrefix === 'string' ? data.mirrorPrefix : undefined,
      forceRestartPrompt: true,
    });
    return {
      ok: true,
      updatedToVersion: res.updatedToVersion,
      needsRestart: res.needsRestart,
      state: res.state,
      busyTask: null,
      lastAutoPreserve,
    };
  } catch (err) {
    return { ok: false, error: err?.message || '在线更新失败' };
  } finally {
    busyTask = null;
  }
}, 'POST');

app.api('/api/request-restart', () => {
  try {
    const scheduled = guardianCore.scheduleGracefulRestart({ plusHome: getPlusHome() });
    return { ok: true, ...scheduled };
  } catch (err) {
    return { ok: false, error: err?.message || '调度重启失败' };
  }
}, 'POST');

app.api('/api/settings', (data = {}) => {
  const patch = {};
  if (typeof data.autoPreserveOnClientUpdate === 'boolean') {
    patch.autoPreserveOnClientUpdate = data.autoPreserveOnClientUpdate;
  }
  if (typeof data.autoCheckUpdates === 'boolean') {
    patch.autoCheckUpdates = data.autoCheckUpdates;
  }
  if (typeof data.mirrorPrefix === 'string') {
    patch.mirrorPrefix = data.mirrorPrefix.trim();
  }
  const manifest = guardianCore.saveManifest(patch, getPlusHome());
  return { ok: true, manifest, ...resolveSnapshot() };
}, 'POST');

app.api('/api/shortcut', (data = {}) => {
  try {
    if (data.action === 'remove') {
      const removed = guardianCore.removeSelfHealingShortcut();
      return { ok: true, ...removed, ...resolveSnapshot() };
    }
    const created = guardianCore.createSelfHealingShortcut(getPlusHome());
    return { ok: true, ...created, ...resolveSnapshot() };
  } catch (err) {
    return { ok: false, error: err?.message || '操作桌面快捷方式失败' };
  }
}, 'POST');

app.api('/api/live-cache/toggle', (data = {}) => {
  try {
    const cfgDir = join(getGeminiHome(), 'antigravity');
    const cfgPath = join(cfgDir, 'i18n-live-config.json');
    const prev = readJsonSafe(cfgPath, { enabled: true });
    const nextEnabled = typeof data.enabled === 'boolean' ? data.enabled : !(prev?.enabled !== false);
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify({ ...(prev || {}), enabled: nextEnabled }, null, 2), 'utf8');
    return { ok: true, enabled: nextEnabled, ...resolveSnapshot() };
  } catch (err) {
    return { ok: false, error: err?.message || '切换实时翻译状态失败' };
  }
}, 'POST');

app.run();

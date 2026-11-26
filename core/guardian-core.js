'use strict';

/**
 * @fileoverview Antigravity 汉化持久化守护核心 (Guardian Core)
 *
 * 负责跨客户端官方升级的三大核心机制：
 * 1. 外置持久化运行时中心 (~/.gemini/antigravity-chinese-plus/)：官方升级永不擦除；
 * 2. 官方升级自动传承旧版译文：检测 app.asar 恢复为原版后自动使用本地已有词库预注入 app.asar.staged；
 * 3. 在线新版检测、压缩包安全更新、快捷方式创建与优雅重启原子切换。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const DEFAULT_REPO_SLUG = 'mitang-ai/antigravity-chinese-plus';
const MIN_CHECK_INTERVAL_MS = 30 * 60 * 1000;

const ASAR_RUNTIME_DEPS = [
  '@electron/asar',
  'commander',
  'glob',
  'minimatch',
  'fs.realpath',
  'inflight',
  'inherits',
  'once',
  'path-is-absolute',
  'wrappy',
  'balanced-match',
  'brace-expansion',
  'concat-map'
];

/**
 * 获取持久化运行根目录（支持 AGY_PLUS_HOME 覆盖用于测试）。
 */
function getPlusHomeDir() {
  return process.env.AGY_PLUS_HOME || path.join(os.homedir(), '.gemini', 'antigravity-chinese-plus');
}

function getRuntimeDir(plusHome = getPlusHomeDir()) {
  return path.join(plusHome, 'runtime');
}

function getManifestPath(plusHome = getPlusHomeDir()) {
  return path.join(plusHome, 'manifest.json');
}

function getUpdateCachePath(plusHome = getPlusHomeDir()) {
  return path.join(plusHome, 'update-cache.json');
}

function getGeminiHomeDir() {
  return process.env.GEMINI_HOME || path.join(os.homedir(), '.gemini');
}

function getDefaultPluginTargetDir() {
  if (process.env.AGY_PLUGIN_DIR) return process.env.AGY_PLUGIN_DIR;
  return path.join(getGeminiHomeDir(), 'config', 'plugins', 'chinese-toolkit');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function copyDirRecursiveSync(srcDir, destDir, options = {}) {
  const excludeNames = new Set(options.excludeNames || ['.git', 'node_modules']);
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (excludeNames.has(entry.name)) continue;
    const srcEntry = path.join(srcDir, entry.name);
    const destEntry = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcEntry, destEntry, options);
    } else {
      fs.copyFileSync(srcEntry, destEntry);
    }
  }
}

/**
 * 轻量比较两个语义化版本号 (a > b => 1, a < b => -1, a === b => 0)。
 */
function compareSemver(a, b) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/**
 * 加载或初始化用户持久化配置清单。
 */
function loadManifest(plusHome = getPlusHomeDir()) {
  const defaults = {
    version: '0.0.0',
    repoSlug: DEFAULT_REPO_SLUG,
    autoPreserveOnClientUpdate: true,
    autoCheckUpdates: true,
    mirrorPrefix: '',
    sourceRepoDir: '',
    lastSyncedAt: 0,
    lastLegacyPreserveAt: 0,
    lastPreservedClientVersion: ''
  };
  const existing = readJsonSafe(getManifestPath(plusHome), {});
  return { ...defaults, ...(existing && typeof existing === 'object' ? existing : {}) };
}

function saveManifest(patch, plusHome = getPlusHomeDir()) {
  const next = { ...loadManifest(plusHome), ...patch };
  writeJsonAtomic(getManifestPath(plusHome), next);
  return next;
}

/**
 * 同步核心词库、运行时脚本与最小化 @electron/asar 依赖到外置持久运行中心 (~/.gemini/antigravity-chinese-plus/runtime)。
 */
function syncRuntimeFromDir(sourceDir, options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const runtimeDir = getRuntimeDir(plusHome);
  const stagingDir = path.join(plusHome, `runtime.staging.${process.pid}`);

  const srcPkg = readJsonSafe(path.join(sourceDir, 'package.json'));
  if (!srcPkg || !fs.existsSync(path.join(sourceDir, 'cli.js'))) {
    throw new Error(`源目录缺少有效运行文件: ${sourceDir}`);
  }

  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const fileName of ['package.json', 'cli.js', 'README.md']) {
      const s = path.join(sourceDir, fileName);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(stagingDir, fileName));
    }
    for (const subDir of ['core', 'dict', 'dist', 'plugins']) {
      const s = path.join(sourceDir, subDir);
      if (fs.existsSync(s)) copyDirRecursiveSync(s, path.join(stagingDir, subDir));
    }

    // 同步轻量化 @electron/asar 运行时依赖，保证脱离源码工程后仍可独立拆解与重打包 app.asar
    const srcNm = path.join(sourceDir, 'node_modules');
    const fallbackNm = path.join(runtimeDir, 'node_modules');
    const depSourceNm = fs.existsSync(path.join(srcNm, '@electron', 'asar'))
      ? srcNm
      : (fs.existsSync(path.join(fallbackNm, '@electron', 'asar')) ? fallbackNm : null);

    if (depSourceNm) {
      const destNm = path.join(stagingDir, 'node_modules');
      fs.mkdirSync(destNm, { recursive: true });
      for (const dep of ASAR_RUNTIME_DEPS) {
        const sDep = path.join(depSourceNm, dep);
        if (fs.existsSync(sDep)) {
          copyDirRecursiveSync(sDep, path.join(destNm, dep), { excludeNames: ['.git'] });
        }
      }
      const srcBin = path.join(depSourceNm, '.bin');
      if (fs.existsSync(srcBin)) {
        const destBin = path.join(destNm, '.bin');
        fs.mkdirSync(destBin, { recursive: true });
        for (const f of fs.readdirSync(srcBin)) {
          if (f.startsWith('asar')) {
            fs.copyFileSync(path.join(srcBin, f), path.join(destBin, f));
          }
        }
      }
    }

    if (fs.existsSync(runtimeDir)) fs.rmSync(runtimeDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, runtimeDir);
  } catch (err) {
    if (fs.existsSync(stagingDir)) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) {}
    }
    throw err;
  }

  const manifestPatch = {
    version: srcPkg.version || '3.6.0',
    lastSyncedAt: Date.now()
  };
  if (options.sourceRepoDir !== undefined) {
    manifestPatch.sourceRepoDir = options.sourceRepoDir;
  } else if (fs.existsSync(path.join(sourceDir, '.git'))) {
    manifestPatch.sourceRepoDir = sourceDir;
  }
  const manifest = saveManifest(manifestPatch, plusHome);
  return { runtimeDir, version: manifest.version, manifest };
}

/**
 * 同步更新全局社区中文插件，并自动在 ~/.gemini/config/config.json 中启用该插件（绝不覆盖其他用户设置）。
 */
function ensurePluginInstalledAndEnabled(sourcePluginDir, options = {}) {
  const targetPluginDir = options.pluginTargetDir || getDefaultPluginTargetDir();
  const geminiHome = options.geminiHome || getGeminiHomeDir();
  const configPath = path.join(geminiHome, 'config', 'config.json');
  const pluginFolderName = path.basename(targetPluginDir);

  if (sourcePluginDir && fs.existsSync(sourcePluginDir)) {
    const parent = path.dirname(targetPluginDir);
    fs.mkdirSync(parent, { recursive: true });
    if (fs.existsSync(targetPluginDir)) fs.rmSync(targetPluginDir, { recursive: true, force: true });
    copyDirRecursiveSync(sourcePluginDir, targetPluginDir);
  }

  const config = readJsonSafe(configPath, {});
  if (config && typeof config === 'object') {
    if (!config.plugins || typeof config.plugins !== 'object') config.plugins = {};
    const prev = (config.plugins[pluginFolderName] && typeof config.plugins[pluginFolderName] === 'object')
      ? config.plugins[pluginFolderName]
      : {};
    if (prev.enabled !== true) {
      config.plugins[pluginFolderName] = { ...prev, enabled: true };
      writeJsonAtomic(configPath, config);
    }
  }
  return { targetPluginDir, configPath, enabled: true };
}

/**
 * 直接从 app.asar 内部 package.json 读取真实客户端版本号（例如 "2.35.2"），无需解压整包。
 */
function readClientAppVersion(asarPath, options = {}) {
  if (!asarPath || !fs.existsSync(asarPath)) return null;
  const searchDirs = [
    options.runtimeDir || getRuntimeDir(),
    path.resolve(__dirname, '..')
  ];
  for (const base of searchDirs) {
    try {
      const asarModPath = path.join(base, 'node_modules', '@electron', 'asar');
      if (fs.existsSync(asarModPath)) {
        const asarLib = require(asarModPath);
        const buf = asarLib.extractFile(asarPath, 'package.json');
        const pkg = JSON.parse(buf.toString('utf8'));
        if (pkg && pkg.version) return String(pkg.version);
      }
    } catch (_) {}
  }
  try {
    const verFile = path.join(path.dirname(path.dirname(asarPath)), 'version');
    if (fs.existsSync(verFile)) return fs.readFileSync(verFile, 'utf8').trim();
  } catch (_) {}
  return null;
}

/**
 * 计算文件指纹（SHA-1 前 16 位，与 cli.js 的 getAsarFingerprint 保持严格一致）。
 */
function computeFingerprint(filePath) {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest('hex').slice(0, 16);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 综合诊断当前本机客户端、外置运行时、插件与自愈快捷方式状态。
 */
function inspectSystemState(options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const runtimeDir = getRuntimeDir(plusHome);
  const cliPath = path.join(runtimeDir, 'cli.js');
  const fallbackCliPath = path.resolve(__dirname, '..', 'cli.js');
  const cliMod = fs.existsSync(cliPath) ? require(cliPath) : require(fallbackCliPath);
  const manifest = loadManifest(plusHome);
  const updateCache = readJsonSafe(getUpdateCachePath(plusHome), null);

  const asarPath = typeof options.findAsarPath === 'function'
    ? options.findAsarPath(options.customPath)
    : cliMod.findAsarPath(options.customPath);
  const running = typeof options.isProcessRunning === 'function'
    ? options.isProcessRunning()
    : (typeof cliMod.isProcessRunning === 'function' ? cliMod.isProcessRunning() : false);

  let patched = false;
  let clientVersion = null;
  let asarFingerprint = null;
  let stagedState = 'none';
  let stagedMeta = null;
  let hasBackup = false;

  if (asarPath && fs.existsSync(asarPath)) {
    const resourcesDir = path.dirname(asarPath);
    patched = typeof options.isAsarPatched === 'function'
      ? options.isAsarPatched(asarPath)
      : cliMod.isAsarPatched(asarPath);
    clientVersion = readClientAppVersion(asarPath, { runtimeDir });
    asarFingerprint = computeFingerprint(asarPath);
    hasBackup = fs.existsSync(path.join(resourcesDir, 'app.asar.bak'));

    const stagedPath = path.join(resourcesDir, 'app.asar.staged');
    const stagedMetaPath = path.join(resourcesDir, 'app.asar.staged.meta.json');
    if (fs.existsSync(stagedPath)) {
      stagedMeta = readJsonSafe(stagedMetaPath, null);
      if (stagedMeta && stagedMeta.sourceFingerprint === asarFingerprint) {
        stagedState = 'ready';
      } else {
        stagedState = 'stale';
      }
    }
  }

  // 读取词库统计与 Google 实时翻译本地持久化缓存条数
  let exactCount = 0;
  let patternCount = 0;
  const runtimeDict = readJsonSafe(path.join(runtimeDir, 'dict', 'zh-CN.json'));
  if (runtimeDict) {
    exactCount = Object.keys(runtimeDict.exact || {}).length;
    patternCount = Array.isArray(runtimeDict.patterns) ? runtimeDict.patterns.length : 0;
  }

  let liveCacheCount = 0;
  let liveEnabled = true;
  const liveCache = readJsonSafe(path.join(getGeminiHomeDir(), 'antigravity', 'i18n-live-cache.json'));
  if (liveCache && liveCache.entries) liveCacheCount = Object.keys(liveCache.entries).length;
  const liveCfg = readJsonSafe(path.join(getGeminiHomeDir(), 'antigravity', 'i18n-live-config.json'));
  if (liveCfg && typeof liveCfg.enabled === 'boolean') liveEnabled = liveCfg.enabled;

  const runtimePkg = readJsonSafe(path.join(runtimeDir, 'package.json'));
  const currentPlusVersion = (runtimePkg && runtimePkg.version) || manifest.version || '0.0.0';
  const latestVersion = updateCache && updateCache.latestVersion ? updateCache.latestVersion : null;
  const hasOnlineUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentPlusVersion) > 0);

  return {
    plusHome,
    runtimeDir,
    runtimeReady: Boolean(runtimePkg && fs.existsSync(cliPath)),
    currentPlusVersion,
    manifest,
    client: {
      found: Boolean(asarPath),
      asarPath,
      version: clientVersion,
      fingerprint: asarFingerprint,
      running,
      patched,
      hasBackup,
      stagedState,
      stagedMeta
    },
    dictionary: {
      exactCount,
      patternCount,
      liveCacheCount,
      liveEnabled
    },
    shortcut: {
      exists: fs.existsSync(getSelfHealingShortcutPath())
    },
    onlineUpdate: {
      ...(updateCache || {}),
      hasUpdate: hasOnlineUpdate
    }
  };
}

/**
 * 联网检测 GitHub 最新 Release（带 ETag / 冷却缓存与错误优雅降级）。
 */
function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs || 12000;
  const maxRedirects = options.maxRedirects ?? 5;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'antigravity-chinese-plus-guardian',
        'Accept': 'application/vnd.github+json',
        ...(options.headers || {})
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(fetchJson(nextUrl, { ...options, maxRedirects: maxRedirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 304) {
          return resolve({ statusCode: 304, headers: res.headers, data: null });
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
        }
        try {
          resolve({ statusCode: res.statusCode, headers: res.headers, data: JSON.parse(text) });
        } catch (err) {
          reject(new Error(`JSON 解析失败: ${err.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

async function checkLatestRelease(options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const manifest = loadManifest(plusHome);
  const runtimePkg = readJsonSafe(path.join(getRuntimeDir(plusHome), 'package.json'));
  const currentVersion = (runtimePkg && runtimePkg.version) || manifest.version || '0.0.0';
  const cachePath = getUpdateCachePath(plusHome);
  const prevCache = readJsonSafe(cachePath, null);
  const now = Date.now();

  if (!options.force && prevCache && prevCache.checkedAt && (now - prevCache.checkedAt) < (options.minIntervalMs || MIN_CHECK_INTERVAL_MS)) {
    return {
      ...prevCache,
      fromCache: true,
      currentVersion,
      hasUpdate: Boolean(prevCache.latestVersion && compareSemver(prevCache.latestVersion, currentVersion) > 0)
    };
  }

  const repoSlug = options.repoSlug || manifest.repoSlug || DEFAULT_REPO_SLUG;
  const apiUrl = options.apiUrl || `https://api.github.com/repos/${repoSlug}/releases/latest`;
  const reqHeaders = {};
  if (!options.force && prevCache && prevCache.etag) {
    reqHeaders['If-None-Match'] = prevCache.etag;
  }

  try {
    const res = await fetchJson(apiUrl, { timeoutMs: options.timeoutMs || 12000, headers: reqHeaders });
    if (res.statusCode === 304 && prevCache) {
      const updated = { ...prevCache, checkedAt: now, error: null };
      writeJsonAtomic(cachePath, updated);
      return {
        ...updated,
        fromCache: true,
        currentVersion,
        hasUpdate: Boolean(updated.latestVersion && compareSemver(updated.latestVersion, currentVersion) > 0)
      };
    }
    const rel = res.data || {};
    const tag = String(rel.tag_name || '').replace(/^v/i, '');
    const record = {
      checkedAt: now,
      etag: res.headers.etag || null,
      repoSlug,
      latestVersion: tag || currentVersion,
      tagName: rel.tag_name || '',
      title: rel.name || rel.tag_name || '',
      releaseNotes: rel.body || '',
      publishedAt: rel.published_at || '',
      htmlUrl: rel.html_url || `https://github.com/${repoSlug}/releases`,
      zipballUrl: rel.zipball_url || `https://github.com/${repoSlug}/archive/refs/tags/${rel.tag_name}.zip`,
      error: null
    };
    writeJsonAtomic(cachePath, record);
    return {
      ...record,
      fromCache: false,
      currentVersion,
      hasUpdate: compareSemver(record.latestVersion, currentVersion) > 0
    };
  } catch (err) {
    const fallback = {
      ...(prevCache || {}),
      checkedAt: now,
      repoSlug,
      latestVersion: (prevCache && prevCache.latestVersion) || currentVersion,
      error: err.message
    };
    writeJsonAtomic(cachePath, fallback);
    return {
      ...fallback,
      currentVersion,
      hasUpdate: Boolean(fallback.latestVersion && compareSemver(fallback.latestVersion, currentVersion) > 0)
    };
  }
}

function downloadFileWithRedirects(url, destFile, options = {}) {
  const timeoutMs = options.timeoutMs || 45000;
  const maxRedirects = options.maxRedirects ?? 6;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': 'antigravity-chinese-plus-guardian' }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        return resolve(downloadFileWithRedirects(nextUrl, destFile, { ...options, maxRedirects: maxRedirects - 1 }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destFile);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(destFile)));
      ws.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

function extractZipArchive(zipPath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (os.platform() === 'win32') {
    try {
      execFileSync('tar.exe', ['-xf', zipPath, '-C', extractDir], { stdio: 'pipe' });
      return;
    } catch (_) {
      execFileSync('powershell', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
      ], { stdio: 'pipe' });
      return;
    }
  }
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractDir], { stdio: 'pipe' });
}

function findPackageRootInExtracted(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'package.json')) && fs.existsSync(path.join(extractDir, 'cli.js'))) {
    return extractDir;
  }
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const sub = path.join(extractDir, entry.name);
      if (fs.existsSync(path.join(sub, 'package.json')) && fs.existsSync(path.join(sub, 'cli.js'))) {
        return sub;
      }
    }
  }
  return null;
}

/**
 * 执行外置 CLI（默认以受保护预注入模式运行，绝不杀害当前正在运行的 Antigravity 宿主）。
 */
function runRuntimeInstall(plusHome = getPlusHomeDir(), customPath = null) {
  const runtimeDir = getRuntimeDir(plusHome);
  const runtimeCli = path.join(runtimeDir, 'cli.js');
  if (!fs.existsSync(runtimeCli)) {
    throw new Error('外置运行中心未就绪，请先执行一次安装或同步。');
  }
  const args = [runtimeCli, 'install'];
  if (customPath) args.push('--path', customPath);
  const env = {
    ...process.env,
    ANTIGRAVITY_AGENT: '1',
    AGY_NO_KILL: '1',
    AGY_PLUS_HOME: plusHome
  };
  const output = execFileSync(process.execPath, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  return output;
}

/**
 * 在官方客户端刚刚更新覆盖后，自动使用本地已保存的旧版汉化词库与引擎构建兼容补丁，保持旧版翻译不中断。
 */
function ensureLegacyTranslationPreserved(options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const state = inspectSystemState(options);
  if (!state.client.found) {
    return { action: 'no_client', needsRestart: false, state };
  }
  if (state.client.patched) {
    return { action: 'already_patched', needsRestart: false, state };
  }
  if (state.client.stagedState === 'ready') {
    return { action: 'staged_already_ready', needsRestart: true, state };
  }
  if (!state.runtimeReady) {
    return { action: 'runtime_missing', needsRestart: false, state };
  }

  const output = runRuntimeInstall(plusHome, options.customPath);
  const after = inspectSystemState(options);
  saveManifest({
    lastLegacyPreserveAt: Date.now(),
    lastPreservedClientVersion: after.client.version || ''
  }, plusHome);

  const needsRestart = !after.client.patched && after.client.stagedState === 'ready';
  return {
    action: after.client.patched ? 'patched_inline' : (needsRestart ? 'legacy_staged_created' : 'unknown'),
    needsRestart,
    output,
    state: after
  };
}

/**
 * 从 GitHub Release 或镜像下载新版汉化包，更新外置运行中心与插件，并预构建最新客户端补丁，准备弹窗请求重启。
 */
async function applyOnlineUpdate(options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const manifest = loadManifest(plusHome);
  const release = options.release || await checkLatestRelease({ plusHome, force: true });
  if (!release || !release.zipballUrl) {
    throw new Error('未能获取新版下载地址。');
  }

  let downloadUrl = release.zipballUrl;
  const mirror = (options.mirrorPrefix !== undefined ? options.mirrorPrefix : manifest.mirrorPrefix || '').trim();
  if (mirror && /^https?:\/\//i.test(mirror)) {
    const cleanMirror = mirror.endsWith('/') ? mirror : mirror + '/';
    if (!downloadUrl.startsWith(cleanMirror)) {
      downloadUrl = cleanMirror + downloadUrl;
    }
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plus-update-'));
  const zipPath = path.join(tempRoot, 'release.zip');
  const extractDir = path.join(tempRoot, 'extracted');

  try {
    await downloadFileWithRedirects(downloadUrl, zipPath, { timeoutMs: options.timeoutMs || 60000 });
    extractZipArchive(zipPath, extractDir);
    const pkgRoot = findPackageRootInExtracted(extractDir);
    if (!pkgRoot || !fs.existsSync(path.join(pkgRoot, 'dist', 'zh-CN.bundle.json')) ||
        !fs.existsSync(path.join(pkgRoot, 'core', 'i18n-runtime.js'))) {
      throw new Error('下载的资源包缺少关键词库或引擎文件，已拒绝应用。');
    }

    const synced = syncRuntimeFromDir(pkgRoot, { plusHome });
    const pluginSrc = path.join(pkgRoot, 'plugins', 'chinese-toolkit');
    if (fs.existsSync(pluginSrc)) {
      ensurePluginInstalledAndEnabled(pluginSrc, {
        pluginTargetDir: options.pluginTargetDir,
        geminiHome: options.geminiHome
      });
    }

    let installOutput = '';
    const beforeState = inspectSystemState(options);
    if (beforeState.client.found && !options.skipClientInstall) {
      installOutput = runRuntimeInstall(plusHome, options.customPath);
    }

    const afterState = inspectSystemState(options);
    return {
      ok: true,
      updatedToVersion: synced.version,
      needsRestart: Boolean(afterState.client.found && (afterState.client.stagedState === 'ready' || options.forceRestartPrompt)),
      installOutput,
      state: afterState
    };
  } finally {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * 优雅请求重启 Antigravity 客户端，并在原进程退出解锁瞬间原子提交 app.asar.staged。
 */
function scheduleGracefulRestart(options = {}) {
  const plusHome = options.plusHome || getPlusHomeDir();
  const runtimeDir = getRuntimeDir(plusHome);
  const runtimeCli = path.join(runtimeDir, 'cli.js');
  const state = inspectSystemState(options);
  if (!state.client.found || !state.client.asarPath) {
    throw new Error('未检测到本地 Antigravity 客户端。');
  }

  const asarPath = state.client.asarPath;
  const appExePath = path.join(path.dirname(path.dirname(asarPath)), 'Antigravity.exe');
  const helperScriptPath = path.join(os.tmpdir(), `agy-graceful-restart-${process.pid}-${Date.now()}.js`);

  const helperCode = `
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const cli = require(${JSON.stringify(runtimeCli)});
const asarPath = ${JSON.stringify(asarPath)};
const exePath = ${JSON.stringify(appExePath)};

function isRunningWin() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq Antigravity.exe" /NH', { encoding: 'utf8' });
    return out.toLowerCase().includes('antigravity.exe');
  } catch (_) {
    return false;
  }
}

try {
  if (process.platform === 'win32') {
    try {
      execSync('powershell -NoProfile -Command "Get-Process Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"', { stdio: 'ignore', windowsHide: true });
    } catch (_) {}
  }
} catch (_) {}

let ticks = 0;
const timer = setInterval(() => {
  ticks++;
  if (ticks > 180) { // 最长等待 45 秒；若用户取消退出则安全退场
    clearInterval(timer);
    try { fs.unlinkSync(__filename); } catch (_) {}
    process.exit(0);
  }
  const running = process.platform === 'win32' ? isRunningWin() : false;
  if (!running) {
    clearInterval(timer);
    setTimeout(() => {
      try {
        if (fs.existsSync(path.join(path.dirname(asarPath), 'app.asar.staged'))) {
          cli.commitStagedSwap(asarPath, { maxAttempts: 12, retryDelayMs: 250 });
        }
      } catch (_) {}
      try {
        if (fs.existsSync(exePath)) {
          const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
          child.unref();
        }
      } catch (_) {}
      try { fs.unlinkSync(__filename); } catch (_) {}
      process.exit(0);
    }, 350);
  }
}, 250);
`;

  fs.writeFileSync(helperScriptPath, helperCode, 'utf8');
  const child = spawn(process.execPath, [helperScriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  return {
    scheduled: true,
    helperScriptPath,
    asarPath,
    appExePath
  };
}

function getSelfHealingShortcutPath() {
  return path.join(os.homedir(), 'Desktop', 'Antigravity 中文自愈版.lnk');
}

/**
 * 在 Windows 桌面创建“Antigravity 中文自愈版”无黑框快捷方式（自动检测官方升级覆盖并秒级恢复旧译后启动）。
 */
function createSelfHealingShortcut(plusHome = getPlusHomeDir()) {
  if (os.platform() !== 'win32') {
    throw new Error('桌面快捷方式仅支持 Windows 平台。');
  }
  const runtimeDir = getRuntimeDir(plusHome);
  const launcherVbs = path.join(plusHome, 'launch-silent.vbs');
  const runtimeCli = path.join(runtimeDir, 'cli.js');
  const lnkPath = getSelfHealingShortcutPath();

  const vbsContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """" & "${process.execPath}" & """ """ & "${runtimeCli}" & """ launch", 0, False`
  ].join('\r\n');
  fs.mkdirSync(plusHome, { recursive: true });
  fs.writeFileSync(launcherVbs, vbsContent, 'utf8');

  const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${lnkPath.replace(/'/g, "''")}')
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"${launcherVbs.replace(/'/g, "''")}"'
$sc.WorkingDirectory = '${runtimeDir.replace(/'/g, "''")}'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\\antigravity\\Antigravity.exe'
if (Test-Path $exe) { $sc.IconLocation = "$exe,0" }
$sc.Description = '启动 Antigravity 并自动修复官方更新覆盖的中文汉化'
$sc.Save()
`;
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    stdio: 'pipe',
    windowsHide: true
  });
  return { shortcutPath: lnkPath, launcherVbs };
}

function removeSelfHealingShortcut() {
  const lnkPath = getSelfHealingShortcutPath();
  if (fs.existsSync(lnkPath)) fs.unlinkSync(lnkPath);
  return { removed: true, shortcutPath: lnkPath };
}

module.exports = {
  DEFAULT_REPO_SLUG,
  getPlusHomeDir,
  getRuntimeDir,
  getManifestPath,
  getUpdateCachePath,
  getDefaultPluginTargetDir,
  compareSemver,
  loadManifest,
  saveManifest,
  syncRuntimeFromDir,
  ensurePluginInstalledAndEnabled,
  readClientAppVersion,
  computeFingerprint,
  inspectSystemState,
  checkLatestRelease,
  applyOnlineUpdate,
  ensureLegacyTranslationPreserved,
  scheduleGracefulRestart,
  getSelfHealingShortcutPath,
  createSelfHealingShortcut,
  removeSelfHealingShortcut
};

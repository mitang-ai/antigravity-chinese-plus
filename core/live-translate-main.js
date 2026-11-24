'use strict';

/**
 * Antigravity Google 免费实时翻译与持久化缓存主进程模块
 * 运行在 Electron 主进程中，通过 net.fetch（自动继承系统代理）对接 Google 免费翻译接口，
 * 并将译文长期持久化至用户配置目录 (~/.gemini/antigravity/i18n-live-cache.json)，
 * 确保跨 Antigravity 客户端升级后已译内容与插件配置持续保留。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TARGET_LANG = 'zh-CN';
const MAX_CACHE_ENTRIES = 15000;
const BATCH_MAX_ITEMS = 12;
const BATCH_MAX_CHARS = 1600;
const COOLDOWN_MS = 30000;

function getDefaultStorageDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function normalizeSourceText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

function isTranslatableText(text) {
  if (!text || text.length < 2 || text.length > 4000) return false;
  // 必须包含至少两个连续英文字母，排除纯符号/数字/已翻译纯中文文本
  if (!/[a-zA-Z]{2,}/.test(text)) return false;
  // 若已以中文为主且极少英文，不重复送翻（保留专业术语如 "Android CLI"）
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  if (cjk >= 4 && cjk >= latin) return false;
  // 跳过纯 URL、纯路径或命令行标识
  if (/^(https?:\/\/|\/|~\/|[a-zA-Z]:\\)\S+$/.test(text)) return false;
  return true;
}

/**
 * 构建带超时的 fetch 调用，优先使用 Electron net.fetch（原生支持系统代理）
 */
async function performFetch(fetchFn, url, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, timeoutMs);
  }
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      signal: controller ? controller.signal : undefined
    });
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 通道 A：clients5.google.com（支持多 q= 参数批量返回字符串数组）
 */
async function translateBatchViaClients5(texts, targetLang, fetchFn) {
  const params = new URLSearchParams({
    client: 'dict-chrome-ex',
    sl: 'auto',
    tl: targetLang || DEFAULT_TARGET_LANG
  });
  for (const t of texts) {
    params.append('q', t);
  }
  const url = 'https://clients5.google.com/translate_a/t?' + params.toString();
  const res = await performFetch(fetchFn, url, 10000);
  if (!res || !res.ok) {
    const err = new Error('clients5 HTTP ' + (res ? res.status : 'unknown'));
    err.status = res ? res.status : 0;
    throw err;
  }
  const json = await res.json();
  // clients5 可能返回 ["译文"]，也可能在单条或嵌套时返回 [["译文", "en"]]
  if (!Array.isArray(json)) {
    if (typeof json === 'string' && texts.length === 1) return [json];
    throw new Error('clients5 unexpected payload');
  }
  if (json.length !== texts.length) {
    throw new Error(`clients5 length mismatch: ${json.length} vs ${texts.length}`);
  }
  return json.map(item => {
    if (typeof item === 'string') return item;
    if (Array.isArray(item) && typeof item[0] === 'string') return item[0];
    return '';
  });
}

/**
 * 通道 B：translate.googleapis.com 单句兜底
 */
async function translateSingleViaGtx(text, targetLang, fetchFn) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: targetLang || DEFAULT_TARGET_LANG,
    dt: 't',
    q: text
  });
  const url = 'https://translate.googleapis.com/translate_a/single?' + params.toString();
  const res = await performFetch(fetchFn, url, 10000);
  if (!res || !res.ok) {
    const err = new Error('gtx HTTP ' + (res ? res.status : 'unknown'));
    err.status = res ? res.status : 0;
    throw err;
  }
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('gtx unexpected payload');
  }
  let out = '';
  for (const seg of data[0]) {
    if (Array.isArray(seg) && typeof seg[0] === 'string') {
      out += seg[0];
    }
  }
  return out;
}

/**
 * 整理 Google 翻译返回的占位符格式，还原诸如 "⟦ 0 ⟧" 为 "⟦0⟧"
 */
function postProcessTranslatedText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/⟦\s*(\d+)\s*⟧/g, '⟦$1⟧')
    .replace(/\s+/g, ' ')
    .trim();
}

function createLiveTranslatorService(options = {}) {
  const storageDir = options.storageDir || getDefaultStorageDir();
  const cachePath = options.cachePath || path.join(storageDir, 'i18n-live-cache.json');
  const configPath = options.configPath || path.join(storageDir, 'i18n-live-config.json');
  const targetLang = options.targetLang || DEFAULT_TARGET_LANG;
  const fetchFn = options.fetchFn || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);

  let config = {
    enabled: true,
    autoTranslatePluginDetails: true,
    autoTranslateSlashCommands: true
  };
  const cacheMap = new Map();
  let saveTimer = null;
  let dirty = false;
  let cooldownUntil = 0;
  const inFlight = new Map();

  function loadFromDisk() {
    try {
      if (fs.existsSync(configPath)) {
        const parsedCfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsedCfg && typeof parsedCfg === 'object') {
          config = { ...config, ...parsedCfg };
        }
      }
    } catch (_) {}

    try {
      if (fs.existsSync(cachePath)) {
        const parsedCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const entries = parsedCache && parsedCache.entries;
        if (entries && typeof entries === 'object') {
          for (const [k, v] of Object.entries(entries)) {
            const zh = typeof v === 'string' ? v : (v && typeof v.zh === 'string' ? v.zh : '');
            if (k && zh) {
              cacheMap.set(k, { zh, ts: (v && v.ts) || Date.now() });
            }
          }
        }
      }
    } catch (_) {}
  }

  function atomicWriteJson(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp-' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  function flushCacheSync() {
    if (!dirty) return;
    dirty = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    try {
      while (cacheMap.size > MAX_CACHE_ENTRIES) {
        const oldestKey = cacheMap.keys().next().value;
        if (oldestKey === undefined) break;
        cacheMap.delete(oldestKey);
      }
      const entries = Object.create(null);
      for (const [k, v] of cacheMap.entries()) {
        entries[k] = v;
      }
      atomicWriteJson(cachePath, { version: 1, targetLang, entries });
    } catch (_) {}
  }

  function scheduleCacheSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushCacheSync();
    }, 800);
    if (saveTimer.unref) saveTimer.unref();
  }

  function saveConfigSync(nextCfg) {
    config = { ...config, ...nextCfg };
    try {
      atomicWriteJson(configPath, config);
    } catch (_) {}
    return { ...config };
  }

  function setCacheEntry(source, zh) {
    if (!source || !zh) return;
    if (cacheMap.has(source)) cacheMap.delete(source);
    cacheMap.set(source, { zh, ts: Date.now() });
    scheduleCacheSave();
  }

  async function requestGoogleBatch(batch) {
    if (!fetchFn) throw new Error('No fetch implementation available');
    try {
      const results = await translateBatchViaClients5(batch, targetLang, fetchFn);
      return results.map(postProcessTranslatedText);
    } catch (err) {
      // 如果批量接口失败/限流或长度异常，逐条用 clients5 或 gtx 尝试
      if (batch.length > 1 && err.status !== 429) {
        const out = [];
        for (const item of batch) {
          try {
            const single = await translateBatchViaClients5([item], targetLang, fetchFn);
            out.push(postProcessTranslatedText(single[0]));
          } catch (e2) {
            const gtx = await translateSingleViaGtx(item, targetLang, fetchFn);
            out.push(postProcessTranslatedText(gtx));
          }
        }
        return out;
      }
      // 通道 B 兜底
      const out = [];
      for (const item of batch) {
        const gtx = await translateSingleViaGtx(item, targetLang, fetchFn);
        out.push(postProcessTranslatedText(gtx));
      }
      return out;
    }
  }

  async function translateBatch(rawTexts) {
    const list = Array.isArray(rawTexts) ? rawTexts : [];
    const translations = Object.create(null);
    const missing = [];
    const seen = new Set();

    for (const raw of list) {
      const norm = normalizeSourceText(raw);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const cached = cacheMap.get(norm);
      if (cached && cached.zh) {
        translations[norm] = cached.zh;
      } else if (isTranslatableText(norm)) {
        missing.push(norm);
      }
    }

    if (!config.enabled || missing.length === 0) {
      return {
        translations,
        cacheCount: cacheMap.size,
        disabled: !config.enabled
      };
    }

    if (Date.now() < cooldownUntil) {
      return {
        translations,
        cacheCount: cacheMap.size,
        rateLimited: true
      };
    }

    // 区分已在并发请求中的和全新待请求的文本
    const waitPromises = [];
    const freshToFetch = [];
    for (const item of missing) {
      if (inFlight.has(item)) {
        waitPromises.push(inFlight.get(item).then(zh => {
          if (zh) translations[item] = zh;
        }).catch(() => {}));
      } else {
        freshToFetch.push(item);
      }
    }

    // 按 BATCH_MAX_ITEMS 和 BATCH_MAX_CHARS 分组
    const chunks = [];
    let currentChunk = [];
    let currentChars = 0;
    for (const item of freshToFetch) {
      if (currentChunk.length >= BATCH_MAX_ITEMS || (currentChunk.length > 0 && currentChars + item.length > BATCH_MAX_CHARS)) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChars = 0;
      }
      currentChunk.push(item);
      currentChars += item.length;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    let lastError = null;
    for (const chunk of chunks) {
      const chunkPromise = requestGoogleBatch(chunk);
      chunk.forEach((src, idx) => {
        inFlight.set(src, chunkPromise.then(arr => arr[idx] || ''));
      });
      try {
        const translatedArr = await chunkPromise;
        chunk.forEach((src, idx) => {
          const zh = translatedArr[idx];
          if (zh && zh !== src) {
            setCacheEntry(src, zh);
            translations[src] = zh;
          }
        });
      } catch (err) {
        lastError = err ? err.message : 'Translation failed';
        if (err && err.status === 429) {
          cooldownUntil = Date.now() + COOLDOWN_MS;
          break;
        }
      } finally {
        chunk.forEach(src => inFlight.delete(src));
      }
    }

    if (waitPromises.length > 0) {
      await Promise.all(waitPromises);
    }

    return {
      translations,
      cacheCount: cacheMap.size,
      error: lastError || undefined
    };
  }

  function clearCache() {
    cacheMap.clear();
    dirty = true;
    flushCacheSync();
    return { cacheCount: 0 };
  }

  function getState() {
    return {
      config: { ...config },
      stats: {
        cacheCount: cacheMap.size,
        cachePath,
        configPath
      }
    };
  }

  loadFromDisk();

  return {
    getState,
    setConfig: saveConfigSync,
    translateBatch,
    clearCache,
    flushCacheSync,
    // 暴露内部纯函数便于单元测试
    _isTranslatableText: isTranslatableText,
    _postProcessTranslatedText: postProcessTranslatedText
  };
}

let registered = false;

function registerLiveTranslateIpc(electronModule, options = {}) {
  if (registered) return null;
  const ipcMain = electronModule && electronModule.ipcMain;
  const net = electronModule && electronModule.net;
  const app = electronModule && electronModule.app;
  const BrowserWindow = electronModule && electronModule.BrowserWindow;
  if (!ipcMain) return null;
  registered = true;

  const fetchFn = options.fetchFn || (net && typeof net.fetch === 'function' ? net.fetch.bind(net) : undefined);
  const service = createLiveTranslatorService({ ...options, fetchFn });

  const localOnly = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      return handler(event, ...args);
    });
  };

  localOnly('agy-i18n:live-get-state', () => service.getState());
  localOnly('agy-i18n:live-set-config', (_event, nextCfg) => {
    const updated = service.setConfig(nextCfg && typeof nextCfg === 'object' ? nextCfg : {});
    if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.webContents.send('agy-i18n:live-config-changed', updated);
          }
        } catch (_) {}
      }
    }
    return service.getState();
  });
  localOnly('agy-i18n:live-translate-batch', (_event, payload) => {
    return service.translateBatch(payload && payload.texts);
  });
  localOnly('agy-i18n:live-clear-cache', () => service.clearCache());

  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => service.flushCacheSync());
    app.on('before-quit', () => service.flushCacheSync());
  }

  return service;
}

module.exports = {
  createLiveTranslatorService,
  registerLiveTranslateIpc,
  normalizeSourceText,
  isTranslatableText,
  postProcessTranslatedText
};

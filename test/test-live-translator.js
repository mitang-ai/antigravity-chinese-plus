const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const { createLiveTranslatorService, normalizeSourceText, postProcessTranslatedText } = require('../core/live-translate-main');
const { createLiveTranslatorController } = require('../core/live-translator');
const runtimeCode = fs.readFileSync(path.join(__dirname, '../core/i18n-runtime.js'), 'utf8');
const dictionary = require('../dict/zh-CN.json');

function waitTick(ms = 140) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await waitTick(20);
  }
}

test('Google live translator main service handles batching, fallback, and persistent cache', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy_live_cache_'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  let fetchCalls = 0;
  const mockFetch = async url => {
    fetchCalls++;
    if (url.includes('clients5.google.com')) {
      const u = new URL(url);
      const qs = u.searchParams.getAll('q');
      if (qs.some(q => q.includes('TRIGGER_GTX_FALLBACK'))) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      const mapped = qs.map(q => {
        if (q.includes('Android CLI')) return 'Android CLI 是官方命令行工具，使用 ⟦ 0 ⟧ 创建项目。';
        if (q.includes('Key Capabilities')) return '核心能力';
        return '已翻译：' + q;
      });
      return { ok: true, status: 200, json: async () => mapped };
    }
    if (url.includes('translate.googleapis.com')) {
      const u = new URL(url);
      const q = u.searchParams.get('q') || '';
      return {
        ok: true,
        status: 200,
        json: async () => [[['兜底译文：' + q, q]]]
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const svc = createLiveTranslatorService({ storageDir: tempDir, fetchFn: mockFetch });
  const r1 = await svc.translateBatch([
    'Android CLI is the official CLI using ⟦0⟧.',
    'Key Capabilities'
  ]);
  assert.equal(r1.translations['Android CLI is the official CLI using ⟦0⟧.'], 'Android CLI 是官方命令行工具，使用 ⟦0⟧ 创建项目。');
  assert.equal(r1.translations['Key Capabilities'], '核心能力');
  assert.equal(fetchCalls, 1);

  // 命中最先缓存后零网络请求
  const r2 = await svc.translateBatch(['Key Capabilities']);
  assert.equal(r2.translations['Key Capabilities'], '核心能力');
  assert.equal(fetchCalls, 1);

  // 触发 clients5 -> gtx 兜底
  const r3 = await svc.translateBatch(['TRIGGER_GTX_FALLBACK description text']);
  assert.equal(r3.translations['TRIGGER_GTX_FALLBACK description text'], '兜底译文：TRIGGER_GTX_FALLBACK description text');

  // 同步落盘并在新实例中恢复长期缓存
  svc.flushCacheSync();
  const svcReloaded = createLiveTranslatorService({ storageDir: tempDir, fetchFn: async () => { throw new Error('Should hit disk cache'); } });
  const r4 = await svcReloaded.translateBatch(['Key Capabilities']);
  assert.equal(r4.translations['Key Capabilities'], '核心能力');
  assert.equal(svcReloaded.getState().stats.cacheCount, 3);
});

test('Live translator translates plugin-detail markdown & prompts with inline code protection and leaves chat content untouched', async t => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <section data-testid="user-message-content"><div data-markdown-root><p>Untranslated user message paragraph</p></div></section>
    <div data-testid="plugin-detail">
      <p class="text-muted-foreground leading-relaxed">Official Android plugin description not in static dict.</p>
      <div data-testid="plugin-suggested-prompt-list">
        <button data-testid="plugin-suggested-prompt-row"><span class="truncate">Create a new Android project called MyFirstApp</span></button>
      </div>
      <div data-markdown-root>
        <h2>Key Capabilities</h2>
        <p>Initialize modern Android projects using <code>android create</code> quickly.</p>
        <pre><code>android create --name MyFirstApp</code></pre>
      </div>
      <footer>
        <dd data-testid="plugin-detail-footer-author">Google LLC</dd>
        <dd data-testid="plugin-detail-footer-version">1.0.0</dd>
      </footer>
    </div>
    <div role="listbox" data-mention-menu="">
      <div role="option">
        <span data-testid="menu-option-label">custom-skill</span>
        <span data-testid="menu-option-description" dir="auto"><span>Remote third-party </span><span class="font-semibold">skill</span><span> documentation.</span></span>
      </div>
      <div role="option">
        <span data-testid="menu-option-label">src/app.js</span>
        <span data-testid="menu-option-description" dir="rtl">src/components/Header.tsx</span>
      </div>
    </div>
  </body></html>`, { url: 'https://127.0.0.1/customizations/plugins/android-cli' });

  const { window } = dom;
  const mockTranslations = {
    'Official Android plugin description not in static dict.': '官方 Android 插件扩展说明。',
    'Create a new Android project called MyFirstApp': '创建一个名为 MyFirstApp 的新 Android 项目',
    'Key Capabilities': '核心功能',
    'Initialize modern Android projects using ⟦0⟧ quickly.': '使用 ⟦0⟧ 快速初始化现代 Android 项目。',
    'Remote third-party skill documentation.': '第三方远程技能说明文档。'
  };

  let sentTexts = [];
  const bridge = {
    getState: async () => ({ config: { enabled: true, autoTranslatePluginDetails: true, autoTranslateSlashCommands: true }, stats: { cacheCount: 0 } }),
    setConfig: async cfg => ({ config: cfg }),
    translateBatch: async texts => {
      sentTexts.push(...texts);
      const translations = {};
      for (const k of texts) {
        if (mockTranslations[k]) translations[k] = mockTranslations[k];
      }
      return { translations, cacheCount: Object.keys(translations).length };
    }
  };

  const prevDoc = global.document;
  const prevWin = global.window;
  const prevNF = global.NodeFilter;
  const prevMO = global.MutationObserver;
  global.document = window.document;
  global.window = window;
  global.NodeFilter = window.NodeFilter;
  global.MutationObserver = window.MutationObserver;
  t.after(() => {
    global.document = prevDoc;
    global.window = prevWin;
    global.NodeFilter = prevNF;
    global.MutationObserver = prevMO;
    dom.window.close();
  });

  // 在隔离上下文注入静态 i18n-runtime
  window.__AGY_I18N_DATA__ = dictionary;
  const ctx = vm.createContext(window);
  vm.runInContext(runtimeCode, ctx);

  // 初始化实时翻译器
  const doc = window.document;
  const ctrl = createLiveTranslatorController({ bridge, document: doc, window });
  ctrl.start();
  await waitUntil(() =>
    doc.querySelector('p.text-muted-foreground.leading-relaxed')?.textContent === '官方 Android 插件扩展说明。' &&
    doc.querySelector('[data-testid="menu-option-description"]')?.textContent === '第三方远程技能说明文档。'
  );
  // 1. 详情页内容与内嵌 <code> 保护验证
  assert.equal(doc.querySelector('p.text-muted-foreground.leading-relaxed').textContent, '官方 Android 插件扩展说明。');
  const promptRow = doc.querySelector('[data-testid="plugin-suggested-prompt-row"]');
  assert.equal(promptRow.textContent, '创建一个名为 MyFirstApp 的新 Android 项目');
  assert.equal(promptRow.getAttribute('title'), '原文：Create a new Android project called MyFirstApp');
  assert.equal(doc.querySelector('[data-testid="plugin-detail"] [data-markdown-root] h2').textContent, '核心功能');
  const mdPara = doc.querySelector('[data-testid="plugin-detail"] [data-markdown-root] p');
  assert.equal(mdPara.textContent, '使用 android create 快速初始化现代 Android 项目。');
  assert.equal(mdPara.querySelector('code').textContent, 'android create');
  assert.equal(doc.querySelector('[data-testid="plugin-detail"] pre code').textContent, 'android create --name MyFirstApp');
  assert.equal(doc.querySelector('[data-testid="plugin-detail-footer-author"]').textContent, 'Google LLC');

  // 2. 斜杠菜单第三方技能高亮拆分翻译，同时保护命令名和 dir="rtl" 文件路径
  const labels = [...doc.querySelectorAll('[data-testid="menu-option-label"]')].map(el => el.textContent);
  assert.deepEqual(labels, ['custom-skill', 'src/app.js']);
  const descs = [...doc.querySelectorAll('[data-testid="menu-option-description"]')].map(el => el.textContent);
  assert.deepEqual(descs, ['第三方远程技能说明文档。', 'src/components/Header.tsx']);

  // 3. 聊天消息区 Markdown 绝对不受任何影响（也未送给翻译接口）
  assert.equal(doc.querySelector('[data-testid="user-message-content"] p').textContent, 'Untranslated user message paragraph');
  assert.ok(!sentTexts.some(t => t.includes('Untranslated user message')));
  assert.ok(!sentTexts.some(t => t.includes('Header.tsx')));

  // 4. 一键切回原文并切回译文无损验证
  ctrl.toggleOriginal(true);
  assert.equal(promptRow.textContent, 'Create a new Android project called MyFirstApp');
  assert.equal(doc.querySelector('[data-testid="plugin-detail"] [data-markdown-root] p').textContent,
    'Initialize modern Android projects using android create quickly.');
  ctrl.toggleOriginal(false);
  assert.equal(promptRow.textContent, '创建一个名为 MyFirstApp 的新 Android 项目');
  assert.equal(doc.querySelector('[data-testid="plugin-detail"] [data-markdown-root] p').textContent,
    '使用 android create 快速初始化现代 Android 项目。');

  // 5. 悬浮控制栏位置（右下角安全区）与浅色/深色主题自适应验证
  const bar = doc.getElementById('agy-live-translate-bar');
  assert.ok(bar, '详情页悬浮控制条应挂载在 body 上');
  assert.equal(bar.style.bottom, '22px');
  assert.equal(bar.style.right, '28px');
  assert.equal(bar.style.top, '');
  // 默认浅色模式验证（白底深字）
  assert.ok(bar.style.background.includes('255, 255, 255'));
  // 切换为深色主题并验证自适应变色
  doc.documentElement.classList.add('dark');
  doc.body.style.backgroundColor = 'rgb(24, 24, 27)';
  ctrl.scanNow();
  assert.ok(bar.style.background.includes('30, 32, 38'));
  // 一键折叠与展开验证
  bar.querySelector('.agy-lt-collapse-btn').click();
  assert.equal(bar.querySelector('.agy-lt-status').style.display, 'none');
  bar.querySelector('.agy-lt-icon').click();
  assert.equal(bar.querySelector('.agy-lt-status').style.display, 'inline');
});

test('Static dictionary translates built-in slash command descriptions including search-highlighted spans', async t => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div role="listbox" data-mention-menu="">
      <div role="option">
        <span data-testid="menu-option-label">goal</span>
        <span data-testid="menu-option-description" dir="auto">Run until the specified goal is completely finished.</span>
      </div>
      <div role="option">
        <span data-testid="menu-option-label">plan</span>
        <span data-testid="menu-option-description" dir="auto"><span>Plan carefully before executing a </span><span class="text-primary">task</span><span>.</span></span>
      </div>
    </div>
  </body></html>`, { url: 'https://127.0.0.1/' });
  t.after(() => dom.window.close());

  dom.window.__AGY_I18N_DATA__ = dictionary;
  vm.runInContext(runtimeCode, vm.createContext(dom.window));
  await waitUntil(() => {
    const firstDesc = dom.window.document.querySelector('[data-testid="menu-option-description"]');
    return firstDesc && firstDesc.textContent === '持续运行直到指定目标完全达成。';
  });

  const opts = [...dom.window.document.querySelectorAll('[role="option"]')];
  assert.equal(opts[0].querySelector('[data-testid="menu-option-label"]').textContent, 'goal');
  assert.equal(opts[0].querySelector('[data-testid="menu-option-description"]').textContent, '持续运行直到指定目标完全达成。');
  assert.equal(opts[1].querySelector('[data-testid="menu-option-label"]').textContent, 'plan');
  assert.equal(opts[1].querySelector('[data-testid="menu-option-description"]').textContent, '在执行任务前仔细制定计划。');
  // 原有 span 节点仍在树内，防止 React removeChild 报错
  assert.equal(opts[1].querySelectorAll('[data-testid="menu-option-description"] span').length, 3);
});

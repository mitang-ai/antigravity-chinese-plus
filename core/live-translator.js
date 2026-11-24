/**
 * Antigravity 受控作用域 Google 实时翻译渲染器模块 (Live Translator)
 *
 * 设计原则：
 * 1. 严格作用域隔离：仅作用于插件/技能详情页 ([data-testid="plugin-detail"])、
 *    插件子项弹窗 ([data-testid="doc-row-modal"])、自定义扩展卡片、
 *    以及斜杠指令/技能下拉菜单描述 ([data-mention-menu] [dir="auto"])。
 *    绝不触碰聊天消息正文、代码块、Monaco 编辑器、终端、文件树或路径。
 * 2. 静态词典优先：凡核心引擎已译或受官方严格保护的页脚信息（作者/版本等）保持原逻辑，
 *    仅针对静态词典未收录的动态介绍、示例提示词和 Markdown 文档调用主进程 Google 免费翻译与持久化缓存。
 * 3. 无损原文切换与行内代码保护：提取行内 <code>/<kbd>/<svg> 占位符 ⟦0⟧ 保护技术语法，
 *    支持通过右上角轻量胶囊一键切换「译文 / 原文」，不改动 React 拥有的组件闭包（如点击发送的英文提示词）。
 */
(function (root) {
  'use strict';

  if (!root) {
    root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  }
  if (!root) return;

  var doc = root.document || (typeof document !== 'undefined' ? document : null);

  function resolveBridge() {
    if (root.__AGY_LIVE_TRANSLATE_BRIDGE__) return root.__AGY_LIVE_TRANSLATE_BRIDGE__;
    try {
      if (typeof require === 'function') {
        var electron = require('electron');
        if (electron && electron.ipcRenderer) {
          var ipc = electron.ipcRenderer;
          return {
            getState: function () { return ipc.invoke('agy-i18n:live-get-state'); },
            setConfig: function (cfg) { return ipc.invoke('agy-i18n:live-set-config', cfg); },
            translateBatch: function (texts) { return ipc.invoke('agy-i18n:live-translate-batch', { texts: texts }); },
            clearCache: function () { return ipc.invoke('agy-i18n:live-clear-cache'); },
            onConfigChanged: function (cb) {
              var h = function (_e, cfg) { cb(cfg); };
              ipc.on('agy-i18n:live-config-changed', h);
              return function () { ipc.removeListener('agy-i18n:live-config-changed', h); };
            }
          };
        }
      }
    } catch (_) {}
    return null;
  }

  function normalizeSpace(s) {
    return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  }

  function needsLiveTranslation(text) {
    var norm = normalizeSpace(text);
    if (!norm || norm.length < 3 || norm.length > 4000) return false;
    if (!/[a-zA-Z]{2,}/.test(norm)) return false;
    var cjk = (norm.match(/[\u4e00-\u9fa5]/g) || []).length;
    var latin = (norm.match(/[a-zA-Z]/g) || []).length;
    // 已翻为中文则无需重复请求
    if (cjk >= 4 && cjk >= latin) return false;
    if (/^(https?:\/\/|\/|~\/|[a-zA-Z]:\\)\S+$/.test(norm)) return false;
    return true;
  }

  var INLINE_TOKEN_TAGS = {
    'CODE': 1, 'KBD': 1, 'SAMP': 1, 'VAR': 1, 'IMG': 1, 'SVG': 1
  };
  var BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, summary';

  function isCodeOnlyLink(el) {
    if (!el || el.tagName !== 'A') return false;
    var text = normalizeSpace(el.textContent || '');
    if (!text) return true;
    if (el.querySelector && el.querySelector('code, kbd, svg, img')) return true;
    return /^https?:\/\/|^[\w./-]+$/.test(text);
  }

  /**
   * 序列化块级元素，将行内代码与图标抽离为 ⟦0⟧ 占位符
   */
  function extractTemplateAndTokens(el, sharedTokens) {
    var tokens = sharedTokens || [];
    var parts = [];
    var child = el.firstChild;
    while (child) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue || '');
      } else if (child.nodeType === 1) {
        if (INLINE_TOKEN_TAGS[child.tagName] || isCodeOnlyLink(child)) {
          var idx = tokens.length;
          tokens.push(child);
          parts.push('⟦' + idx + '⟧');
        } else if (child.tagName === 'BR') {
          parts.push(' ');
        } else {
          // 其他行内修饰标签（如 strong/em/普通文本 a）保留其可见文本，整体参与翻译
          var sub = extractTemplateAndTokens(child, tokens);
          parts.push(sub.template);
        }
      }
      child = child.nextSibling;
    }
    return {
      template: normalizeSpace(parts.join('')),
      tokens: tokens
    };
  }

  function applyTranslatedTemplate(el, translatedTemplate, tokens, docRef) {
    var d = docRef || doc || (typeof document !== 'undefined' ? document : null);
    var frag = d.createDocumentFragment();
    var regex = /⟦(\d+)⟧/g;
    var lastIndex = 0;
    var match;
    while ((match = regex.exec(translatedTemplate)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(d.createTextNode(translatedTemplate.slice(lastIndex, match.index)));
      }
      var tokIdx = parseInt(match[1], 10);
      if (tokens[tokIdx]) {
        frag.appendChild(tokens[tokIdx]);
      } else {
        frag.appendChild(d.createTextNode(match[0]));
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < translatedTemplate.length) {
      frag.appendChild(d.createTextNode(translatedTemplate.slice(lastIndex)));
    }
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(frag);
  }

  function createLiveTranslatorController(options) {
    var opts = options || {};
    var targetRoot = opts.window || root;
    var targetDoc = opts.document || (targetRoot && targetRoot.document) || doc || (typeof document !== 'undefined' ? document : null);
    var bridge = opts.bridge || resolveBridge();
    if (!targetDoc || !bridge) return null;

    var state = {
      enabled: true,
      autoTranslatePluginDetails: true,
      autoTranslateSlashCommands: true,
      showOriginalInDetail: false,
      collapsed: false,
      cacheCount: 0,
      pendingCount: 0,
      translatedDetailCount: 0
    };

    var memoryCache = new Map();
    var translatedValuesSet = new Set();
    var missingCache = new Set();
    var leafSnapshots = new WeakMap(); // textNode -> { source }
    var blockSnapshots = new WeakMap(); // element -> { childNodes: Node[], template, tokens }
    var titleSnapshots = new WeakMap(); // el -> hadTitle, origTitle
    var pendingRequests = new Map(); // template -> Set<targetDescriptor>
    var flushTimer = null;
    var scanTimer = null;
    var observer = null;
    var toolbarEl = null;

    function isInPluginDetailContext(el) {
      if (!el || !el.closest) return false;
      if (el.closest('[data-testid="plugin-detail"]')) return true;
      var dlg = el.closest('[role="dialog"]');
      return !!(dlg && dlg.querySelector && dlg.querySelector('[data-testid="doc-row-modal"]'));
    }

    function isExcludedInsideDetail(el) {
      if (!el || !el.closest) return true;
      if (el.closest('pre, code, kbd, samp, [data-ag-localization-skip], [data-testid="plugin-detail-footer-author"], [data-testid="plugin-detail-footer-version"], [data-testid="third-party-tools-disclaimer"]')) {
        return true;
      }
      return false;
    }

    function collectLeafTextNodes(rootEl) {
      var list = [];
      var w = targetDoc.createTreeWalker(rootEl, targetRoot.NodeFilter ? targetRoot.NodeFilter.SHOW_TEXT : 4);
      var n = w.nextNode();
      while (n) {
        list.push(n);
        n = w.nextNode();
      }
      return list;
    }

    function restoreTextLeaves(el) {
      var nodes = collectLeafTextNodes(el);
      var changed = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var snap = leafSnapshots.get(n);
        if (snap && n.nodeValue === snap.zh) {
          n.nodeValue = snap.source;
          leafSnapshots.delete(n);
          changed = true;
        }
      }
      var tSnap = titleSnapshots.get(el);
      if (tSnap && tSnap.target) {
        if (tSnap.hadTitle) tSnap.target.setAttribute('title', tSnap.origTitle);
        else tSnap.target.removeAttribute('title');
        titleSnapshots.delete(el);
      }
      return changed;
    }

    function applyTextLeavesTranslation(el, sourceText, zhText) {
      var nodes = collectLeafTextNodes(el);
      if (nodes.length === 0) return false;
      // 检查是否已经应用同一译文
      var currentJoined = normalizeSpace(nodes.map(function (n) { return n.nodeValue; }).join(''));
      if (currentJoined === zhText) return true;

      var promptRow = el.closest ? el.closest('[data-testid="plugin-suggested-prompt-row"]') : null;
      var titleTarget = promptRow || el;
      if (!titleSnapshots.has(el)) {
        titleSnapshots.set(el, {
          target: titleTarget,
          hadTitle: titleTarget.hasAttribute('title'),
          origTitle: titleTarget.getAttribute('title') || ''
        });
      }
      if (promptRow && !titleTarget.getAttribute('title')) {
        titleTarget.setAttribute('title', '原文：' + sourceText);
      }

      leafSnapshots.set(nodes[0], { source: nodes[0].nodeValue, zh: zhText });
      nodes[0].nodeValue = zhText;
      for (var i = 1; i < nodes.length; i++) {
        leafSnapshots.set(nodes[i], { source: nodes[i].nodeValue, zh: '' });
        nodes[i].nodeValue = '';
      }
      return true;
    }

    function restoreBlockElement(el) {
      var snap = blockSnapshots.get(el);
      if (!snap) return false;
      blockSnapshots.delete(el);
      while (el.firstChild) el.removeChild(el.firstChild);
      for (var i = 0; i < snap.childNodes.length; i++) {
        el.appendChild(snap.childNodes[i]);
      }
      return true;
    }

    function applyBlockTranslation(el, snap, translatedTemplate) {
      if (!translatedTemplate || translatedTemplate === snap.template) return false;
      if (!blockSnapshots.has(el)) {
        var origChildren = [];
        for (var c = el.firstChild; c; c = c.nextSibling) {
          origChildren.push(c.cloneNode(true));
        }
        blockSnapshots.set(el, {
          childNodes: origChildren,
          template: snap.template,
          tokens: snap.tokens
        });
      }
      var stored = blockSnapshots.get(el);
      // 重新从原始克隆副本提取 token 元素避免节点多次移动丢失
      var cloneHost = el.cloneNode(false);
      for (var k = 0; k < stored.childNodes.length; k++) {
        cloneHost.appendChild(stored.childNodes[k].cloneNode(true));
      }
      var fresh = extractTemplateAndTokens(cloneHost);
      applyTranslatedTemplate(el, translatedTemplate, fresh.tokens, targetDoc);
      return true;
    }

    function getSourceForLeafElement(el) {
      var nodes = collectLeafTextNodes(el);
      var combined = '';
      for (var i = 0; i < nodes.length; i++) {
        var snap = leafSnapshots.get(nodes[i]);
        combined += (snap && nodes[i].nodeValue === snap.zh) ? snap.source : nodes[i].nodeValue;
      }
      return normalizeSpace(combined);
    }

    function enqueueTranslation(template, descriptor) {
      if (!template || missingCache.has(template)) return;
      if (memoryCache.has(template)) {
        applyDescriptor(descriptor, memoryCache.get(template));
        return;
      }
      if (!pendingRequests.has(template)) {
        pendingRequests.set(template, new Set());
      }
      pendingRequests.get(template).add(descriptor);
      scheduleBatchFlush();
    }

    function applyDescriptor(desc, zh) {
      if (!zh || !desc || !desc.el || !desc.el.isConnected) return;
      translatedValuesSet.add(normalizeSpace(zh));
      if (desc.kind === 'leaf') {
        if (state.showOriginalInDetail && desc.inDetail) return;
        applyTextLeavesTranslation(desc.el, desc.source, zh);
      } else if (desc.kind === 'block') {
        if (state.showOriginalInDetail && desc.inDetail) return;
        applyBlockTranslation(desc.el, desc.snap, zh);
      }
      updateToolbar();
    }

    function scheduleBatchFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(flushBatch, 80);
    }

    function flushBatch() {
      flushTimer = null;
      if (!state.enabled || pendingRequests.size === 0) return;

      var entries = Array.from(pendingRequests.entries());
      pendingRequests.clear();
      var keys = entries.map(function (e) { return e[0]; });
      state.pendingCount += keys.length;
      updateToolbar();

      Promise.resolve()
        .then(function () { return bridge.translateBatch(keys); })
        .then(function (res) {
          state.pendingCount = Math.max(0, state.pendingCount - keys.length);
          if (res && typeof res.cacheCount === 'number') {
            state.cacheCount = res.cacheCount;
          }
          var map = (res && res.translations) || {};
          for (var i = 0; i < entries.length; i++) {
            var key = entries[i][0];
            var targets = entries[i][1];
            var zh = map[key];
            if (zh) {
              memoryCache.set(key, zh);
              translatedValuesSet.add(normalizeSpace(zh));
              targets.forEach(function (desc) { applyDescriptor(desc, zh); });
            } else if (!res || (!res.rateLimited && !res.error)) {
              missingCache.add(key);
            }
          }
          updateToolbar();
        })
        .catch(function () {
          state.pendingCount = Math.max(0, state.pendingCount - keys.length);
          updateToolbar();
        });
    }

    function handleLeafElement(el, inDetail) {
      if (!el || !el.isConnected) return;
      if (inDetail && state.showOriginalInDetail) {
        restoreTextLeaves(el);
        return;
      }
      var currentRaw = normalizeSpace(el.textContent || '');
      if (translatedValuesSet.has(currentRaw)) return;
      var source = getSourceForLeafElement(el);
      if (!needsLiveTranslation(source)) return;
      var cached = memoryCache.get(source);
      if (cached) {
        translatedValuesSet.add(normalizeSpace(cached));
        applyTextLeavesTranslation(el, source, cached);
      } else {
        enqueueTranslation(source, { kind: 'leaf', el: el, source: source, inDetail: inDetail });
      }
    }

    function handleMarkdownContainer(mdRoot, inDetail) {
      if (!mdRoot || !mdRoot.querySelectorAll) return;
      var blocks = mdRoot.querySelectorAll(BLOCK_SELECTOR);
      for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        if (isExcludedInsideDetail(block)) continue;
        // 仅处理不包含嵌套同级块元素的叶子段落/列表项文本，避免父子双重替换
        if (block.querySelector && block.querySelector('p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol, table')) {
          continue;
        }
        if (state.showOriginalInDetail) {
          restoreBlockElement(block);
          continue;
        }
        if (blockSnapshots.has(block)) continue;
        var snap = extractTemplateAndTokens(block);
        if (!needsLiveTranslation(snap.template)) continue;
        var cached = memoryCache.get(snap.template);
        if (cached) {
          applyBlockTranslation(block, snap, cached);
        } else {
          enqueueTranslation(snap.template, { kind: 'block', el: block, snap: snap, inDetail: inDetail });
        }
      }
    }

    function scanDocument() {
      if (!targetDoc || !targetDoc.body) return;
      updateToolbar();
      if (!state.enabled) return;

      // 1. 插件/技能详情页 & 技能详情弹窗（支持原文/译文开关）
      if (state.autoTranslatePluginDetails) {
        var detailContainers = targetDoc.querySelectorAll('[data-testid="plugin-detail"], [role="dialog"]');
        for (var di = 0; di < detailContainers.length; di++) {
          var container = detailContainers[di];
          if (container.getAttribute('data-testid') !== 'plugin-detail' &&
              !(container.querySelector && container.querySelector('[data-testid="doc-row-modal"]'))) {
            continue;
          }
          // 1a. 头部描述 & 弹窗简介
          var intros = container.querySelectorAll('p.text-muted-foreground.leading-relaxed:not([data-testid="third-party-tools-disclaimer"])');
          for (var ii = 0; ii < intros.length; ii++) {
            handleLeafElement(intros[ii], true);
          }
          // 1b. 示例提示词（保留点击传递英文原提示词闭包不受影响）
          var prompts = container.querySelectorAll('[data-testid="plugin-suggested-prompt-row"]');
          for (var pi = 0; pi < prompts.length; pi++) {
            var labelSpan = prompts[pi].querySelector('span.truncate') || prompts[pi];
            handleLeafElement(labelSpan, true);
          }
          // 1c. 技能/命令/智能体/规则行描述
          var rowDescs = container.querySelectorAll('[data-testid="doc-row-title"] ~ span.text-muted-foreground');
          for (var ri = 0; ri < rowDescs.length; ri++) {
            handleLeafElement(rowDescs[ri], true);
          }
          // 1d. Markdown 正文
          var mdRoots = container.querySelectorAll('[data-markdown-root]');
          for (var mi = 0; mi < mdRoots.length; mi++) {
            handleMarkdownContainer(mdRoots[mi], true);
          }
        }

        // 1e. 自定义扩展市场/已安装卡片与精选卡片中未被静态词典覆盖的英文简介
        var cardDescs = targetDoc.querySelectorAll('[data-testid="customization-card"][data-card-name] div.text-sm.text-muted-foreground.truncate, [data-testid="featured-carousel"] [role="tabpanel"] p.text-muted-foreground.line-clamp-3[title]');
        for (var ci = 0; ci < cardDescs.length; ci++) {
          handleLeafElement(cardDescs[ci], false);
        }
      }

      // 2. 聊天框斜杠指令/插件技能菜单描述 & 悬停详细卡片
      if (state.autoTranslateSlashCommands) {
        var menuDescs = targetDoc.querySelectorAll('[data-mention-menu] [data-testid="menu-option-description"][dir="auto"], [data-mention-menu] [data-testid="hover-card-description"]');
        for (var si = 0; si < menuDescs.length; si++) {
          handleLeafElement(menuDescs[si], false);
        }
      }
    }

    function scheduleScan() {
      if (scanTimer) return;
      scanTimer = setTimeout(function () {
        scanTimer = null;
        scanDocument();
      }, 60);
    }

    function countTranslatedInDetail() {
      var detail = targetDoc.querySelector('[data-testid="plugin-detail"]');
      if (!detail) return 0;
      var count = 0;
      var mdBlocks = detail.querySelectorAll(BLOCK_SELECTOR);
      for (var i = 0; i < mdBlocks.length; i++) {
        if (blockSnapshots.has(mdBlocks[i])) count++;
      }
      var leaves = detail.querySelectorAll('p.leading-relaxed, [data-testid="plugin-suggested-prompt-row"], [data-testid="doc-row-title"] ~ span.text-muted-foreground');
      for (var j = 0; j < leaves.length; j++) {
        var nodes = collectLeafTextNodes(leaves[j]);
        for (var k = 0; k < nodes.length; k++) {
          if (leafSnapshots.has(nodes[k])) { count++; break; }
        }
      }
      return count;
    }

    function detectIsDarkTheme(detailEl) {
      try {
        var win = targetDoc.defaultView || targetRoot;
        var probes = [detailEl, targetDoc.body, targetDoc.documentElement];
        if (win && typeof win.getComputedStyle === 'function') {
          for (var i = 0; i < probes.length; i++) {
            var p = probes[i];
            if (!p) continue;
            var bg = win.getComputedStyle(p).backgroundColor;
            var m = bg && bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
            if (m) {
              var alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
              if (alpha > 0.1) {
                var r = parseInt(m[1], 10);
                var g = parseInt(m[2], 10);
                var b = parseInt(m[3], 10);
                var lum = 0.299 * r + 0.587 * g + 0.114 * b;
                return lum < 128;
              }
            }
          }
        }
      } catch (_) {}
      var rootEl = targetDoc.documentElement;
      if (rootEl) {
        if (rootEl.classList && rootEl.classList.contains('dark')) return true;
        if (rootEl.getAttribute && rootEl.getAttribute('data-theme') === 'dark') return true;
      }
      if (targetRoot && targetRoot.matchMedia) {
        try { return targetRoot.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) {}
      }
      return false;
    }

    function createTranslateIconSvg(color) {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = targetDoc.createElementNS(ns, 'svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', color);
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.style.cssText = 'display:block;flex-shrink:0;';
      var paths = [
        'M5 8l6 6',
        'M4 14l6-6 2-3',
        'M2 5h12',
        'M7 2h1',
        'M22 22l-5-10-5 10',
        'M14 18h6'
      ];
      for (var i = 0; i < paths.length; i++) {
        var path = targetDoc.createElementNS(ns, 'path');
        path.setAttribute('d', paths[i]);
        svg.appendChild(path);
      }
      return svg;
    }

    function bindHoverBg(btn, getNormalBg, getHoverBg) {
      btn.addEventListener('pointerenter', function () {
        btn.style.background = getHoverBg();
      });
      btn.addEventListener('pointerleave', function () {
        btn.style.background = getNormalBg();
      });
    }

    function applyToolbarTheme(bar, isDark) {
      var palette = isDark ? {
        bg: 'rgba(30, 32, 38, 0.96)',
        border: 'rgba(255, 255, 255, 0.14)',
        shadow: '0 10px 28px rgba(0, 0, 0, 0.48), 0 2px 8px rgba(0, 0, 0, 0.28)',
        text: '#f3f4f6',
        muted: '#9ca3af',
        accent: '#8ab4f8',
        divider: 'rgba(255, 255, 255, 0.12)',
        btnBg: 'rgba(255, 255, 255, 0.08)',
        btnHover: 'rgba(255, 255, 255, 0.15)',
        btnBorder: 'rgba(255, 255, 255, 0.14)',
        btnText: '#f3f4f6',
        activeBtnBg: 'rgba(138, 180, 248, 0.18)',
        activeBtnHover: 'rgba(138, 180, 248, 0.28)',
        activeBtnText: '#93c5fd',
        activeBtnBorder: 'rgba(138, 180, 248, 0.35)',
        dotOn: '#34d399',
        dotOff: '#6b7280'
      } : {
        bg: 'rgba(255, 255, 255, 0.98)',
        border: '#e4e4e7',
        shadow: '0 8px 24px -4px rgba(15, 23, 42, 0.10), 0 2px 6px -1px rgba(15, 23, 42, 0.05)',
        text: '#1f2937',
        muted: '#6b7280',
        accent: '#1a73e8',
        divider: '#e5e7eb',
        btnBg: '#f4f4f5',
        btnHover: '#e4e4e7',
        btnBorder: '#e4e4e7',
        btnText: '#18181b',
        activeBtnBg: '#e8f0fe',
        activeBtnHover: '#d2e3fc',
        activeBtnText: '#1967d2',
        activeBtnBorder: '#bfdbfe',
        dotOn: '#10b981',
        dotOff: '#9ca3af'
      };
      bar._agyPalette = palette;
      bar.style.background = palette.bg;
      bar.style.color = palette.text;
      bar.style.border = '1px solid ' + palette.border;
      bar.style.boxShadow = palette.shadow;

      var iconBox = bar.querySelector('.agy-lt-icon');
      if (iconBox) {
        while (iconBox.firstChild) iconBox.removeChild(iconBox.firstChild);
        iconBox.appendChild(createTranslateIconSvg(state.enabled ? palette.accent : palette.muted));
      }
      var divider = bar.querySelector('.agy-lt-divider');
      if (divider) divider.style.background = palette.divider;
    }

    function ensureToolbar() {
      if (toolbarEl || !targetDoc.body) return toolbarEl;
      var bar = targetDoc.createElement('div');
      bar.id = 'agy-live-translate-bar';
      bar.setAttribute('data-ag-localization-skip', '1');
      // 固定置于详情页右下角留白安全区，绝不遮挡右上角“打开 IDE”、窗口控制或页面“添加”按钮
      bar.style.cssText = [
        'position:fixed',
        'bottom:22px',
        'right:28px',
        'z-index:9999',
        'display:none',
        'align-items:center',
        'gap:10px',
        'padding:7px 12px 7px 14px',
        'border-radius:9999px',
        'font-size:13px',
        'line-height:1.35',
        'font-weight:500',
        'font-family:system-ui, -apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif',
        '-webkit-font-smoothing:antialiased',
        'transition:background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease',
        'user-select:none'
      ].join(';');

      var iconBox = targetDoc.createElement('span');
      iconBox.className = 'agy-lt-icon';
      iconBox.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;';
      iconBox.title = '点击展开/收起翻译悬浮条';
      iconBox.addEventListener('click', function () {
        if (state.collapsed) {
          state.collapsed = false;
          updateToolbar();
        }
      });

      var statusSpan = targetDoc.createElement('span');
      statusSpan.className = 'agy-lt-status';
      statusSpan.style.cssText = 'white-space:nowrap;font-size:13px;font-weight:500;letter-spacing:0.01em;';

      var divider = targetDoc.createElement('span');
      divider.className = 'agy-lt-divider';
      divider.style.cssText = 'width:1px;height:14px;flex-shrink:0;';

      var toggleViewBtn = targetDoc.createElement('button');
      toggleViewBtn.type = 'button';
      toggleViewBtn.className = 'agy-lt-view-btn';
      toggleViewBtn.style.cssText = 'cursor:pointer;padding:4px 12px;border-radius:9999px;font-size:12.5px;font-weight:500;line-height:1.25;transition:background-color 0.15s ease, color 0.15s ease;white-space:nowrap;';
      bindHoverBg(
        toggleViewBtn,
        function () {
          var p = bar._agyPalette || {};
          return state.showOriginalInDetail ? (p.activeBtnBg || 'transparent') : (p.btnBg || 'transparent');
        },
        function () {
          var p = bar._agyPalette || {};
          return state.showOriginalInDetail ? (p.activeBtnHover || 'transparent') : (p.btnHover || 'transparent');
        }
      );
      toggleViewBtn.addEventListener('click', function () {
        state.showOriginalInDetail = !state.showOriginalInDetail;
        scanDocument();
        updateToolbar();
      });

      var autoBtn = targetDoc.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'agy-lt-auto-btn';
      autoBtn.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:9999px;border:1px solid transparent;background:transparent;font-size:12.5px;font-weight:500;line-height:1.25;transition:background-color 0.15s ease;white-space:nowrap;';
      bindHoverBg(
        autoBtn,
        function () { return 'transparent'; },
        function () { return (bar._agyPalette && bar._agyPalette.btnBg) || 'rgba(128,128,128,0.12)'; }
      );
      autoBtn.addEventListener('click', function () {
        state.enabled = !state.enabled;
        if (!state.enabled) {
          state.showOriginalInDetail = true;
        } else {
          state.showOriginalInDetail = false;
        }
        bridge.setConfig({ enabled: state.enabled }).catch(function () {});
        scanDocument();
        updateToolbar();
      });

      var autoDot = targetDoc.createElement('span');
      autoDot.className = 'agy-lt-auto-dot';
      autoDot.style.cssText = 'width:7px;height:7px;border-radius:9999px;display:inline-block;flex-shrink:0;';
      var autoLabel = targetDoc.createElement('span');
      autoLabel.className = 'agy-lt-auto-label';
      autoBtn.appendChild(autoDot);
      autoBtn.appendChild(autoLabel);

      var collapseBtn = targetDoc.createElement('button');
      collapseBtn.type = 'button';
      collapseBtn.className = 'agy-lt-collapse-btn';
      collapseBtn.textContent = '×';
      collapseBtn.title = '收起为小图标';
      collapseBtn.style.cssText = 'cursor:pointer;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border-radius:9999px;border:none;background:transparent;font-size:15px;line-height:1;transition:background-color 0.15s ease;';
      bindHoverBg(
        collapseBtn,
        function () { return 'transparent'; },
        function () { return (bar._agyPalette && bar._agyPalette.btnBg) || 'rgba(128,128,128,0.15)'; }
      );
      collapseBtn.addEventListener('click', function () {
        state.collapsed = true;
        updateToolbar();
      });

      bar.appendChild(iconBox);
      bar.appendChild(statusSpan);
      bar.appendChild(divider);
      bar.appendChild(toggleViewBtn);
      bar.appendChild(autoBtn);
      bar.appendChild(collapseBtn);
      targetDoc.body.appendChild(bar);
      toolbarEl = bar;
      return toolbarEl;
    }

    function updateToolbar() {
      var detail = targetDoc.querySelector('[data-testid="plugin-detail"]');
      if (!detail) {
        if (toolbarEl) toolbarEl.style.display = 'none';
        return;
      }
      var bar = ensureToolbar();
      if (!bar) return;
      var isDark = detectIsDarkTheme(detail);
      applyToolbarTheme(bar, isDark);
      var p = bar._agyPalette;

      bar.style.display = 'flex';
      var statusSpan = bar.querySelector('.agy-lt-status');
      var divider = bar.querySelector('.agy-lt-divider');
      var toggleViewBtn = bar.querySelector('.agy-lt-view-btn');
      var autoBtn = bar.querySelector('.agy-lt-auto-btn');
      var autoDot = bar.querySelector('.agy-lt-auto-dot');
      var autoLabel = bar.querySelector('.agy-lt-auto-label');
      var collapseBtn = bar.querySelector('.agy-lt-collapse-btn');

      if (state.collapsed) {
        bar.style.padding = '9px';
        bar.style.gap = '0px';
        statusSpan.style.display = 'none';
        divider.style.display = 'none';
        toggleViewBtn.style.display = 'none';
        autoBtn.style.display = 'none';
        collapseBtn.style.display = 'none';
        bar.title = 'Google 详情实时翻译（点击展开控制栏）';
        return;
      }

      bar.style.padding = '7px 12px 7px 14px';
      bar.style.gap = '10px';
      statusSpan.style.display = 'inline';
      divider.style.display = 'inline-block';
      autoBtn.style.display = 'inline-flex';
      collapseBtn.style.display = 'inline-flex';
      collapseBtn.style.color = p.muted;

      var cnt = countTranslatedInDetail();

      if (!state.enabled) {
        statusSpan.textContent = '详情翻译已暂停';
        statusSpan.style.color = p.muted;
        toggleViewBtn.style.display = 'none';
        autoDot.style.background = p.dotOff;
        autoLabel.textContent = '开启翻译';
        autoBtn.style.color = p.text;
      } else {
        toggleViewBtn.style.display = 'inline-block';
        statusSpan.style.color = p.text;
        if (state.pendingCount > 0) {
          statusSpan.textContent = '正在翻译 (' + state.pendingCount + ')…';
        } else if (state.showOriginalInDetail) {
          statusSpan.textContent = '当前为英文原文';
        } else {
          statusSpan.textContent = cnt > 0 ? ('已译 ' + cnt + ' 段') : '详情实时翻译';
        }
        toggleViewBtn.textContent = state.showOriginalInDetail ? '切回译文' : '查看原文';
        toggleViewBtn.style.background = state.showOriginalInDetail ? p.activeBtnBg : p.btnBg;
        toggleViewBtn.style.color = state.showOriginalInDetail ? p.activeBtnText : p.btnText;
        toggleViewBtn.style.border = '1px solid ' + (state.showOriginalInDetail ? p.activeBtnBorder : p.btnBorder);
        autoDot.style.background = p.dotOn;
        autoLabel.textContent = '自动';
        autoBtn.style.color = p.muted;
      }
      bar.title = 'Google 免费实时翻译 · 本地缓存 ' + state.cacheCount + ' 条（跨版本永久保留）';
    }

    function start() {
      bridge.getState()
        .then(function (res) {
          if (res && res.config) {
            state.enabled = res.config.enabled !== false;
            state.autoTranslatePluginDetails = res.config.autoTranslatePluginDetails !== false;
            state.autoTranslateSlashCommands = res.config.autoTranslateSlashCommands !== false;
          }
          if (res && res.stats && typeof res.stats.cacheCount === 'number') {
            state.cacheCount = res.stats.cacheCount;
          }
          scanDocument();
        })
        .catch(function () {
          scanDocument();
        });

      if (typeof bridge.onConfigChanged === 'function') {
        bridge.onConfigChanged(function (cfg) {
          if (cfg && typeof cfg.enabled === 'boolean') {
            state.enabled = cfg.enabled;
            if (state.enabled) state.showOriginalInDetail = false;
            scanDocument();
          }
        });
      }

      var MO = targetRoot.MutationObserver || (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
      if (MO && targetDoc.documentElement) {
        observer = new MO(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var mut = mutations[i];
            var t = mut.target;
            if (toolbarEl && (t === toolbarEl || (toolbarEl.contains && toolbarEl.contains(t)))) continue;
            if (mut.type === 'attributes') {
              if (t === targetDoc.documentElement || t === targetDoc.body) {
                updateToolbar();
              }
              continue;
            }
            scheduleScan();
            break;
          }
        });
        observer.observe(targetDoc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style']
        });
      }
      if (targetRoot && targetRoot.matchMedia) {
        try {
          var mq = targetRoot.matchMedia('(prefers-color-scheme: dark)');
          if (mq && mq.addEventListener) {
            mq.addEventListener('change', function () { updateToolbar(); });
          }
        } catch (_) {}
      }
      // 首次延迟扫描，确保与 i18n-runtime 静态翻译顺序协调（静态优先）
      setTimeout(scanDocument, 120);
    }

    return {
      start: start,
      scanNow: scanDocument,
      getState: function () { return Object.assign({}, state); },
      toggleOriginal: function (forceVal) {
        state.showOriginalInDetail = typeof forceVal === 'boolean' ? forceVal : !state.showOriginalInDetail;
        scanDocument();
      }
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createLiveTranslatorController: createLiveTranslatorController,
      extractTemplateAndTokens: extractTemplateAndTokens,
      needsLiveTranslation: needsLiveTranslation
    };
  }

  if (root.__AGY_LIVE_TRANSLATOR_INITIALIZED__) return;
  if (doc && resolveBridge()) {
    root.__AGY_LIVE_TRANSLATOR_INITIALIZED__ = true;
    var controller = createLiveTranslatorController();
    if (controller) {
      root.__AGY_LIVE_TRANSLATOR__ = controller;
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', function () { controller.start(); });
      } else {
        controller.start();
      }
    }
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

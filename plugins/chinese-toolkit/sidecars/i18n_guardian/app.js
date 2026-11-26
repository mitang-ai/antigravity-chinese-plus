/**
 * @fileoverview Antigravity 中文汉化守护驾驶舱交互控制器。
 * 支持自动检测宿主深浅色模式并实时切换，用通俗语言引导更新与重启。
 */

(() => {
  const $ = (id) => document.getElementById(id);

  // ==================== 1. 宿主深浅色自动探测与手动切换 ====================
  const THEME_STORAGE_KEY = 'ig-theme-mode-v1';
  const THEME_ORDER = ['auto', 'light', 'dark'];
  const THEME_LABELS = { auto: '跟随软件', light: '浅色', dark: '深色' };
  const THEME_ICONS = {
    auto: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" opacity="0.28"/></svg>',
    light: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/></svg>',
    dark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  };

  let themeMode = (() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return THEME_ORDER.includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  })();

  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 1;
  probeCanvas.height = 1;
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

  function detectHostTheme() {
    const rawBg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    if (!rawBg) {
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background)';
    document.documentElement.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();

    if (probeCtx && computed) {
      try {
        probeCtx.clearRect(0, 0, 1, 1);
        probeCtx.fillStyle = '#ffffff';
        probeCtx.fillStyle = computed;
        probeCtx.fillRect(0, 0, 1, 1);
        const [r, g, b] = probeCtx.getImageData(0, 0, 1, 1).data;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light';
      } catch {}
    }

    const nums = (computed.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3) {
      const scale = computed.startsWith('color(') ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? 'dark' : 'light';
    }
    return 'light';
  }

  function applyTheme() {
    const mode = THEME_ORDER.includes(themeMode) ? themeMode : 'auto';
    const resolved = mode === 'auto' ? detectHostTheme() : mode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolved;
    const iconEl = $('theme-icon');
    if (iconEl) iconEl.innerHTML = THEME_ICONS[mode] || THEME_ICONS.auto;
    const btn = $('btn-theme');
    if (btn) btn.title = `切换显示主题（当前：${THEME_LABELS[mode]}，点击切换）`;
  }

  applyTheme();
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'theme-change') queueMicrotask(applyTheme);
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

  // ==================== 2. 状态渲染与核心交互 ====================
  const api = {
    async request(url, method = 'GET', body) {
      const fetcher = window.sidecar?.fetch ? window.sidecar.fetch : fetch;
      const opts = { method };
      if (body !== undefined) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const res = await fetcher(url, opts);
      return res.json();
    },
  };

  let latestSnapshot = null;
  let isBusy = false;
  let toastTimer = null;

  function showToast(msg) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function setProgress(active, pct = 0, text = '') {
    const box = $('progress-box');
    const bar = $('progress-bar');
    const txt = $('progress-text');
    box.classList.toggle('hidden', !active);
    if (active) {
      bar.style.width = `${pct}%`;
      txt.textContent = text;
    }
  }

  function setBusy(busy, label = '') {
    isBusy = busy;
    $('btn-refresh').classList.toggle('spinning', busy);
    for (const id of [
      'btn-hero-primary',
      'btn-hero-secondary',
      'btn-preserve-legacy',
      'btn-force-online',
      'btn-toggle-live',
      'btn-toggle-shortcut',
    ]) {
      const el = $(id);
      if (el) el.disabled = busy;
    }
    if (busy && label) {
      $('top-subtitle').textContent = label;
    } else if (!busy && latestSnapshot) {
      const client = latestSnapshot.state?.client || {};
      $('top-subtitle').textContent = client.patched
        ? '中文化正常 · 长期自动护航中'
        : (client.stagedState === 'ready' ? '新补丁待重启生效' : '中文守护面板');
    }
  }

  function formatRelativeCheckTime(ts) {
    if (!ts) return '尚未检查';
    const diffMin = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin} 分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function simplifyNotes(raw) {
    if (!raw) return '包含最新界面翻译补全与体验优化。';
    return String(raw)
      .replace(/^###\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5)
      .join('\n');
  }

  function openRestartModal(title, message) {
    if (title) $('restart-modal-title').textContent = title;
    if (message) $('restart-modal-message').textContent = message;
    $('restart-modal').classList.remove('hidden');
  }

  function closeRestartModal() {
    $('restart-modal').classList.add('hidden');
  }

  function renderHero(state, lastAutoPreserve) {
    const heroCard = $('hero-card');
    const badge = $('hero-badge');
    const title = $('hero-title');
    const desc = $('hero-desc');
    const primary = $('btn-hero-primary');
    const secondary = $('btn-hero-secondary');
    const releaseBox = $('release-box');

    const client = state.client || {};
    const online = state.onlineUpdate || {};

    heroCard.classList.remove('tone-neutral', 'tone-good', 'tone-warn', 'tone-update');
    primary.classList.add('hidden');
    secondary.classList.add('hidden');
    releaseBox.classList.add('hidden');
    primary.onclick = null;
    secondary.onclick = null;

    if (client.stagedState === 'ready') {
      heroCard.classList.add('tone-warn');
      badge.textContent = '待重启生效';
      title.textContent = '中文界面已准备就绪，重启软件即可生效';
      desc.textContent = lastAutoPreserve?.action === 'legacy_staged_created'
        ? '检测到官方刚刚更新了软件，我们已自动把本地中文翻译套用到新版中。'
        : '新版中文补丁已经准备完成，正常关闭并重启一次 Antigravity 即可看到最新中文界面。';
      primary.textContent = '立即重启软件';
      primary.classList.remove('hidden');
      primary.onclick = () => openRestartModal();
      if (online.hasUpdate) {
        secondary.textContent = `同时先更新到新版 v${online.latestVersion}`;
        secondary.classList.remove('hidden');
        secondary.onclick = handleOnlineUpdate;
      } else {
        secondary.textContent = '检查汉化新版';
        secondary.classList.remove('hidden');
        secondary.onclick = handleCheckUpdate;
      }
      return;
    }

    if (online.hasUpdate) {
      heroCard.classList.add('tone-update');
      badge.textContent = `发现新版 v${online.latestVersion}`;
      title.textContent = `汉化包有新版 v${online.latestVersion} 可升级`;
      desc.textContent = `您当前使用的是 v${state.currentPlusVersion}。点击一键升级将自动下载更新并准备好重启切换。`;
      $('release-title').textContent = online.title || `v${online.latestVersion} 更新说明`;
      $('release-notes').textContent = simplifyNotes(online.releaseNotes);
      $('release-link').href = online.htmlUrl || '#';
      releaseBox.classList.remove('hidden');

      primary.textContent = `一键在线升级到 v${online.latestVersion}`;
      primary.classList.remove('hidden');
      primary.onclick = handleOnlineUpdate;
      return;
    }

    if (client.patched) {
      heroCard.classList.add('tone-good');
      badge.textContent = '运行正常';
      title.textContent = '中文界面已生效';
      desc.textContent = `已完整适配当前 Antigravity ${client.version || ''}，您可放心正常使用。`;
      secondary.textContent = '检查新版本';
      secondary.classList.remove('hidden');
      secondary.onclick = handleCheckUpdate;
      return;
    }

    heroCard.classList.add('tone-warn');
    badge.textContent = '尚未启用';
    title.textContent = client.found ? '当前软件界面还是英文' : '尚未检测到桌面客户端';
    desc.textContent = client.found
      ? '官方可能刚做过重装或覆盖。点击下方按钮，马上用已保存的中文词库一键恢复。'
      : '请确认已安装桌面版 Antigravity 客户端后刷新重试。';
    if (client.found) {
      primary.textContent = '一键恢复中文界面';
      primary.classList.remove('hidden');
      primary.onclick = handlePreserveLegacy;
    }
    secondary.textContent = '检查新版本';
    secondary.classList.remove('hidden');
    secondary.onclick = handleCheckUpdate;
  }

  function renderSnapshot(payload) {
    if (!payload || !payload.state) return;
    latestSnapshot = payload;
    const { state, lastAutoPreserve } = payload;
    const client = state.client || {};
    const dict = state.dictionary || {};
    const manifest = state.manifest || {};
    const online = state.onlineUpdate || {};

    $('plus-ver-badge').textContent = `v${state.currentPlusVersion || '--'}`;
    $('client-ver-chip').textContent = client.found
      ? `Antigravity ${client.version || '桌面端'}`
      : '未连接桌面端';

    if (!isBusy) {
      $('top-subtitle').textContent = client.patched
        ? '中文化正常 · 长期自动护航中'
        : (client.stagedState === 'ready' ? '新补丁待重启生效' : '中文守护面板');
    }

    renderHero(state, lastAutoPreserve);

    const checkText = formatRelativeCheckTime(online.checkedAt);
    $('check-meta').textContent = online.error
      ? `上次检查：${checkText}（网络暂时不可达，可在下方高级选项切换加速源）`
      : `上次检查：${checkText} · ${online.hasUpdate ? `最新 v${online.latestVersion}` : '当前已是最新版'}`;

    // 设置项
    $('chk-auto-preserve').checked = manifest.autoPreserveOnClientUpdate !== false;
    $('chk-auto-check').checked = manifest.autoCheckUpdates !== false;

    $('btn-toggle-live').textContent = dict.liveEnabled ? '已开启' : '已暂停';
    $('live-cache-hint').textContent = `词库未收录的插件介绍自动翻译并记住（本机已存 ${dict.liveCacheCount || 0} 条）`;

    const hasShortcut = Boolean(state.shortcut?.exists);
    $('btn-toggle-shortcut').textContent = hasShortcut ? '已添加（移除）' : '添加到桌面';
    $('shortcut-desc').textContent = hasShortcut
      ? '桌面已生成「Antigravity 中文自愈版」，双击可自动检查并补回中文后打开'
      : '从此图标打开，若官方刚升级会先 1 秒自动修复中文再启动';

    // 高级面板镜像按钮高亮
    const currentMirror = (manifest.mirrorPrefix || '').trim();
    if (document.activeElement !== $('input-mirror')) {
      $('input-mirror').value = currentMirror;
    }
    document.querySelectorAll('.preset-pill').forEach((pill) => {
      pill.classList.toggle('active', (pill.dataset.mirror || '') === currentMirror);
    });

    // 技术摘要（收纳在折叠区，不打扰日常用户）
    $('tech-summary').textContent =
      `Plus 版本：v${state.currentPlusVersion} ｜ 客户端版本：${client.version || '未知'} ｜ ` +
      `词库规模：${dict.exactCount || 0} 条精译 + ${dict.patternCount || 0} 条规则 ｜ ` +
      `外置持久目录：${state.runtimeReady ? '已就绪' : '待同步'}`;
  }

  async function refreshStatus() {
    try {
      const res = await api.request('/api/status', 'GET');
      renderSnapshot(res);
    } catch (err) {
      showToast('刷新状态失败：' + err.message);
    }
  }

  async function handleCheckUpdate() {
    setBusy(true, '正在检查汉化新版本…');
    try {
      const res = await api.request('/api/check-update', 'POST', {});
      renderSnapshot(res);
      if (res.release?.error) {
        showToast('检查失败：' + res.release.error);
      } else if (res.release?.hasUpdate) {
        showToast(`发现新版本 v${res.release.latestVersion}`);
      } else {
        showToast('当前已是最新版本');
      }
    } catch (err) {
      showToast('检查更新出错：' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreserveLegacy() {
    setBusy(true, '正在套用本地中文词库…');
    setProgress(true, 45, '正在用本机已保存的中文词库构建兼容补丁…');
    try {
      const res = await api.request('/api/preserve-legacy', 'POST', {});
      if (!res.ok) {
        showToast(res.error || '构建补丁失败');
        return;
      }
      setProgress(true, 100, '兼容补丁构建完成');
      renderSnapshot(res);
      if (res.needsRestart) {
        openRestartModal('中文补丁已准备好，是否立即重启？', '已将本地中文词库应用到当前客户端，重启一次即可变成中文界面。');
      } else {
        showToast('中文界面已恢复');
      }
    } catch (err) {
      showToast('操作失败：' + err.message);
    } finally {
      setTimeout(() => setProgress(false), 600);
      setBusy(false);
    }
  }

  async function handleOnlineUpdate() {
    setBusy(true, '正在下载并安装新版汉化…');
    setProgress(true, 30, '1/3 正在从 GitHub 下载最新汉化资源包…');
    const stepTimer = setTimeout(() => {
      if (isBusy) setProgress(true, 70, '2/3 正在更新本地词库、插件并为客户端准备补丁…');
    }, 1800);

    try {
      const res = await api.request('/api/online-update', 'POST', {
        mirrorPrefix: $('input-mirror').value.trim(),
      });
      clearTimeout(stepTimer);
      if (!res.ok) {
        setProgress(false);
        showToast('在线更新失败：' + (res.error || '请检查网络或在高级工具启用加速镜像'));
        return;
      }
      setProgress(true, 100, `3/3 已成功更新至 v${res.updatedToVersion}！`);
      renderSnapshot(res);
      showToast(`已成功升级到 v${res.updatedToVersion}`);
      if (res.needsRestart) {
        openRestartModal(
          `已升级到 v${res.updatedToVersion}，是否立即重启？`,
          '新词库和补丁都已经就绪。立即重启将安全保存当前窗口并在几秒内重新打开最新中文版 Antigravity。'
        );
      }
    } catch (err) {
      clearTimeout(stepTimer);
      setProgress(false);
      showToast('在线更新出错：' + err.message);
    } finally {
      setTimeout(() => setProgress(false), 800);
      setBusy(false);
    }
  }

  async function handleRequestRestart() {
    setBusy(true, '正在通知客户端重启…');
    try {
      const res = await api.request('/api/request-restart', 'POST', {});
      if (!res.ok) {
        showToast('未能触发重启：' + (res.error || '请手动关闭后重新打开'));
        setBusy(false);
        return;
      }
      closeRestartModal();
      showToast('正在保存退出并自动重新打开…');
    } catch (err) {
      showToast('重启请求异常：' + err.message);
      setBusy(false);
    }
  }

  async function saveSettings(patch, toastMsg = '设置已保存') {
    try {
      const res = await api.request('/api/settings', 'POST', patch);
      renderSnapshot(res);
      showToast(toastMsg);
    } catch (err) {
      showToast('保存设置失败：' + err.message);
    }
  }

  $('btn-theme').addEventListener('click', () => {
    const idx = THEME_ORDER.indexOf(themeMode);
    themeMode = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    try { localStorage.setItem(THEME_STORAGE_KEY, themeMode); } catch {}
    applyTheme();
    showToast(`显示主题：${THEME_LABELS[themeMode]}`);
  });

  $('btn-refresh').addEventListener('click', refreshStatus);
  $('btn-preserve-legacy').addEventListener('click', handlePreserveLegacy);
  $('btn-force-online').addEventListener('click', handleOnlineUpdate);
  $('btn-modal-later').addEventListener('click', closeRestartModal);
  $('btn-modal-restart').addEventListener('click', handleRequestRestart);

  $('chk-auto-preserve').addEventListener('change', (e) => {
    saveSettings({ autoPreserveOnClientUpdate: e.target.checked });
  });
  $('chk-auto-check').addEventListener('change', (e) => {
    saveSettings({ autoCheckUpdates: e.target.checked });
  });

  document.querySelectorAll('.preset-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mirror = btn.dataset.mirror || '';
      $('input-mirror').value = mirror;
      saveSettings({ mirrorPrefix: mirror }, mirror ? '已切换至加速通道' : '已切换为直连 GitHub');
    });
  });

  $('btn-save-mirror').addEventListener('click', () => {
    saveSettings({ mirrorPrefix: $('input-mirror').value.trim() }, '下载源设置已应用');
  });

  $('btn-toggle-shortcut').addEventListener('click', async () => {
    const exists = Boolean(latestSnapshot?.state?.shortcut?.exists);
    try {
      const res = await api.request('/api/shortcut', 'POST', { action: exists ? 'remove' : 'create' });
      if (res.ok) {
        renderSnapshot(res);
        showToast(exists ? '已移除桌面快捷图标' : '已添加到桌面「Antigravity 中文自愈版」');
      } else {
        showToast(res.error || '操作快捷图标失败');
      }
    } catch (err) {
      showToast('操作失败：' + err.message);
    }
  });

  $('btn-toggle-live').addEventListener('click', async () => {
    try {
      const res = await api.request('/api/live-cache/toggle', 'POST', {});
      if (res.ok) {
        renderSnapshot(res);
        showToast(res.enabled ? '已开启动态实时翻译' : '已暂停动态实时翻译');
      }
    } catch (err) {
      showToast('切换失败：' + err.message);
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 15000);
})();

/**
 * @fileoverview Antigravity 中文汉化守护驾驶舱前端控制逻辑。
 */

(() => {
  const $ = (id) => document.getElementById(id);

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

  function setBusy(isBusy, label = '') {
    const busyEl = $('busy-indicator');
    if (busyEl) {
      busyEl.classList.toggle('hidden', !isBusy);
      busyEl.textContent = label || '处理中…';
    }
    for (const id of ['btn-check-update', 'btn-online-update', 'btn-preserve-legacy', 'btn-force-reinstall-online']) {
      const btn = $(id);
      if (btn) btn.disabled = isBusy;
    }
  }

  function showFeedback(text) {
    const el = $('action-feedback');
    if (el) el.textContent = text || '';
  }

  function openRestartModal(title, message) {
    if (title) $('restart-modal-title').textContent = title;
    if (message) $('restart-modal-message').textContent = message;
    $('restart-modal').classList.remove('hidden');
  }

  function closeRestartModal() {
    $('restart-modal').classList.add('hidden');
  }

  function renderSnapshot(payload) {
    if (!payload || !payload.state) return;
    latestSnapshot = payload;
    const { state, lastAutoPreserve } = payload;
    const client = state.client || {};
    const dict = state.dictionary || {};
    const manifest = state.manifest || {};
    const online = state.onlineUpdate || {};

    $('plus-ver-badge').textContent = 'v' + (state.currentPlusVersion || '--');

    // 客户端状态
    $('client-version-val').textContent = client.found ? (client.version || '已安装') : '未检测到';
    if (!client.found) {
      $('client-patch-val').textContent = '未找到桌面客户端 app.asar';
    } else if (client.patched) {
      $('client-patch-val').textContent = '🟢 已注入中文补丁';
    } else if (client.stagedState === 'ready') {
      $('client-patch-val').textContent = '🟡 预注入已就绪（待重启生效）';
    } else if (client.stagedState === 'stale') {
      $('client-patch-val').textContent = '⚠️ 预注入已过期（官方刚更新）';
    } else {
      $('client-patch-val').textContent = '⚪ 原生英文状态';
    }

    // 顶部状态灯与摘要
    const dot = $('status-dot');
    const headline = $('status-headline');
    if (client.patched && !online.hasUpdate) {
      dot.classList.remove('warn');
      headline.textContent = '中文汉化运行正常 · 外置持久护航开启中';
    } else if (client.stagedState === 'ready') {
      dot.classList.add('warn');
      headline.textContent = '新版/兼容汉化包已预注入，重启客户端即可生效';
    } else if (online.hasUpdate) {
      dot.classList.add('warn');
      headline.textContent = `发现汉化新版 v${online.latestVersion}，可在下方一键更新`;
    } else {
      dot.classList.add('warn');
      headline.textContent = client.found ? '检测到客户端暂未应用汉化' : '运行中心就绪';
    }

    // 外置运行时与词库统计
    $('runtime-status-val').textContent = state.runtimeReady ? '🟢 已持久就绪' : '⚪ 未同步';
    $('dict-count-val').textContent = `${dict.exactCount || 0} 词条 / ${dict.patternCount || 0} 规则`;

    // 预注入状态
    const stagedMap = {
      ready: '🟡 待重启切换',
      stale: '⚠️ 已过期作废',
      none: '⚪ 无待生效包',
    };
    $('staged-state-val').textContent = stagedMap[client.stagedState] || '--';
    $('staged-detail-val').textContent = client.stagedState === 'ready'
      ? '关闭/重启后 0.5 秒自动原子替换'
      : '官方更新时自动绑定版本指纹锁';

    $('btn-open-restart-modal').classList.toggle('hidden', client.stagedState !== 'ready');

    // 实时翻译缓存
    $('live-cache-val').textContent = `${dict.liveCacheCount || 0} 条 (${dict.liveEnabled ? '已启用' : '已暂停'})`;
    $('btn-toggle-live').textContent = dict.liveEnabled ? '暂停实时翻译' : '启用实时翻译';

    // 官方升级自动传承横幅
    const showLegacyBanner = !client.patched && client.stagedState === 'ready' && lastAutoPreserve?.action === 'legacy_staged_created';
    $('legacy-banner').classList.toggle('hidden', !showLegacyBanner);

    // 在线更新横幅
    $('update-banner').classList.toggle('hidden', !online.hasUpdate);
    if (online.hasUpdate) {
      $('update-new-ver').textContent = 'v' + online.latestVersion;
      const summary = String(online.releaseNotes || online.title || '').split('\n').slice(0, 3).join(' ').trim();
      $('update-notes').textContent = summary || '包含最新界面翻译补全与安全优化。';
      $('update-release-link').href = online.htmlUrl || '#';
    }

    // 设置控件同步
    $('chk-auto-preserve').checked = manifest.autoPreserveOnClientUpdate !== false;
    $('chk-auto-check').checked = manifest.autoCheckUpdates !== false;
    if (document.activeElement !== $('input-mirror')) {
      $('input-mirror').value = manifest.mirrorPrefix || '';
    }

    const hasShortcut = Boolean(state.shortcut?.exists);
    $('btn-toggle-shortcut').textContent = hasShortcut ? '移除桌面自愈快捷方式' : '创建桌面自愈快捷方式';
    $('shortcut-desc').textContent = hasShortcut
      ? '✅ 桌面已生成「Antigravity 中文自愈版」，双击即自动检测恢复后打开。'
      : '官方静默升级后双击此图标，会在 1~2 秒内自动补回中文并直接打开。';
  }

  async function refreshStatus() {
    try {
      const res = await api.request('/api/status', 'GET');
      renderSnapshot(res);
    } catch (err) {
      showFeedback('读取状态失败: ' + err.message);
    }
  }

  async function handleCheckUpdate() {
    setBusy(true, '正在检查更新…');
    showFeedback('正在连接 GitHub 查询最新 Release…');
    try {
      const res = await api.request('/api/check-update', 'POST', {});
      renderSnapshot(res);
      if (res.release?.error) {
        showFeedback(`检查更新遇到网络问题: ${res.release.error}`);
      } else if (res.release?.hasUpdate) {
        showFeedback(`🎉 发现新版 v${res.release.latestVersion}，请点击「一键在线更新」！`);
      } else {
        showFeedback(`✅ 当前已使用最新版本 v${res.state?.currentPlusVersion || ''}`);
      }
    } catch (err) {
      showFeedback('检查更新失败: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreserveLegacy() {
    setBusy(true, '正在重建补丁…');
    showFeedback('正在使用本地持久词库为当前客户端预构建汉化包，请稍候…');
    try {
      const res = await api.request('/api/preserve-legacy', 'POST', {});
      if (!res.ok) {
        showFeedback('❌ ' + (res.error || '预构建失败'));
        return;
      }
      renderSnapshot(res);
      if (res.needsRestart) {
        showFeedback('✅ 兼容汉化包已就绪！');
        openRestartModal('兼容汉化包已预构建完成', '已成功将本地中文词库预注入当前客户端版本，是否立即重启 Antigravity 使其生效？');
      } else {
        showFeedback('✅ 当前客户端已处于汉化激活状态。');
      }
    } catch (err) {
      showFeedback('操作失败: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOnlineUpdate() {
    setBusy(true, '在线下载并构建…');
    showFeedback('正在下载 GitHub 最新版压缩包、更新外置词库并预构建客户端补丁（约需数秒）…');
    try {
      const res = await api.request('/api/online-update', 'POST', {
        mirrorPrefix: $('input-mirror').value.trim(),
      });
      if (!res.ok) {
        showFeedback('❌ 在线更新失败: ' + (res.error || '未知错误'));
        return;
      }
      renderSnapshot(res);
      showFeedback(`🎉 已成功更新至 v${res.updatedToVersion}！`);
      if (res.needsRestart) {
        openRestartModal(
          `已在线更新至 v${res.updatedToVersion}，是否立即重启？`,
          '新版汉化词库与引擎已同步至外置守护中心，并已为当前客户端预构建最新 app.asar.staged。重启客户端后立即全量生效！'
        );
      }
    } catch (err) {
      showFeedback('❌ 在线更新异常: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRequestRestart() {
    setBusy(true, '正在请求重启…');
    showFeedback('正在请求 Antigravity 优雅保存退出，退出后将自动完成切换并重开…');
    try {
      const res = await api.request('/api/request-restart', 'POST', {});
      if (!res.ok) {
        showFeedback('❌ 调度重启失败: ' + (res.error || '未知错误'));
        setBusy(false);
        return;
      }
      closeRestartModal();
      showFeedback('🔄 重启指令已发出：若出现系统退出确认，请点击确认退出，客户端将在 1 秒内自动以中文版重新打开。');
    } catch (err) {
      showFeedback('请求重启失败: ' + err.message);
      setBusy(false);
    }
  }

  async function saveSettings(patch) {
    try {
      const res = await api.request('/api/settings', 'POST', patch);
      renderSnapshot(res);
      showFeedback('✅ 守护策略已保存');
    } catch (err) {
      showFeedback('保存设置失败: ' + err.message);
    }
  }

  $('btn-refresh').addEventListener('click', refreshStatus);
  $('btn-check-update').addEventListener('click', handleCheckUpdate);
  $('btn-online-update').addEventListener('click', handleOnlineUpdate);
  $('btn-force-reinstall-online').addEventListener('click', handleOnlineUpdate);
  $('btn-preserve-legacy').addEventListener('click', handlePreserveLegacy);
  $('btn-banner-restart').addEventListener('click', () => openRestartModal());
  $('btn-open-restart-modal').addEventListener('click', () => openRestartModal());
  $('btn-modal-later').addEventListener('click', closeRestartModal);
  $('btn-modal-restart').addEventListener('click', handleRequestRestart);

  $('chk-auto-preserve').addEventListener('change', (e) => {
    saveSettings({ autoPreserveOnClientUpdate: e.target.checked });
  });
  $('chk-auto-check').addEventListener('change', (e) => {
    saveSettings({ autoCheckUpdates: e.target.checked });
  });
  $('btn-save-settings').addEventListener('click', () => {
    saveSettings({ mirrorPrefix: $('input-mirror').value.trim() });
  });

  $('btn-toggle-shortcut').addEventListener('click', async () => {
    const exists = Boolean(latestSnapshot?.state?.shortcut?.exists);
    try {
      const res = await api.request('/api/shortcut', 'POST', { action: exists ? 'remove' : 'create' });
      if (res.ok) {
        renderSnapshot(res);
        showFeedback(exists ? '已移除桌面自愈快捷方式' : '✅ 已在桌面生成「Antigravity 中文自愈版」快捷方式');
      } else {
        showFeedback('❌ ' + (res.error || '操作失败'));
      }
    } catch (err) {
      showFeedback('操作快捷方式失败: ' + err.message);
    }
  });

  $('btn-toggle-live').addEventListener('click', async () => {
    try {
      const res = await api.request('/api/live-cache/toggle', 'POST', {});
      if (res.ok) {
        renderSnapshot(res);
        showFeedback(res.enabled ? '✅ Google 实时翻译已开启' : '⏸️ 已暂停 Google 实时翻译');
      }
    } catch (err) {
      showFeedback('切换失败: ' + err.message);
    }
  });

  refreshStatus();
  setInterval(refreshStatus, 12000);
})();

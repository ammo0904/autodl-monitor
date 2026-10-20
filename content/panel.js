/*
 * AutoDL 主機 GPU 監控 — 頁內面板（content script）
 * ---------------------------------------------------------------
 * 這個檔案只做三件事：
 *   1. 把 AutoDL 頁面自己的登入權杖交給擴充套件（只送到 AutoDL 的介面）
 *   2. 在頁面右下角顯示一個即時面板（資料來自背景輪詢，不需要刷新頁面）
 *   3. 在算力市場的主機卡片上加一顆「＋監控」按鈕，方便用主機名稱訂閱
 *
 * ⚠️ 這裡刻意「完全不」呼叫 location.reload()：
 *    監控是靠背景呼叫 AutoDL 介面取得最新空閒數，頁面本身永遠不用重載。
 */
(() => {
  'use strict';

  const S = window.AdlShared;
  const PANEL_ID = 'adl-monitor-panel';
  const COLLAPSE_KEY = 'panelCollapsed';

  let collapsed = false;
  let lastAuthSignature = '';
  let renderQueued = false;

  /* ------------------------------------------------ 1. 登入資訊橋接 */

  function readLocalAuth() {
    try {
      const token = window.localStorage.getItem('token') || '';
      if (!token) return null;
      let subName = '';
      let userName = '';
      try {
        const user = JSON.parse(window.localStorage.getItem('user') || '{}');
        subName = user.sub_name || '';
        userName = user.name || user.phone || '';
      } catch (_error) { /* 未登入或欄位不同 */ }
      let appVersion = '0.0.0';
      try {
        appVersion = JSON.parse(window.localStorage.getItem('app_version') || '{}').version || appVersion;
      } catch (_error) { /* 版本非必要 */ }
      return { token, subName, userName, appVersion };
    } catch (_error) {
      return null;
    }
  }

  async function syncAuth() {
    const auth = readLocalAuth();
    if (!auth || !auth.token) return;
    const signature = `${auth.token.slice(-12)}|${auth.subName}|${auth.appVersion}`;
    if (signature === lastAuthSignature) return;
    lastAuthSignature = signature;
    try {
      await chrome.runtime.sendMessage({ type: 'ADL_REGISTER_AUTH', auth });
    } catch (_error) { /* 擴充套件重新載入時會失敗，下一輪再試 */ }
  }

  /* ---------------------------------------------------- 2. 頁內面板 */

  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function stateBadge(result) {
    if (result.state === 'available') return { cls: 'adl-ok', text: `空閒 ${result.idle} 卡` };
    if (result.state === 'notfound') return { cls: 'adl-bad', text: '找不到此主機' };
    return { cls: 'adl-warn', text: `無空閒（需 ${result.required} 卡）` };
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="adl-head">
        <span class="adl-dot"></span>
        <span class="adl-head-title">AutoDL 主機監控</span>
        <span class="adl-head-time"></span>
        <button class="adl-fold" type="button" title="收合 / 展開">−</button>
      </div>
      <div class="adl-alert" hidden>
        <span class="adl-alert-text"></span>
        <span class="adl-alert-actions">
          <button type="button" data-act="open">前往租用</button>
          <button type="button" data-act="stop">停止提醒</button>
        </span>
      </div>
      <div class="adl-body">
        <div class="adl-summary"></div>
        <div class="adl-targets"></div>
        <div class="adl-actions">
          <button type="button" data-act="scan">立即檢查</button>
          <button type="button" data-act="popup">開啟設定</button>
          <button type="button" data-act="mute">靜音切換</button>
        </div>
        <div class="adl-note">資料由 AutoDL 介面直接取得，本頁不會被重新載入。</div>
      </div>`;
    document.documentElement.appendChild(panel);

    panel.querySelector('.adl-fold').addEventListener('click', () => {
      collapsed = !collapsed;
      panel.classList.toggle('adl-collapsed', collapsed);
      panel.querySelector('.adl-fold').textContent = collapsed ? '+' : '−';
      chrome.storage.local.set({ [COLLAPSE_KEY]: collapsed });
    });

    panel.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const act = button.dataset.act;
      if (act === 'scan') {
        button.disabled = true;
        button.textContent = '檢查中…';
        try { await chrome.runtime.sendMessage({ type: 'ADL_SCAN_NOW' }); } catch (_error) { /* 忽略 */ }
        button.disabled = false;
        button.textContent = '立即檢查';
        render(true);
      }
      if (act === 'popup') {
        try { await chrome.runtime.sendMessage({ type: 'ADL_OPEN_POPUP' }); } catch (_error) { /* 舊版 Chrome 沒有 openPopup */ }
      }
      if (act === 'stop') {
        await chrome.runtime.sendMessage({ type: 'ADL_DISMISS_ALERT' });
      }
      if (act === 'open') {
        await chrome.runtime.sendMessage({ type: 'ADL_OPEN_AUTODL' });
      }
      if (act === 'mute') {
        const stored = await chrome.storage.local.get('settings');
        const muted = Boolean(stored.settings && stored.settings.alarm && stored.settings.alarm.muted);
        await chrome.runtime.sendMessage({ type: 'ADL_SET_MUTED', muted: !muted });
        render(true);
      }
    });
    return panel;
  }

  async function render(force) {
    if (!document.documentElement) return;
    const panel = ensurePanel();
    if (force !== true && renderQueued) return;
    renderQueued = true;
    let state;
    try {
      state = await chrome.runtime.sendMessage({ type: 'ADL_GET_STATE' });
    } catch (_error) {
      return;
    } finally {
      setTimeout(() => { renderQueued = false; }, 250);
    }
    if (!state || !state.ok || !panel.isConnected) return;

    const { settings, status, auth, activeAlert } = state;
    const targets = (settings && settings.targets) || [];
    const results = (status && status.results) || [];
    const byId = new Map(results.map((item) => [item.id, item]));

    panel.classList.toggle('adl-collapsed', collapsed);
    panel.querySelector('.adl-fold').textContent = collapsed ? '+' : '−';
    panel.querySelector('.adl-head-time').textContent = status && status.at ? S.relativeTimeText(status.at) : '尚未檢查';

    const alertBox = panel.querySelector('.adl-alert');
    if (activeAlert && activeAlert.items && activeAlert.items.length) {
      alertBox.hidden = false;
      alertBox.querySelector('.adl-alert-text').textContent =
        `🔔 ${activeAlert.items.map((item) => `${item.label}（空閒 ${item.idle} 卡）`).join('、')}`;
    } else {
      alertBox.hidden = true;
    }

    const available = results.filter((item) => item.state === 'available');
    const health = !settings || settings.enabled !== false ? null : 'paused';
    const summaryParts = [];
    if (health === 'paused') summaryParts.push('<span class="adl-warn">已暫停監控</span>');
    else if (status && status.needsLogin) summaryParts.push('<span class="adl-bad">未取得 AutoDL 登入狀態</span>');
    else if (!auth || !auth.hasToken) summaryParts.push('<span class="adl-bad">尚未取得登入狀態</span>');
    else summaryParts.push('<span class="adl-ok">監控中</span>');
    summaryParts.push(`監控 ${targets.length} 台`);
    if (status) {
      summaryParts.push(`主機庫 ${status.machinesCount || 0} 台`);
      if (status.truncated) summaryParts.push('<span class="adl-warn">已達頁數上限</span>');
      if (status.errors && status.errors.length) summaryParts.push(`<span class="adl-bad">${escapeHtml(status.errors[0])}</span>`);
    }
    if (available.length) summaryParts.push(`<span class="adl-ok">${available.length} 台有空閒</span>`);
    panel.querySelector('.adl-summary').innerHTML = summaryParts.join(' · ');

    const container = panel.querySelector('.adl-targets');
    if (targets.length === 0) {
      container.innerHTML = '<div class="adl-empty">還沒有監控任何主機。<br>到算力市場的主機卡片按「＋監控」，或用擴充套件圖示開啟設定新增。</div>';
    } else {
      container.innerHTML = targets.map((target) => {
        const result = byId.get(target.id);
        const badge = result ? stateBadge(result) : { cls: 'adl-warn', text: '等待檢查' };
        const matched = result && result.matches && result.matches[0];
        const detail = matched
          ? `${escapeHtml(matched.gpuName || '')} · 空閒 ${matched.idle}/${matched.total}${matched.offline ? ' · 已租完' : ''}`
          : '';
        return `<div class="adl-item">
          <div class="adl-item-main">
            <span class="adl-item-name" title="${escapeHtml(target.query)}">${escapeHtml(target.label || target.query)}</span>
            <span class="adl-item-detail">${detail}</span>
          </div>
          <span class="adl-badge ${badge.cls}">${escapeHtml(badge.text)}</span>
        </div>`;
      }).join('');
    }

    const muted = Boolean(settings && settings.alarm && settings.alarm.muted);
    const muteButton = panel.querySelector('[data-act="mute"]');
    muteButton.textContent = muted ? '取消靜音' : '靜音';
    const interval = settings ? Math.round((settings.intervalSeconds || 60)) : 60;
    panel.querySelector('.adl-note').textContent =
      `每 ${interval} 秒自動向 AutoDL 介面更新一次，本頁不會被重新載入。`;
  }

  /* ------------------------------------------- 3. 市場卡片「＋監控」 */

  function decorateMarketCards() {
    let listItems;
    try {
      listItems = document.querySelectorAll('.list-item');
    } catch (_error) {
      return;
    }
    for (const item of listItems) {
      if (item.querySelector('.adl-add-host')) continue;
      const aliasEl = item.querySelector('.machine-alias');
      if (!aliasEl) continue;
      const idEl = aliasEl.querySelector('.machine-id');
      const machineId = idEl ? idEl.textContent.trim() : '';
      let name = aliasEl.textContent.replace(machineId, '').replace(/\s+/g, ' ').trim();
      name = name.replace(/\s*可租用至.*$/, '').trim();
      if (!name) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'adl-add-host';
      button.textContent = '＋監控';
      button.title = `把「${name}」加入監控清單`;
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.textContent = '加入中…';
        try {
          const response = await chrome.runtime.sendMessage({ type: 'ADL_ADD_TARGET', query: name, label: name });
          if (response && response.ok) {
            button.textContent = '✓ 監控中';
            button.classList.add('adl-added');
          } else {
            button.textContent = '已在清單';
          }
        } catch (_error) {
          button.disabled = false;
          button.textContent = '＋監控';
        }
      });
      item.appendChild(button);
    }
  }

  /* ------------------------------------------------------- 啟動流程 */

  async function boot() {
    const stored = await chrome.storage.local.get(COLLAPSE_KEY);
    collapsed = Boolean(stored[COLLAPSE_KEY]);
    if (document.body) {
      render();
      decorateMarketCards();
    } else {
      document.addEventListener('DOMContentLoaded', () => { render(); decorateMarketCards(); }, { once: true });
    }

    await syncAuth();

    // 頁面自己會換頁／重繪，用 observer 補回面板與「＋監控」按鈕。
    // 只理會「面板以外」的變動，否則我們自己更新面板會不斷觸發 observer（自我循環）。
    let observerTimer = null;
    const observer = new MutationObserver((records) => {
      const panel = document.getElementById(PANEL_ID);
      const relevant = records.some((record) => !panel || !panel.contains(record.target));
      if (!relevant) return;
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        try {
          render();
          decorateMarketCards();
        } catch (_error) { /* 網頁改版時不要讓它壞掉 */ }
      }, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 登入狀態每 30 秒對一次（重新登入後權杖會變）
    setInterval(syncAuth, 30000);

    // 頁面開著時，順便請背景確認「該不該更新了」——這是免刷新更新的來源之一
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      try {
        const pending = chrome.runtime.sendMessage({ type: 'ADL_MAYBE_SCAN' });
        if (pending && typeof pending.catch === 'function') pending.catch(() => { /* 擴充套件重新載入中 */ });
      } catch (_error) { /* 擴充套件被停用或重新載入 */ }
    }, 15000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.status || changes.activeAlert || changes.settings) render(true);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'ADL_REFRESH_UI') render(true);
  });

  boot().catch((error) => console.warn('[AutoDL 主機監控] 頁內面板啟動失敗：', error));
})();

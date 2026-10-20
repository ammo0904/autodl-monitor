/*
 * AutoDL 主機 GPU 監控 — popup 邏輯
 * 分頁：監控清單 / 主機庫（含分頁瀏覽）/ 設定 / 診斷
 */
(() => {
  'use strict';

  const S = window.AdlShared;
  const state = { settings: null, status: null, auth: null, machines: [], machinesAt: 0, meta: { gpuTypes: [], regions: [] }, activeAlert: null };
  const lib = { page: 1, pageSize: 50, search: '', onlyIdle: false };
  let rescanTimer = null;

  /* ------------------------------------------------------------ 工具 */

  const $ = (id) => document.getElementById(id);
  const send = (message) => chrome.runtime.sendMessage(message).catch((error) => {
    console.warn('[AutoDL 主機監控] 訊息失敗：', message && message.type, error);
    return null;
  });

  const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let toastTimer = null;
  function toast(text) {
    let node = document.querySelector('.toast');
    if (!node) {
      node = document.createElement('div');
      node.className = 'toast';
      document.body.appendChild(node);
    }
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
  }

  function getPath(object, path) {
    return path.split('.').reduce((accumulator, key) => (accumulator == null ? accumulator : accumulator[key]), object);
  }

  function setPath(object, path, value) {
    const parts = path.split('.');
    let cursor = object;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (typeof cursor[parts[index]] !== 'object' || cursor[parts[index]] === null) cursor[parts[index]] = {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
    return object;
  }

  function badgeFor(result) {
    if (!result) return { cls: 'mute', text: '等待檢查' };
    if (result.state === 'available') return { cls: 'ok', text: `空閒 ${result.idle} 卡` };
    if (result.state === 'notfound') return { cls: 'bad', text: '找不到' };
    return { cls: 'warn', text: `無空閒 · 需 ${result.required}` };
  }

  /* ------------------------------------------------------------ 載入 */

  async function load(scan) {
    const response = await send({ type: 'ADL_GET_STATE' });
    if (response && response.ok) {
      state.settings = response.settings;
      state.status = response.status;
      state.auth = response.auth;
      state.activeAlert = response.activeAlert;
      state.meta = response.meta || state.meta;
      const machines = await send({ type: 'ADL_GET_MACHINES' });
      if (machines && machines.ok) {
        state.machines = machines.machines || [];
        state.machinesAt = machines.at || 0;
      }
    }
    renderAll();
    if (scan) {
      const result = await send({ type: 'ADL_MAYBE_SCAN' });
      if (result && result.status && result.status.at) {
        state.status = result.status;
        const machines = await send({ type: 'ADL_GET_MACHINES' });
        if (machines && machines.ok) {
          state.machines = machines.machines || [];
          state.machinesAt = machines.at || 0;
        }
        renderAll();
      }
    }
  }

  async function reloadMachines() {
    const machines = await send({ type: 'ADL_GET_MACHINES' });
    if (machines && machines.ok) {
      state.machines = machines.machines || [];
      state.machinesAt = machines.at || 0;
    }
  }

  /* --------------------------------------------------------- 畫面渲染 */

  function renderAll() {
    renderHeader();
    renderWatch();
    renderLibrary();
    renderSettings();
    renderDiagnostics();
  }

  function renderHeader() {
    const settings = state.settings || {};
    const status = state.status || {};
    const available = ((status.results) || []).filter((item) => item.state === 'available');
    const parts = [];
    if (settings.enabled === false) parts.push('已暫停監控');
    else if (status.needsLogin || (state.auth && !state.auth.hasToken)) parts.push('尚未取得登入狀態');
    else parts.push('背景監控中');
    parts.push(`上次檢查 ${status.at ? S.relativeTimeText(status.at) : '尚未'}`);
    if (status.machinesCount) parts.push(`主機庫 ${status.machinesCount} 台`);
    $('statusLine').textContent = parts.join(' · ');
    $('headAlert').hidden = available.length === 0;
    if (available.length) $('headAlert').textContent = `${available.length} 台有空閒`;

    const alertBox = $('alertBox');
    if (state.activeAlert && state.activeAlert.items && state.activeAlert.items.length) {
      alertBox.hidden = false;
      $('alertText').textContent = state.activeAlert.items
        .map((item) => `${item.label}：空閒 ${item.idle} 卡（需要 ${item.required} 卡）`)
        .join('\n');
    } else {
      alertBox.hidden = true;
    }

    const needsAuth = Boolean(status.needsLogin || (state.auth && !state.auth.hasToken));
    const hint = $('watchHint');
    if (needsAuth) {
      hint.innerHTML = '尚未取得 AutoDL 登入狀態：請先登入 AutoDL，或按「診斷」分頁的<b>重新取得登入狀態</b>。';
    } else if (status.truncated) {
      hint.textContent = `已達「最大頁數」上限（抓到 ${status.machinesCount} 台），可能有主機沒被涵蓋；可縮小篩選或調高最大頁數。`;
    } else if (status.errors && status.errors.length) {
      hint.textContent = `注意：${status.errors[0]}`;
    } else {
      hint.textContent = '';
    }
  }

  function renderWatch() {
    const targets = (state.settings && state.settings.targets) || [];
    const results = (state.status && state.status.results) || [];
    const byId = new Map(results.map((item) => [item.id, item]));
    const container = $('watchList');

    if (targets.length === 0) {
      container.innerHTML = '<div class="empty">還沒有監控任何主機。<br>輸入主機名稱，或到「主機庫」挑一台。</div>';
      return;
    }

    container.innerHTML = targets.map((target) => {
      const result = byId.get(target.id);
      const badge = badgeFor(result);
      const matched = result && result.matches && result.matches[0];
      const sub = matched
        ? `${escapeHtml(matched.gpuName || '')} · 空閒 ${matched.idle}/${matched.total}${matched.offline ? ' · 已租完' : ''}${S.formatPrice(matched.price) !== '—' ? ` · ${S.formatPrice(matched.price)}` : ''}`
        : (result && result.state === 'notfound'
          ? 'AutoDL 目前的主機清單找不到這台（名稱可能改了，或已被過濾條件排除）'
          : (target.query || ''));
      return `<div class="item" data-id="${escapeHtml(target.id)}">
        <div class="item-main">
          <div class="item-name" title="${escapeHtml(target.query)}">${escapeHtml(target.label || target.query)}</div>
          <div class="item-sub">${sub}</div>
        </div>
        <span class="badge ${badge.cls}">${escapeHtml(badge.text)}</span>
        <div class="item-actions">
          <input type="number" min="1" max="8" value="${Number(target.required) || 1}" data-act="required" title="需要幾張空閒卡">
          <button type="button" data-act="remove">移除</button>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.item').forEach((node) => {
      const id = node.dataset.id;
      node.querySelector('[data-act="remove"]').addEventListener('click', async () => {
        await send({ type: 'ADL_REMOVE_TARGET', id });
        state.settings.targets = (state.settings.targets || []).filter((target) => target.id !== id);
        renderAll();
        toast('已移除監控');
      });
      node.querySelector('[data-act="required"]').addEventListener('change', async (event) => {
        const required = Math.max(1, Math.min(8, Number(event.target.value) || 1));
        event.target.value = required;
        await send({ type: 'ADL_UPDATE_TARGET', id, patch: { required } });
        const target = (state.settings.targets || []).find((item) => item.id === id);
        if (target) target.required = required;
        toast(`需求改為 ${required} 卡`);
        scheduleRescan();
      });
    });
  }

  function libraryRows() {
    let rows = (state.machines || []).slice();
    if (lib.onlyIdle) rows = rows.filter((machine) => S.effectiveIdle(machine) > 0);
    const keyword = lib.search.trim().toLowerCase();
    if (keyword) {
      rows = rows.filter((machine) => `${machine.name} ${machine.alias} ${machine.region} ${machine.gpuName} ${machine.id}`
        .toLowerCase().includes(keyword));
    }
    rows.sort((a, b) => {
      const idleDiff = S.effectiveIdle(b) - S.effectiveIdle(a);
      if (idleDiff !== 0) return idleDiff;
      return String(a.name).localeCompare(String(b.name), 'zh-Hant');
    });
    return rows;
  }

  function renderLibrary() {
    const rows = libraryRows();
    const totalPages = Math.max(1, Math.ceil(rows.length / lib.pageSize));
    if (lib.page > totalPages) lib.page = totalPages;
    const start = (lib.page - 1) * lib.pageSize;
    const pageRows = rows.slice(start, start + lib.pageSize);
    const targets = (state.settings && state.settings.targets) || [];

    const status = state.status || {};
    $('libMeta').textContent = state.machines.length
      ? `主機庫共 ${state.machines.length} 台（含所有分頁，第 ${status.pages || '?'} 頁為止）· 更新於 ${S.relativeTimeText(state.machinesAt || status.at)}`
      : '主機庫是空的：按「監控」分頁的「立即檢查」抓一次 AutoDL 全站主機清單。';

    const container = $('libList');
    if (pageRows.length === 0) {
      container.innerHTML = '<div class="empty">沒有符合條件的主機。</div>';
    } else {
      container.innerHTML = pageRows.map((machine) => {
        const idle = S.effectiveIdle(machine);
        const watched = targets.some((target) => S.machineMatches(target.query, machine));
        const price = S.formatPrice(machine.price);
        return `<div class="item">
          <div class="item-main">
            <div class="item-name">${escapeHtml(machine.name || machine.id)}</div>
            <div class="item-sub">${escapeHtml(machine.gpuName || '')}${machine.gpuMemoryGB ? ` ${machine.gpuMemoryGB}GB` : ''} · 空閒 ${idle}/${machine.total}${machine.offline ? ' · 已租完' : ''}${price !== '—' ? ` · ${price}` : ''}${machine.rentDeadline ? ` · 可租至 ${String(machine.rentDeadline).slice(0, 10)}` : ''}</div>
          </div>
          <span class="badge ${idle > 0 ? 'ok' : 'mute'}">${idle > 0 ? `空閒 ${idle}` : '無空閒'}</span>
          <div class="item-actions">
            <button type="button" data-id="${escapeHtml(machine.id)}" ${watched ? 'disabled' : ''}>${watched ? '監控中' : '＋監控'}</button>
          </div>
        </div>`;
      }).join('');

      container.querySelectorAll('button[data-id]').forEach((button) => {
        button.addEventListener('click', async () => {
          const machine = state.machines.find((item) => item.id === button.dataset.id);
          if (!machine) return;
          button.disabled = true;
          const response = await send({ type: 'ADL_ADD_TARGET', query: machine.name, label: machine.name, rescan: false });
          if (response && response.ok) {
            state.settings = response.settings;
            button.textContent = '監控中';
            toast(`已加入監控：${machine.name}`);
            renderWatch();
            renderHeader();
          } else {
            button.textContent = '已在清單';
            toast((response && response.error) || '加入失敗');
          }
        });
      });
    }

    $('libPageInfo').textContent = rows.length
      ? `第 ${lib.page} / ${totalPages} 頁（共 ${rows.length} 台）`
      : '—';
    $('libPrev').disabled = lib.page <= 1;
    $('libNext').disabled = lib.page >= totalPages;
  }

  /* ------------------------------------------------------------ 設定 */

  function renderSettings() {
    const settings = state.settings;
    if (!settings) return;
    document.querySelectorAll('[data-setting]').forEach((element) => {
      const path = element.dataset.setting;
      const value = getPath(settings, path);
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else if (element.tagName === 'SELECT') element.value = String(value);
      else if (element.type === 'number') element.value = String(value == null ? 0 : value);
    });
    renderGpuChips();
    renderRegionChips();
    const muted = Boolean(settings.alarm && settings.alarm.muted);
    $('muteToggle').textContent = muted ? '取消靜音' : '靜音';
    const pageSize = Number(settings.pageSize) || 90;
    const maxPages = Number(settings.maxPages) || 30;
    $('pageEstimate').textContent = `目前設定：每頁 ${pageSize} 台 × 最多 ${maxPages} 頁 = 單次最多檢查 ${pageSize * maxPages} 台主機（AutoDL 全站主機通常遠少於這個數量）。`;
  }

  function renderGpuChips() {
    const container = $('gpuFilter');
    const list = (state.meta && state.meta.gpuTypes) || [];
    const selected = new Set((state.settings && state.settings.filters && state.settings.filters.gpuTypes) || []);
    if (list.length === 0) {
      container.innerHTML = '<div class="hint">讀不到 GPU 型號清單，按下方「重新讀取型號／地區」。</div>';
      return;
    }
    container.innerHTML = list.map((gpu) => `
      <label class="chip ${selected.has(gpu.name) ? 'on' : ''}">
        <input type="checkbox" data-group="filters.gpuTypes" value="${escapeHtml(gpu.name)}" ${selected.has(gpu.name) ? 'checked' : ''}>
        ${escapeHtml(gpu.name)}${gpu.memoryGB ? ` ${gpu.memoryGB}G` : ''}
      </label>`).join('');
    wireGroup('filters.gpuTypes');
  }

  function renderRegionChips() {
    const container = $('regionFilter');
    const list = (state.meta && state.meta.regions) || [];
    const selected = new Set((state.settings && state.settings.filters && state.settings.filters.regions) || []);
    const keyword = ($('regionSearch').value || '').trim().toLowerCase();
    if (list.length === 0) {
      container.innerHTML = '<div class="hint">讀不到地區清單，按下方「重新讀取型號／地區」。</div>';
      return;
    }
    const rows = list.filter((region) => !keyword || `${region.name} ${region.sign}`.toLowerCase().includes(keyword));
    container.innerHTML = rows.length
      ? rows.map((region) => `
        <label class="chip ${selected.has(region.sign) ? 'on' : ''}">
          <input type="checkbox" data-group="filters.regions" value="${escapeHtml(region.sign)}" ${selected.has(region.sign) ? 'checked' : ''}>
          ${escapeHtml(region.name)}<small>${escapeHtml(region.sign)}</small>
        </label>`).join('')
      : '<div class="hint">沒有符合的地區。</div>';
    wireGroup('filters.regions');
  }

  function wireGroup(path) {
    document.querySelectorAll(`input[data-group="${path}"]`).forEach((input) => {
      input.addEventListener('change', async () => {
        const values = [...document.querySelectorAll(`input[data-group="${path}"]:checked`)].map((item) => item.value);
        input.closest('.chip').classList.toggle('on', input.checked);
        await savePatch(setPath({}, path, values));
        toast(values.length ? `已選 ${values.length} 項篩選` : '已清除該篩選');
      });
    });
  }

  async function savePatch(patch, options) {
    const response = await send({ type: 'ADL_SAVE_SETTINGS', patch });
    if (response && response.ok) state.settings = response.settings;
    if (!options || options.rescan !== false) scheduleRescan();
    return response;
  }

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(async () => {
      const response = await send({ type: 'ADL_SCAN_NOW' });
      if (response && response.status) {
        state.status = response.status;
        await reloadMachines();
        renderAll();
      }
    }, 800);
  }

  /* ------------------------------------------------------------ 診斷 */

  function renderDiagnostics() {
    const auth = state.auth || { hasToken: false };
    const status = state.status || {};
    const settings = state.settings || {};

    $('diagAuth').innerHTML = `
      <div><b>登入權杖</b><span>${auth.hasToken ? '已取得（只存在你的瀏覽器）' : '尚未取得'}</span></div>
      <div><b>取得時間</b><span>${auth.at ? S.timeText(auth.at) : '—'}</span></div>
      <div><b>帳號類型</b><span>${auth.subName ? `子帳號 ${escapeHtml(auth.subName)}` : '主帳號'}</span></div>
      <div><b>使用者</b><span>${escapeHtml(auth.userName || '—')}</span></div>`;

    $('diagScan').innerHTML = `
      <div><b>上次掃描</b><span>${status.at ? `${S.timeText(status.at)}（${S.relativeTimeText(status.at)}）` : '尚未'}</span></div>
      <div><b>觸發原因</b><span>${escapeHtml(status.reason || '—')}</span></div>
      <div><b>使用通道</b><span>${escapeHtml(status.transport || '—')}</span></div>
      <div><b>抓取頁數</b><span>${status.pages || 0} 頁${status.truncated ? '（已達上限，可能未涵蓋全部）' : ''}</span></div>
      <div><b>主機庫筆數</b><span>${status.machinesCount || 0} 台${status.total != null ? ` / AutoDL 回報 ${status.total} 台` : ''}</span></div>
      <div><b>監控命中</b><span>${status.matchedCount || 0} / ${(settings.targets || []).length}</span></div>
      <div><b>耗時</b><span>${status.durationMs ? `${status.durationMs} 毫秒` : '—'}</span></div>
      <div><b>錯誤</b><span>${status.errors && status.errors.length ? status.errors.map(escapeHtml).join('<br>') : '無'}</span></div>
      <div><b>目前篩選</b><span>${escapeHtml(JSON.stringify(status.filters || {}))}</span></div>`;

    const results = status.results || [];
    $('diagTargets').innerHTML = results.length
      ? results.map((result) => `<div><b>${escapeHtml(result.label || result.query)}</b><span>${escapeHtml(result.state)}${result.matches && result.matches.length ? ` · ${escapeHtml(result.matches.map((item) => `${item.name}(${item.idle}/${item.total})`).join('、'))}` : ''}</span></div>`).join('')
      : '<div><b>—</b><span>還沒有監控目標</span></div>';

    $('rawSample').textContent = status.rawSample || '（還沒有回應樣本）';
  }

  function diagnosticReport() {
    const status = state.status || {};
    const settings = state.settings || {};
    return JSON.stringify({
      extension: 'AutoDL 主機 GPU 監控 v' + (chrome.runtime.getManifest().version),
      time: new Date().toISOString(),
      userAgent: navigator.userAgent,
      auth: { hasToken: Boolean(state.auth && state.auth.hasToken), subName: state.auth && state.auth.subName },
      settings: {
        enabled: settings.enabled,
        intervalSeconds: settings.intervalSeconds,
        pageSize: settings.pageSize,
        maxPages: settings.maxPages,
        transport: settings.transport,
        filters: settings.filters,
        targetCount: (settings.targets || []).length
      },
      status: {
        at: status.at,
        reason: status.reason,
        transport: status.transport,
        pages: status.pages,
        total: status.total,
        machinesCount: status.machinesCount,
        truncated: status.truncated,
        needsLogin: status.needsLogin,
        errors: status.errors,
        results: status.results
      },
      rawSample: status.rawSample
    }, null, 2);
  }

  /* ------------------------------------------------------------ 事件 */

  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
    });
  });

  $('addBtn').addEventListener('click', async () => {
    const query = $('targetInput').value.trim();
    if (!query) { toast('請先輸入主機名稱'); return; }
    const required = Math.max(1, Math.min(8, Number($('requiredInput').value) || 1));
    const response = await send({ type: 'ADL_ADD_TARGET', query, required, rescan: false });
    if (response && response.ok) {
      state.settings = response.settings;
      $('targetInput').value = '';
      toast('已加入監控');
      await load(false);
      scheduleRescan();
    } else {
      toast((response && response.error) || '加入失敗');
    }
  });

  $('targetInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('addBtn').click();
  });

  $('scanBtn').addEventListener('click', async () => {
    $('scanBtn').disabled = true;
    $('scanBtn').textContent = '檢查中…';
    const response = await send({ type: 'ADL_SCAN_NOW' });
    $('scanBtn').disabled = false;
    $('scanBtn').textContent = '立即檢查';
    if (response && response.status) state.status = response.status;
    await reloadMachines();
    renderAll();
    toast(response && response.status && response.status.errors && response.status.errors.length ? '檢查完成（有錯誤）' : '檢查完成');
  });

  $('openAutodlBtn').addEventListener('click', () => send({ type: 'ADL_OPEN_AUTODL' }));
  $('alertOpen').addEventListener('click', () => send({ type: 'ADL_OPEN_AUTODL' }));
  $('alertStop').addEventListener('click', async () => {
    await send({ type: 'ADL_DISMISS_ALERT' });
    state.activeAlert = null;
    renderHeader();
  });

  $('libSearch').addEventListener('input', (event) => { lib.search = event.target.value; lib.page = 1; renderLibrary(); });
  $('libOnlyIdle').addEventListener('change', (event) => { lib.onlyIdle = event.target.checked; lib.page = 1; renderLibrary(); });
  $('libPrev').addEventListener('click', () => { lib.page = Math.max(1, lib.page - 1); renderLibrary(); });
  $('libNext').addEventListener('click', () => { lib.page += 1; renderLibrary(); });

  document.querySelectorAll('[data-setting]').forEach((element) => {
    element.addEventListener('change', async () => {
      const path = element.dataset.setting;
      let value;
      if (element.type === 'checkbox') value = element.checked;
      else if (element.type === 'number') value = Number(element.value);
      else value = element.value;
      await savePatch(setPath({}, path, value));
      renderHeader();
    });
  });

  $('regionSearch').addEventListener('input', renderRegionChips);

  $('clearFilters').addEventListener('click', async () => {
    await savePatch({ filters: { gpuTypes: [], regions: [], tags: [], minIdle: 0 } });
    toast('已清除篩選');
  });

  $('metaReload').addEventListener('click', async () => {
    const response = await send({ type: 'ADL_FETCH_META', force: true });
    if (response && response.ok) {
      state.meta = response.meta;
      renderGpuChips();
      renderRegionChips();
      toast('已重新讀取');
    }
  });

  $('testAlarm').addEventListener('click', () => send({ type: 'ADL_TEST_ALARM', sound: state.settings.alarm.sound }));

  $('muteToggle').addEventListener('click', async () => {
    const muted = !(state.settings.alarm && state.settings.alarm.muted);
    await send({ type: 'ADL_SET_MUTED', muted });
    state.settings.alarm.muted = muted;
    renderSettings();
    toast(muted ? '已靜音' : '已取消靜音');
  });

  $('exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'autodl-host-monitor-settings.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  $('importBtn').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        await send({ type: 'ADL_SAVE_SETTINGS', patch: parsed });
        await load(false);
        scheduleRescan();
        toast('設定已匯入');
      } catch (error) {
        toast('匯入失敗：檔案格式不對');
      }
    });
    input.click();
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!window.confirm('確定要清除所有監控清單與設定嗎？')) return;
    await chrome.storage.local.clear();
    await send({ type: 'ADL_SAVE_SETTINGS', patch: {} });
    await load(false);
    toast('已清除');
  });

  $('captureAuthBtn').addEventListener('click', async () => {
    $('captureAuthBtn').disabled = true;
    $('captureAuthBtn').textContent = '取得中…';
    const response = await send({ type: 'ADL_CAPTURE_AUTH', allowTempTab: true });
    $('captureAuthBtn').disabled = false;
    $('captureAuthBtn').textContent = '重新取得 AutoDL 登入狀態';
    if (response && response.ok) {
      toast('已取得登入狀態');
      await load(false);
      scheduleRescan();
    } else {
      toast('沒取得登入狀態，請先在瀏覽器登入 AutoDL');
    }
  });

  $('copyDiag').addEventListener('click', async () => {
    await navigator.clipboard.writeText(diagnosticReport());
    toast('診斷資訊已複製（不含權杖）');
  });

  $('refreshDiag').addEventListener('click', () => load(true));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.status) state.status = changes.status.newValue;
    if (changes.settings) state.settings = changes.settings.newValue;
    if (changes.activeAlert) state.activeAlert = changes.activeAlert.newValue || null;
    if (changes.machines) state.machines = changes.machines.newValue || [];
    if (changes.machinesAt) state.machinesAt = changes.machinesAt.newValue || 0;
    renderAll();
  });

  window.setInterval(() => { if (state.status) renderHeader(); }, 5000);

  load(true);
})();

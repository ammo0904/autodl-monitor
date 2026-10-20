/*
 * AutoDL 主機 GPU 監控 — background service worker
 * ---------------------------------------------------------------
 * 核心差異（相對 F5 刷新式擴充套件）：
 *   直接呼叫 AutoDL 算力市場自己的介面 /api/v1/user/machine/list，
 *   所以不需要頁面刷新、不需要頁面停在特定位置，甚至不需要開著頁面。
 *   （登入權杖是使用 AutoDL 頁面自己在 localStorage 放的那一組，
 *     只會送到 www.autodl.com，不會經過任何第三方。）
 *
 * 分頁：AutoDL 市場主機清單一頁最多 90 台，訂閱的主機常常落在第 2 頁之後，
 *   這裡會依結果的 result_total / page_size 自動翻頁抓完（可設上限）。
 */
importScripts('shared.js');

const ALARM_POLL = 'adl-poll';
const OFFSCREEN_URL = 'offscreen.html';
const NOTIFICATION_ID = 'adl-alert';

const DEFAULTS = {
  enabled: true,
  intervalSeconds: 60,
  pageSize: 100,
  maxPages: 30,
  requestDelayMs: 250,
  transport: 'auto',
  filters: {
    chargeType: 'payg',
    gpuTypes: [],
    regions: [],
    tags: [],
    minIdle: 0
  },
  requiredDefault: 1,
  alarm: {
    enabled: true,
    notify: true,
    muted: false,
    sound: 'classic',
    repeatMinutes: 5,
    continuous: false
  },
  targets: []
};

let scanning = null;
let metaCache = { at: 0, gpuTypes: [], regions: [] };

/* ------------------------------------------------------------------ 設定 */

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(patch || {})) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return deepMerge(DEFAULTS, stored.settings || {});
}

async function saveSettings(patch) {
  const settings = deepMerge(await getSettings(), patch || {});
  await chrome.storage.local.set({ settings });
  await syncAlarm();
  return settings;
}

async function getAuth() {
  const stored = await chrome.storage.local.get('auth');
  return stored.auth || null;
}

async function getStatus() {
  const stored = await chrome.storage.local.get('status');
  return stored.status || null;
}

/* -------------------------------------------------------------- 鬧鐘排程 */

async function syncAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_POLL);
  if (!settings.enabled) return;
  // Chrome 對 alarms 的最小週期是 30 秒（較舊版本是 1 分鐘），太小的值會被夾住或直接報錯
  const minutes = Math.max(0.5, (Number(settings.intervalSeconds) || 60) / 60);
  try {
    await chrome.alarms.create(ALARM_POLL, { periodInMinutes: minutes, delayInMinutes: minutes });
  } catch (_error) {
    try {
      await chrome.alarms.create(ALARM_POLL, { periodInMinutes: 1, delayInMinutes: 1 });
    } catch (error) {
      console.warn('[AutoDL 主機監控] 無法建立輪詢鬧鐘：', error);
    }
  }
}

/* ------------------------------------------------------------ 登入權杖 */

function isAutodlUrl(url) {
  return /^https:\/\/([a-z0-9-]+\.)*autodl\.com\//i.test(url || '');
}

async function findAutodlTab() {
  const tabs = await chrome.tabs.query({ url: ['https://*.autodl.com/*'] });
  return tabs.find((tab) => isAutodlUrl(tab.url)) || null;
}

/** 從既有 AutoDL 分頁的 localStorage 讀出登入權杖（MAIN world，等同網站自己讀） */
async function captureAuthFromTab(tabId) {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const token = window.localStorage.getItem('token') || '';
        let subName = '';
        let version = '0.0.0';
        let userName = '';
        try {
          const user = JSON.parse(window.localStorage.getItem('user') || '{}');
          subName = user.sub_name || '';
          userName = user.name || user.phone || '';
        } catch (_error) { /* 沒登入或格式不同都當作主帳號 */ }
        try {
          version = JSON.parse(window.localStorage.getItem('app_version') || '{}').version || version;
        } catch (_error) { /* 版本非必要 */ }
        return { token, subName, version, userName };
      }
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result || !result.token) return null;
    const auth = {
      token: result.token,
      subName: result.subName || '',
      appVersion: result.version || '0.0.0',
      userName: result.userName || '',
      at: Date.now()
    };
    await chrome.storage.local.set({ auth });
    return auth;
  } catch (error) {
    console.warn('[AutoDL 主機監控] 讀取登入狀態失敗：', error);
    return null;
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs || 15000);
  });
}

/**
 * 取得登入權杖：
 *   1. 已經有權杖 → 直接用（除非介面回報 AuthorizeFailed 才 force 重讀；
 *      權杖不會因為「放久了」就作廢，所以不設時效，避免白開分頁）
 *   2. 有開著 AutoDL 分頁 → 直接讀
 *   3. 都沒有 → 背景開一個不搶焦點的分頁，讀完立刻關掉（有冷卻時間，不會一直開）
 */
async function ensureAuth(options) {
  const opts = options || {};
  const auth = await getAuth();
  if (auth && auth.token && !opts.force) return auth;

  const tab = await findAutodlTab();
  if (tab) {
    const captured = await captureAuthFromTab(tab.id);
    if (captured) return captured;
    if (auth && auth.token) return auth;
  }

  if (!opts.allowTempTab) return auth;

  // 剛試過就別再開新分頁，避免沒登入時每次輪詢都開一個
  const cooldownMs = opts.force ? 15000 : 30 * 60000;
  const lastAttempt = (await chrome.storage.local.get('authAttemptAt')).authAttemptAt || 0;
  if (Date.now() - lastAttempt < cooldownMs) return auth;
  await chrome.storage.local.set({ authAttemptAt: Date.now() });

  let created = null;
  try {
    created = await chrome.tabs.create({ url: `${AdlShared.API_ORIGIN}/market/list`, active: false });
    await waitForTabComplete(created.id, 20000);
    const captured = await captureAuthFromTab(created.id);
    return captured || auth;
  } catch (error) {
    console.warn('[AutoDL 主機監控] 暫時分頁取得登入狀態失敗：', error);
    return auth;
  } finally {
    if (created && created.id) {
      try { await chrome.tabs.remove(created.id); } catch (_error) { /* 使用者可能自己關了 */ }
    }
  }
}

/* -------------------------------------------------------------- 介面請求 */

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function transportCandidates(settings) {
  const preferred = settings.transport || 'auto';
  if (preferred === 'worker') return ['worker'];
  if (preferred === 'page') return ['page'];
  return ['worker', 'page'];
}

/** 由 service worker 直接打 API（最省事，不需任何分頁） */
async function requestViaWorker(url, body, auth) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: AdlShared.buildHeaders(auth.token, auth.appVersion),
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_error) { payload = null; }
    const parsed = AdlShared.parseListResponse(payload, response.status);
    parsed.httpStatus = response.status;
    parsed.rawSample = text.slice(0, 2000);
    parsed.transport = 'worker';
    return parsed;
  } catch (error) {
    return {
      ok: false,
      code: 'NetworkError',
      error: `背景請求失敗：${(error && error.message) || error}`,
      transport: 'worker',
      network: true
    };
  }
}

/** 退路：在 AutoDL 分頁裡用網站自己的環境打 API（帶上 Cookie / Referer，最接近真實） */
async function requestViaPage(url, body, auth) {
  const tab = await findAutodlTab();
  if (!tab) {
    return { ok: false, code: 'NoTab', error: '需要至少一個 AutoDL 分頁才能用「頁面通道」', transport: 'page', needTab: true };
  }
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      args: [{ url, body, token: auth.token, appVersion: auth.appVersion }],
      func: async (request) => {
        try {
          const response = await window.fetch(request.url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Authorization: request.token,
              AppVersion: request.appVersion
            },
            body: JSON.stringify(request.body)
          });
          const text = await response.text();
          return { httpStatus: response.status, text: text.slice(0, 200000) };
        } catch (error) {
          return { error: String((error && error.message) || error) };
        }
      }
    });
    const result = injected && injected[0] && injected[0].result;
    if (!result) return { ok: false, code: 'NoResult', error: '頁面通道沒有回應', transport: 'page' };
    if (result.error) return { ok: false, code: 'NetworkError', error: `頁面通道失敗：${result.error}`, transport: 'page', network: true };
    let payload = null;
    try { payload = JSON.parse(result.text); } catch (_error) { payload = null; }
    const parsed = AdlShared.parseListResponse(payload, result.httpStatus);
    parsed.httpStatus = result.httpStatus;
    parsed.rawSample = String(result.text || '').slice(0, 2000);
    parsed.transport = 'page';
    return parsed;
  } catch (error) {
    return { ok: false, code: 'InjectFailed', error: `無法在 AutoDL 分頁執行：${(error && error.message) || error}`, transport: 'page' };
  }
}

async function requestPage(body, transport, auth) {
  const url = AdlShared.API_ORIGIN + AdlShared.listPath(auth.subName);
  return transport === 'page' ? requestViaPage(url, body, auth) : requestViaWorker(url, body, auth);
}

/* ---------------------------------------------------------------- 掃描 */

function newTargetId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function scan(reason) {
  if (scanning) return scanning;
  scanning = doScan(reason || 'manual')
    .catch((error) => ({ error: (error && error.message) || String(error) }))
    .finally(() => { scanning = null; });
  return scanning;
}

async function doScan(reason) {
  const startedAt = Date.now();
  const settings = await getSettings();
  const previousStatus = await getStatus() || {};
  const previousSnapshot = (await chrome.storage.local.get('snapshot')).snapshot || {};

  if (!settings.enabled && reason !== 'manual') {
    return { skipped: 'disabled' };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await writeStatus(Object.assign({}, previousStatus, { at: previousStatus.at || 0, offline: true }));
    return { skipped: 'offline' };
  }

  let auth = await getAuth();
  if (!auth || !auth.token) auth = await ensureAuth({ allowTempTab: true });

  if (!auth || !auth.token) {
    const status = {
      at: Date.now(),
      needsLogin: true,
      reason,
      errors: ['尚未取得 AutoDL 登入狀態，請開啟 autodl.com 任一頁面（或按「開啟 AutoDL 取得登入」）。'],
      results: (settings.targets || []).map((target) => ({
        id: target.id, query: target.query, label: target.label || target.query,
        required: Math.max(1, Number(target.required) || settings.requiredDefault || 1),
        state: 'notfound', idle: 0, matches: []
      })),
      machinesCount: 0,
      pages: 0,
      total: null,
      truncated: false
    };
    await writeStatus(status);
    return status;
  }

  const filters = settings.filters || {};
  const baseQuery = AdlShared.buildQuery({
    charge_type: filters.chargeType || 'payg',
    gpu_type_name: Array.isArray(filters.gpuTypes) ? filters.gpuTypes : [],
    machine_tag_name: Array.isArray(filters.tags) ? filters.tags : [],
    region_sign_list: Array.isArray(filters.regions) ? filters.regions : [],
    gpu_idle_num: Math.max(0, Number(filters.minIdle) || 0),
    page_size: clamp(settings.pageSize, 10, 200),
    page_index: 1
  });

  const candidates = transportCandidates(settings);
  const machines = new Map();
  const errors = [];
  let pageIndex = 1;
  let serverPageSize = baseQuery.page_size;
  let total = null;
  let truncated = false;
  let rawSample = '';
  let usedTransport = candidates[0];
  let authRetried = false;

  for (;;) {
    const body = Object.assign({}, baseQuery, { page_index: pageIndex, page_size: serverPageSize || baseQuery.page_size });
    let result = null;
    let lastError = null;

    for (const candidate of candidates) {
      result = await requestPage(body, candidate, auth);
      if (result.ok) { usedTransport = candidate; break; }
      lastError = result;
      if (result.code === 'AuthorizeFailed') break; // 換通道沒用，先處理登入
    }

    // 權杖過期：重新從頁面抓一次，還失敗就請使用者重新登入
    if (result && !result.ok && result.code === 'AuthorizeFailed' && !authRetried) {
      authRetried = true;
      const refreshed = await ensureAuth({ force: true, allowTempTab: true });
      if (refreshed && refreshed.token && refreshed.token !== auth.token) {
        auth = refreshed;
        continue;
      }
      errors.push('登入狀態已失效，請重新登入 AutoDL（擴充套件會自動重新取得權杖）。');
      await writeStatus({
        at: Date.now(), needsLogin: true, reason, errors,
        results: (settings.targets || []).map((target) => evaluateOrEmpty(target, settings)),
        machinesCount: machines.size, pages: pageIndex - 1, total, truncated: false, transport: usedTransport
      });
      return { needsLogin: true, errors };
    }

    if (!result || !result.ok) {
      const message = (lastError && lastError.error) || '未知錯誤';
      errors.push(`第 ${pageIndex} 頁失敗：${message}${lastError && lastError.needTab ? '（可改設定為「自動」通道）' : ''}`);
      if (machines.size === 0) {
        await writeStatus({
          at: Date.now(), needsLogin: false, reason, errors,
          results: (settings.targets || []).map((target) => evaluateOrEmpty(target, settings)),
          machinesCount: 0, pages: 0, total: null, truncated: false, transport: usedTransport,
          rawSample: (lastError && lastError.rawSample) || ''
        });
        return { errors };
      }
      break;
    }

    if (pageIndex === 1) {
      rawSample = result.rawSample || '';
      if (result.total != null) total = result.total;
      if (result.pageSize) serverPageSize = clamp(result.pageSize, 1, 500);
    }

    for (const row of result.rows) {
      const machine = AdlShared.machineFromRow(row, baseQuery.charge_type);
      if (!machine.id) continue;
      machines.set(machine.id, machine);
    }
    await writeStatus(Object.assign({}, await getStatus() || {}, {
      scanning: true, scanningAt: Date.now(), progressPage: pageIndex, machinesCount: machines.size, total
    }));

    const decision = AdlShared.nextPageDecision({
      collected: machines.size,
      received: result.rows.length,
      pageSize: serverPageSize,
      total,
      pageIndex,
      maxPages: Math.max(1, Math.min(200, Number(settings.maxPages) || 30))
    });
    if (decision.done) {
      truncated = decision.reason === 'max-pages';
      break;
    }
    pageIndex = decision.nextPage;
    if (settings.requestDelayMs) await sleep(clamp(settings.requestDelayMs, 0, 5000));
  }

  const machineList = [...machines.values()].slice(0, 8000);
  const results = AdlShared.evaluateScan(settings.targets || [], machineList);
  const now = Date.now();
  const alerts = AdlShared.diffAlerts(previousSnapshot, results, {
    now,
    repeatMinutes: settings.alarm && settings.alarm.enabled ? settings.alarm.repeatMinutes : 0
  });
  const snapshot = AdlShared.stateSnapshot(results, previousSnapshot, {});
  for (const alert of alerts) {
    if (alert.type === 'available' || alert.type === 'remind') {
      if (snapshot[alert.id]) snapshot[alert.id].notifiedAt = now;
    }
  }

  const status = {
    at: now,
    durationMs: now - startedAt,
    reason,
    needsLogin: false,
    transport: usedTransport,
    pages: pageIndex,
    total,
    truncated,
    machinesCount: machineList.length,
    matchedCount: results.filter((item) => item.state !== 'notfound').length,
    errors,
    results,
    alerts,
    filters: { chargeType: baseQuery.charge_type, gpuTypes: baseQuery.gpu_type_name, regions: baseQuery.region_sign_list, minIdle: baseQuery.gpu_idle_num },
    rawSample: rawSample.slice(0, 1200),
    auth: { subName: auth.subName || '', userName: auth.userName || '', at: auth.at || 0 }
  };

  await chrome.storage.local.set({ machines: machineList, machinesAt: now, snapshot, status });

  if (alerts.some((alert) => alert.type === 'available' || alert.type === 'remind')) {
    await raiseAlert(alerts.filter((alert) => alert.type !== 'cleared'), settings);
  } else if (alerts.some((alert) => alert.type === 'cleared')) {
    await clearAlert();
  } else {
    await updateBadge();
  }

  return status;
}

function evaluateOrEmpty(target, settings) {
  return {
    id: target.id,
    query: target.query,
    label: target.label || target.query,
    required: Math.max(1, Number(target.required) || settings.requiredDefault || 1),
    state: 'notfound',
    idle: 0,
    matches: []
  };
}

async function writeStatus(status) {
  await chrome.storage.local.set({ status });
  return status;
}

/* ------------------------------------------------------------- 通知/響鈴 */

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['AUDIO_PLAYBACK'],
      justification: '播放使用者在 GPU 空閒時設定的提醒音。'
    });
  }
  return true;
}

async function playAlarm(sound, durationMs) {
  const settings = await getSettings();
  if (settings.alarm.muted) return;
  try {
    if (await ensureOffscreen()) {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_PLAY_TONE',
        sound: sound || settings.alarm.sound || 'classic',
        durationMs: durationMs || 15000
      });
    }
  } catch (error) {
    console.warn('[AutoDL 主機監控] 播放提醒音失敗：', error);
  }
}

async function stopAlarm() {
  try { chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }); } catch (_error) { /* offscreen 可能不存在 */ }
}

function alertTitle(items) {
  const labels = items.map((item) => item.label);
  if (labels.length === 1) return `AutoDL：${labels[0]} 有空閒 GPU`;
  return `AutoDL：${labels.length} 台監控主機有空閒 GPU`;
}

function alertMessage(items) {
  return items.map((item) => `${item.label}（空閒 ${item.idle} 卡，需要 ${item.required} 卡）`).join('\n');
}

async function raiseAlert(items, settings) {
  const fresh = (items || []).filter(Boolean);
  if (fresh.length === 0) return;
  const active = { at: Date.now(), items: fresh };
  await chrome.storage.local.set({ activeAlert: active });

  if (settings.alarm.enabled) {
    if (settings.alarm.notify) {
      try {
        await chrome.notifications.clear(NOTIFICATION_ID);
        await chrome.notifications.create(NOTIFICATION_ID, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: alertTitle(fresh),
          message: alertMessage(fresh),
          priority: 2,
          requireInteraction: true,
          buttons: [{ title: '前往 AutoDL 算力市場' }, { title: '停止提醒' }]
        });
      } catch (error) {
        console.warn('[AutoDL 主機監控] 系統通知失敗：', error);
      }
    }
    await playAlarm(settings.alarm.sound, fresh.some((item) => item.type === 'remind') ? 8000 : 15000);
  }
  await updateBadge();
}

async function clearAlert() {
  await chrome.storage.local.remove('activeAlert');
  await stopAlarm();
  try { await chrome.notifications.clear(NOTIFICATION_ID); } catch (_error) { /* 沒通知就忽略 */ }
  await updateBadge();
}

/** 擴充套件圖示上的小徽章：有空閒主機時顯示紅色數字 */
async function updateBadge() {
  try {
    const [stored, status] = await Promise.all([chrome.storage.local.get('activeAlert'), getStatus()]);
    const active = stored.activeAlert;
    const available = ((status && status.results) || []).filter((item) => item.state === 'available');
    if (active && active.items && active.items.length) {
      await chrome.action.setBadgeBackgroundColor({ color: '#e54545' });
      await chrome.action.setBadgeText({ text: String(active.items.length) });
    } else if (available.length) {
      await chrome.action.setBadgeBackgroundColor({ color: '#3ba55d' });
      await chrome.action.setBadgeText({ text: String(available.length) });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
    await chrome.action.setTitle({
      title: available.length
        ? `AutoDL 主機監控 — ${available.map((item) => item.label).join('、')} 有空閒 GPU`
        : 'AutoDL 主機監控（免刷新）'
    });
  } catch (_error) { /* 沒有 action 的環境就算了 */ }
}

/* --------------------------------------------------------------- 主機庫 */

/** 取得 GPU 型號 / 地區清單（這兩個介面不需要登入） */
async function fetchMeta(force) {
  if (!force && metaCache.at && Date.now() - metaCache.at < 6 * 3600000) return metaCache;
  const result = { at: Date.now(), gpuTypes: [], regions: [], errors: [] };
  try {
    const response = await fetch(`${AdlShared.API_ORIGIN}${AdlShared.PATHS.gpuType}`);
    const payload = await response.json();
    if (payload && payload.code === 'Success' && Array.isArray(payload.data)) {
      result.gpuTypes = payload.data
        .map((item) => ({ name: item.gpu_name, rank: item.gpu_rank, memoryGB: item.gpu_memory ? Math.round(item.gpu_memory / 1024 / 1024 / 1024) : null, corp: item.chip_corp }))
        .filter((item) => item.name);
    }
  } catch (error) {
    result.errors.push(`GPU 型號清單取得失敗：${(error && error.message) || error}`);
  }
  try {
    const response = await fetch(`${AdlShared.API_ORIGIN}${AdlShared.PATHS.regionList}`);
    const payload = await response.json();
    if (payload && payload.code === 'Success' && Array.isArray(payload.data)) {
      result.regions = payload.data
        .map((item) => ({ sign: item.region_sign, name: item.region_name, dataCenter: item.data_center }))
        .filter((item) => item.sign && item.name);
    }
  } catch (error) {
    result.errors.push(`地區清單取得失敗：${(error && error.message) || error}`);
  }
  metaCache = result;
  await chrome.storage.local.set({ meta: result });
  return result;
}

/* ------------------------------------------------------------------ 訊息 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const type = message && message.type;

    if (type === 'ADL_GET_STATE') {
      const [settings, status, auth, machines, alert, meta] = await Promise.all([
        getSettings(),
        getStatus(),
        getAuth(),
        chrome.storage.local.get(['machines', 'machinesAt']),
        chrome.storage.local.get('activeAlert'),
        chrome.storage.local.get('meta')
      ]);
      sendResponse({
        ok: true,
        settings,
        status,
        auth: auth ? { hasToken: true, at: auth.at, subName: auth.subName, userName: auth.userName } : { hasToken: false },
        machinesAt: machines.machinesAt || 0,
        activeAlert: alert.activeAlert || null,
        meta: meta.meta || { gpuTypes: [], regions: [] },
        hasOffscreen: Boolean(chrome.offscreen)
      });
      return;
    }

    if (type === 'ADL_GET_MACHINES') {
      const stored = await chrome.storage.local.get(['machines', 'machinesAt']);
      sendResponse({ ok: true, machines: stored.machines || [], at: stored.machinesAt || 0 });
      return;
    }

    if (type === 'ADL_SCAN_NOW') {
      const status = await scan('manual');
      sendResponse({ ok: true, status });
      return;
    }

    if (type === 'ADL_MAYBE_SCAN') {
      const settings = await getSettings();
      if (!settings.enabled) { sendResponse({ ok: true, skipped: 'disabled' }); return; }
      const status = await getStatus();
      const interval = Math.max(30, Number(settings.intervalSeconds) || 60) * 1000;
      if (status && status.at && Date.now() - status.at < interval - 2000 && !status.needsLogin) {
        sendResponse({ ok: true, skipped: 'fresh' });
        return;
      }
      const result = await scan('timer');
      sendResponse({ ok: true, status: result });
      return;
    }

    if (type === 'ADL_SAVE_SETTINGS') {
      const settings = await saveSettings(message.patch || {});
      sendResponse({ ok: true, settings });
      return;
    }

    if (type === 'ADL_ADD_TARGET') {
      const settings = await getSettings();
      const query = String(message.query || '').trim();
      if (!query) { sendResponse({ ok: false, error: '請輸入主機名稱' }); return; }
      const targets = (settings.targets || []).slice();
      const duplicate = targets.find((target) => AdlShared.normalizeName(target.query) === AdlShared.normalizeName(query));
      if (duplicate) { sendResponse({ ok: false, error: '這個主機已經在監控清單裡了' }); return; }
      targets.push({
        id: newTargetId(),
        query,
        label: String(message.label || '').trim() || query,
        required: Math.max(1, Number(message.required) || settings.requiredDefault || 1),
        createdAt: Date.now()
      });
      const saved = await saveSettings({ targets });
      if (message.rescan !== false) scan('target-added');
      sendResponse({ ok: true, settings: saved });
      return;
    }

    if (type === 'ADL_REMOVE_TARGET') {
      const settings = await getSettings();
      const targets = (settings.targets || []).filter((target) => target.id !== message.id);
      await saveSettings({ targets });
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_UPDATE_TARGET') {
      const settings = await getSettings();
      const targets = (settings.targets || []).map((target) => (
        target.id === message.id ? Object.assign({}, target, message.patch || {}) : target
      ));
      await saveSettings({ targets });
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_REGISTER_AUTH') {
      const incoming = message.auth || {};
      if (!incoming.token) { sendResponse({ ok: false }); return; }
      const current = await getAuth();
      if (current && current.token === incoming.token) {
        await chrome.storage.local.set({ auth: Object.assign({}, current, { at: Date.now() }) });
      } else {
        await chrome.storage.local.set({
          auth: {
            token: incoming.token,
            subName: incoming.subName || '',
            appVersion: incoming.appVersion || '0.0.0',
            userName: incoming.userName || '',
            at: Date.now()
          }
        });
      }
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_CAPTURE_AUTH') {
      const auth = await ensureAuth({ force: true, allowTempTab: message.allowTempTab !== false });
      sendResponse({ ok: Boolean(auth && auth.token), auth: auth ? { subName: auth.subName, userName: auth.userName, at: auth.at } : null });
      return;
    }

    if (type === 'ADL_FETCH_META') {
      sendResponse({ ok: true, meta: await fetchMeta(Boolean(message.force)) });
      return;
    }

    if (type === 'ADL_TEST_ALARM') {
      await playAlarm(message.sound, 3000);
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_STOP_ALARM') {
      await stopAlarm();
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_DISMISS_ALERT') {
      await clearAlert();
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_SET_MUTED') {
      const settings = await saveSettings({ alarm: { muted: Boolean(message.muted) } });
      if (settings.alarm.muted) await stopAlarm();
      sendResponse({ ok: true, settings });
      return;
    }

    if (type === 'ADL_OPEN_AUTODL') {
      await openAutodl(message.url);
      sendResponse({ ok: true });
      return;
    }

    if (type === 'ADL_OPEN_POPUP') {
      try {
        await chrome.action.openPopup();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: '此 Chrome 版本不支援由頁面開啟面板，請點工具列上的擴充套件圖示。' });
      }
      return;
    }

    sendResponse({ ok: false, error: `未知的訊息類型：${type}` });
  })().catch((error) => {
    console.warn('[AutoDL 主機監控] 訊息處理失敗：', error);
    try { sendResponse({ ok: false, error: (error && error.message) || String(error) }); } catch (_error) { /* 已經回過了 */ }
  });
  return true;
});

async function openAutodl(url) {
  const target = url || `${AdlShared.API_ORIGIN}/market/list`;
  const tab = await findAutodlTab();
  if (tab && tab.id) {
    await chrome.tabs.update(tab.id, { active: true, url: target });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_error) { /* 視窗可能已關 */ }
    return;
  }
  await chrome.tabs.create({ url: target, active: true });
}

/* ------------------------------------------------------------------ 事件 */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_POLL) return;
  const settings = await getSettings();
  await scan('alarm');
  // 「持續響鈴直到處理」模式：每次輪詢都再響一次，直到使用者關掉提醒
  const active = (await chrome.storage.local.get('activeAlert')).activeAlert;
  if (active && settings.alarm.enabled && settings.alarm.continuous && !settings.alarm.muted) {
    await playAlarm(settings.alarm.sound, 4000);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ settings });
  await syncAlarm();
  await fetchMeta(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarm();
});

chrome.notifications.onClicked.addListener(async () => {
  await openAutodl();
});

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (buttonIndex === 0) {
    await openAutodl();
  } else {
    await clearAlert();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const next = changes.settings.newValue || {};
  const prev = changes.settings.oldValue || {};
  if (next.enabled !== prev.enabled || next.intervalSeconds !== prev.intervalSeconds) syncAlarm();
});

// 讓 service worker 被喚醒時就把鬧鐘補上（例如瀏覽器重啟後第一次醒來）
syncAlarm();

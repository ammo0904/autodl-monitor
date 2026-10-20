/*
 * AutoDL 主機 GPU 監控 — 共用純邏輯
 * ---------------------------------------------------------------
 * 這個檔案只放「不碰瀏覽器 API」的純函式，因此可以同時被：
 *   1. background service worker（importScripts）
 *   2. popup 視窗（<script src>）
 *   3. Node 測試（tools/test-shared.mjs）
 * 載入。好處是核心邏輯（主機名稱比對、分頁、可用性判定、告警差異）
 * 可以離開瀏覽器單獨驗證。
 *
 * AutoDL 算力市場的真實介面（逆向自 www.autodl.com 前端 bundle）：
 *   POST https://www.autodl.com/api/v1/user/machine/list
 *   headers: Authorization: <localStorage.token>
 *            AppVersion: <localStorage.app_version.version>
 *   body:    見 buildQuery()
 *   resp:    { code:'Success', data:{ list:[...], page_index, page_size, result_total } }
 *   子帳號路徑: /api/v1/sub_user/user/machine/list
 *
 * 每台主機（list[] 的一項）用到的欄位：
 *   machine_id, machine_alias, region_name, region_sign, gpu_name, gpu_memory,
 *   gpu_idle_num(空閒), gpu_number(總量), max_instance_num, binding_instance_num,
 *   on_line(3,4,5,6 = 已租完/離線), rent_deadline, max_data_disk_expand_size,
 *   driver_version, highest_cuda_version, chip_corp, machine_sku_info, payg_price
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.AdlShared = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** AutoDL 站台與介面路徑 */
  const API_ORIGIN = 'https://www.autodl.com';
  const PATHS = {
    listMain: '/api/v1/user/machine/list',
    listSub: '/api/v1/sub_user/user/machine/list',
    gpuType: '/api/v1/machine/gpu_type',
    regionList: '/api/v1/region/list',
    machineTag: '/api/v1/machine/tag'
  };

  /** on_line 為這幾個值代表「已租完 / 下線」，站方自己也是這樣判定 */
  const OFFLINE_CODES = [3, 4, 5, 6];

  const CHARGE_TYPES = ['payg', 'daily', 'weekly', 'monthly', 'yearly'];
  const CHARGE_UNITS = { payg: '/时', daily: '/日', weekly: '/周', monthly: '/月', yearly: '/年' };

  /** 全形 → 半形（含全形空白） */
  function toHalfWidth(value) {
    return String(value == null ? '' : value).replace(/[\uFF01-\uFF5E\u3000]/g, (ch) =>
      ch === '\u3000' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
    );
  }

  /**
   * 主機名稱正規化：全形轉半形、去空白、去分隔符、繁簡異體統一、轉小寫。
   * 「西北B区 / 824机」「西北Ｂ區／824機」「 西北b区824机 」都會變成同一把鑰匙。
   */
  function normalizeName(value) {
    return toHalfWidth(value)
      .replace(/\s+/g, '')
      .replace(/[／/\\|｜·・,，、\-_]+/g, '')
      .replace(/機/g, '机')
      .replace(/區/g, '区')
      .replace(/號/g, '号')
      .toLowerCase();
  }

  /** 「824机」與「824」視為同一台，方便使用者少打字 */
  function stripMachineSuffix(normalized) {
    return normalized.replace(/机$/, '');
  }

  /** 站上顯示的主機名稱：region_name + ' / ' + machine_alias（例：西北B区 / 824机） */
  function displayNameOf(row) {
    const region = String((row && row.region_name) || '').trim();
    const alias = String((row && row.machine_alias) || '').trim();
    if (region && alias) return `${region} / ${alias}`;
    return region || alias || String((row && row.machine_id) || '').trim();
  }

  function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /** 從 machine_sku_info 取價（陣列索引對應 payg/daily/weekly/monthly/yearly） */
  function priceOf(row, chargeType) {
    const type = chargeType || 'payg';
    const index = Math.max(0, CHARGE_TYPES.indexOf(type));
    const sku = Array.isArray(row && row.machine_sku_info) ? row.machine_sku_info : [];
    const entry = sku[index] || sku[0] || null;
    let current = entry ? numberOrNull(entry.current_price) : null;
    let discounted = null;
    if (entry && entry.level_config) {
      const cfg = entry.level_config;
      const pick = Array.isArray(cfg) ? cfg[0] : (cfg.normal_user || cfg.member_user || cfg);
      if (pick) discounted = numberOrNull(pick.discounted_price);
    }
    // 舊欄位備援：payg_price 為「元 × 1000」
    if (type === 'payg' && numberOrNull(row && row.payg_price) != null) {
      const legacy = numberOrNull(row.payg_price) / 1000;
      if (current == null) current = legacy * 1000;
    }
    return {
      unit: CHARGE_UNITS[type] || '/时',
      current: current == null ? null : current / 1000,
      discounted: discounted == null ? null : discounted / 1000
    };
  }

  /** 把 API 的一列壓縮成擴充套件內部使用的精簡主機物件 */
  function machineFromRow(row, chargeType) {
    const source = row || {};
    const price = priceOf(source, chargeType);
    return {
      id: String(source.machine_id || ''),
      alias: String(source.machine_alias || ''),
      region: String(source.region_name || ''),
      regionSign: String(source.region_sign || ''),
      name: displayNameOf(source),
      gpuName: String(source.gpu_name || ''),
      gpuMemoryGB: numberOrNull(source.gpu_memory) == null ? null : Math.round(numberOrNull(source.gpu_memory) / 1024 / 1024 / 1024),
      idle: numberOrNull(source.gpu_idle_num) || 0,
      total: numberOrNull(source.gpu_number) || 0,
      maxInstance: numberOrNull(source.max_instance_num),
      binding: numberOrNull(source.binding_instance_num),
      onLine: numberOrNull(source.on_line),
      offline: OFFLINE_CODES.indexOf(Number(source.on_line)) >= 0,
      rentDeadline: source.rent_deadline || '',
      dataDiskExpandGB: numberOrNull(source.max_data_disk_expand_size) == null
        ? null
        : Math.floor(numberOrNull(source.max_data_disk_expand_size) / 1024 / 1024 / 1024),
      driver: source.driver_version || '',
      cuda: source.highest_cuda_version || '',
      chipCorp: source.chip_corp || '',
      price,
      chargeType: chargeType || 'payg'
    };
  }

  /**
   * 真正可租用的空閒卡數 —— 完全照站方列表頁的判斷：
   *   on_line ∈ [3,4,5,6] → 0（已租完/離線）
   *   max_instance_num - binding_instance_num <= 0 → 0（這台主機的實例數已滿）
   *   否則 = gpu_idle_num
   */
  function effectiveIdle(machine) {
    if (!machine) return 0;
    if (machine.offline) return 0;
    const max = numberOrNull(machine.maxInstance);
    const binding = numberOrNull(machine.binding);
    if (max != null && binding != null && max - binding <= 0) return 0;
    return Math.max(0, numberOrNull(machine.idle) || 0);
  }

  /** 這台主機所有可以被使用者輸入的名稱（正規化後） */
  function matchKeysOf(machine) {
    const keys = new Set();
    const add = (value) => {
      const normalized = normalizeName(value);
      if (!normalized) return;
      keys.add(normalized);
      keys.add(stripMachineSuffix(normalized));
    };
    add(machine.name);
    add(machine.alias);
    add(machine.id);
    add(machine.region + machine.alias);
    add(machine.alias + machine.region);
    return keys;
  }

  function queryKeysOf(query) {
    const keys = new Set();
    const normalized = normalizeName(query);
    if (!normalized) return keys;
    keys.add(normalized);
    keys.add(stripMachineSuffix(normalized));
    // 「西北B区 / 824机」若被拆成兩段輸入，也接受「824机 西北B区」這類順序顛倒
    return keys;
  }

  /** 單一主機是否符合監控目標 */
  function machineMatches(query, machine) {
    const wanted = queryKeysOf(query);
    if (wanted.size === 0) return false;
    const keys = matchKeysOf(machine);
    for (const key of wanted) if (keys.has(key)) return true;
    return false;
  }

  /** 找出目標對應的所有主機（同名 alias 可能跨地區重複，所以回傳陣列） */
  function matchMachines(machines, query) {
    const list = Array.isArray(machines) ? machines : [];
    return list.filter((machine) => machineMatches(query, machine));
  }

  /**
   * 判定一個監控目標目前的狀態。
   * required = 需要幾張空閒卡（>= 才算「可用」）
   * 回傳 state: 'available' | 'unavailable' | 'notfound'
   */
  function evaluateTarget(target, machines) {
    const required = Math.max(1, Number(target && target.required) || 1);
    const matches = matchMachines(machines, target && target.query);
    if (matches.length === 0) {
      return { id: target.id, query: target.query, label: target.label || target.query, required, state: 'notfound', idle: 0, matches: [] };
    }
    let bestIdle = 0;
    for (const machine of matches) bestIdle = Math.max(bestIdle, effectiveIdle(machine));
    return {
      id: target.id,
      query: target.query,
      label: target.label || target.query,
      required,
      state: bestIdle >= required ? 'available' : 'unavailable',
      idle: bestIdle,
      matches: matches.map((machine) => ({
        id: machine.id,
        name: machine.name,
        alias: machine.alias,
        region: machine.region,
        gpuName: machine.gpuName,
        idle: effectiveIdle(machine),
        rawIdle: machine.idle,
        total: machine.total,
        offline: machine.offline,
        price: machine.price,
        rentDeadline: machine.rentDeadline,
        dataDiskExpandGB: machine.dataDiskExpandGB
      }))
    };
  }

  /** 建立 /api/v1/user/machine/list 的請求內容（預設值完全比照站方前端） */
  function buildQuery(overrides) {
    const base = {
      charge_type: 'payg',
      region_sign: '',
      gpu_type_name: [],
      machine_tag_name: [],
      gpu_idle_num: 0,
      mount_net_disk: false,
      instance_disk_size_order: '',
      date_range: '',
      date_from: '',
      date_to: '',
      page_index: 1,
      page_size: 100,
      pay_price_order: '',
      gpu_idle_type: '',
      default_order: true,
      region_sign_list: []
    };
    return Object.assign(base, overrides || {});
  }

  function listPath(subName) {
    return subName ? PATHS.listSub : PATHS.listMain;
  }

  function buildHeaders(token, appVersion) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = token;
    headers.AppVersion = appVersion || '0.0.0';
    return headers;
  }

  /** 解析一個列表回應；負責辨識未登入 / 參數錯誤 / 成功 */
  function parseListResponse(payload, httpStatus) {
    if (!payload || typeof payload !== 'object') {
      return { ok: false, rows: [], total: null, pageIndex: null, pageSize: null, code: 'BadPayload', error: `回應格式無法解析（HTTP ${httpStatus}）` };
    }
    const code = String(payload.code || '');
    if (code === 'AuthorizeFailed') {
      return { ok: false, rows: [], total: null, pageIndex: null, pageSize: null, code, error: '登入狀態失效，請重新開啟 AutoDL 頁面' };
    }
    if (code !== 'Success') {
      return { ok: false, rows: [], total: null, pageIndex: null, pageSize: null, code: code || 'Unknown', error: payload.msg || `AutoDL 回應 ${code || '未知錯誤'}` };
    }
    const data = payload.data || {};
    const rows = Array.isArray(data) ? data : (Array.isArray(data.list) ? data.list : []);
    const pageSize = numberOrNull(data.page_size);
    const total = numberOrNull(data.result_total);
    return {
      ok: true,
      rows,
      total,
      pageIndex: numberOrNull(data.page_index),
      pageSize: pageSize && pageSize > 0 ? pageSize : null,
      code
    };
  }

  /**
   * 分頁決策（純函式，方便測試）：
   * 依「站方回報的 page_size / result_total」決定還要不要抓下一頁。
   */
  function nextPageDecision(state) {
    const collected = state.collected;
    const received = state.received;
    const pageSize = state.pageSize;
    const total = state.total;
    const pageIndex = state.pageIndex;
    const maxPages = state.maxPages;
    const totalPages = total != null && pageSize ? Math.ceil(total / pageSize) : null;
    if (received === 0) return { done: true, reason: 'empty' };
    if (total != null && collected >= total) return { done: true, reason: 'complete' };
    if (pageSize != null && received < pageSize) return { done: true, reason: 'last-page' };
    if (totalPages != null && pageIndex >= totalPages) return { done: true, reason: 'complete' };
    if (pageIndex >= maxPages) return { done: true, reason: 'max-pages' };
    return { done: false, nextPage: pageIndex + 1, totalPages };
  }

  /** 一次掃描的目標評估 + 是否觸發告警 */
  function evaluateScan(targets, machines) {
    return (Array.isArray(targets) ? targets : []).map((target) => evaluateTarget(target, machines));
  }

  /**
   * 比較前後兩次掃描，決定要發哪些告警。
   * previous / current : { [targetId]: { state, idle } }
   * options.repeatMinutes : 0 = 只在「變成可用」時提醒一次；> 0 = 持續可用時每隔幾分鐘再提醒
   * options.now / options.lastNotifiedAt
   */
  function diffAlerts(previous, current, options) {
    const opts = options || {};
    const now = opts.now || Date.now();
    const repeatMs = Math.max(0, Number(opts.repeatMinutes) || 0) * 60000;
    const alerts = [];
    for (const result of current) {
      const prev = (previous || {})[result.id] || null;
      const wasAvailable = Boolean(prev && prev.state === 'available');
      const isAvailable = result.state === 'available';
      if (!isAvailable) {
        if (wasAvailable) alerts.push({ type: 'cleared', id: result.id, label: result.label });
        continue;
      }
      if (!wasAvailable) {
        alerts.push({ type: 'available', id: result.id, label: result.label, idle: result.idle, required: result.required });
        continue;
      }
      if (repeatMs > 0) {
        const last = Number(prev && prev.notifiedAt) || 0;
        if (now - last >= repeatMs) alerts.push({ type: 'remind', id: result.id, label: result.label, idle: result.idle, required: result.required });
      }
    }
    return alerts;
  }

  /** 由掃描結果產生 { [targetId]: {state, idle, notifiedAt} } 快照 */
  function stateSnapshot(results, previousSnapshot, notifiedAtMap) {
    const snapshot = {};
    for (const result of results) {
      const prev = (previousSnapshot || {})[result.id] || null;
      const wasAvailable = Boolean(prev && prev.state === 'available');
      const isAvailable = result.state === 'available';
      let notifiedAt = prev ? Number(prev.notifiedAt) || 0 : 0;
      if (!isAvailable) notifiedAt = 0;
      if (isAvailable && !wasAvailable) notifiedAt = (notifiedAtMap && notifiedAtMap[result.id]) || Date.now();
      snapshot[result.id] = { state: result.state, idle: result.idle, notifiedAt };
    }
    return snapshot;
  }

  /** 價格顯示（元 / 單位） */
  function formatPrice(price) {
    if (!price) return '—';
    const value = price.discounted != null ? price.discounted : price.current;
    if (value == null) return '—';
    return `￥${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}${price.unit}`;
  }

  /** 主機狀態文字（例：空閒 2/10、已租完、離線） */
  function machineStatusText(machine) {
    if (machine.offline) return '已租完 / 離線';
    const idle = effectiveIdle(machine);
    return `空閒 ${idle}/${machine.total}`;
  }

  /** 給人看的時間字串 */
  function timeText(timestamp) {
    if (!timestamp) return '尚未';
    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function relativeTimeText(timestamp, now) {
    if (!timestamp) return '尚未';
    const diff = Math.max(0, (now || Date.now()) - timestamp);
    if (diff < 5000) return '剛剛';
    if (diff < 60000) return `${Math.round(diff / 1000)} 秒前`;
    if (diff < 3600000) return `${Math.round(diff / 60000)} 分鐘前`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)} 小時前`;
    return `${Math.round(diff / 86400000)} 天前`;
  }

  return {
    API_ORIGIN,
    PATHS,
    OFFLINE_CODES,
    CHARGE_TYPES,
    CHARGE_UNITS,
    toHalfWidth,
    normalizeName,
    stripMachineSuffix,
    displayNameOf,
    priceOf,
    machineFromRow,
    effectiveIdle,
    matchKeysOf,
    queryKeysOf,
    machineMatches,
    matchMachines,
    evaluateTarget,
    evaluateScan,
    buildQuery,
    listPath,
    buildHeaders,
    parseListResponse,
    nextPageDecision,
    diffAlerts,
    stateSnapshot,
    formatPrice,
    machineStatusText,
    timeText,
    relativeTimeText
  };
});

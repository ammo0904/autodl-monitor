/*
 * background.js 的整合測試（Node 執行）
 *   node tools/test-background.mjs
 *
 * 做法：用一個假的 chrome API（storage / alarms / notifications / scripting / tabs）
 *      把真正的 background.js 跑起來，fetch 指向本機的「假 AutoDL 伺服器」。
 *      驗證：
 *        1. 自動取得登入權杖（模擬開暫時分頁讀 localStorage）
 *        2. 分頁抓完整份主機清單（假伺服器刻意把 page_size 夾成 2 台，逼出第 3 頁）
 *        3. 監控目標落在「第 3 頁」的主機也能被找到 → 這正是需求裡的第 2 頁以上情境
 *        4. 空閒出現時：狀態變 available、發出桌面通知、寫入 activeAlert
 *        5. 持續可用時：repeatMinutes=0 不重複吵、repeatMinutes>0 會再提醒
 *        6. 恢復無空閒時：activeAlert 被清掉
 *        7. 請求內容與站方一致（Authorization / charge_type / page_index 連號）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const S = require(path.join(root, 'shared.js'));

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed += 1; return; }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

/* ------------------------------------------------------ 假 AutoDL 伺服器 */

function makeRow(overrides) {
  return Object.assign({
    machine_id: 'm-001',
    machine_alias: '101机',
    region_name: '北京B区',
    region_sign: 'bj-B1',
    gpu_name: 'RTX 4090',
    gpu_memory: 25769803776,
    gpu_idle_num: 0,
    gpu_number: 10,
    max_instance_num: 10,
    binding_instance_num: 10,
    on_line: 1,
    rent_deadline: '2027-07-01T00:00:00+08:00',
    max_data_disk_expand_size: 0,
    machine_sku_info: [{ current_price: 1980, level_config: { normal_user: { discounted_price: 1980 } } }]
  }, overrides || {});
}

let machines = [
  makeRow({ machine_id: 'm-001', machine_alias: '101机' }),
  makeRow({ machine_id: 'm-002', machine_alias: '102机' }),
  makeRow({ machine_id: 'm-003', machine_alias: '103机' }),
  makeRow({ machine_id: 'm-004', machine_alias: '104机' }),
  // 目標主機刻意放在最後（假伺服器 page_size=2 → 這台在第 3 頁）
  makeRow({
    machine_id: 'm-824',
    machine_alias: '824机',
    region_name: '西北B区',
    region_sign: 'west-B',
    gpu_idle_num: 0,
    binding_instance_num: 10
  })
];

const serverCalls = [];
const CLAMP_PAGE_SIZE = 2;

const server = http.createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(404).end('404 page not found');
    return;
  }
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_error) { payload = null; }
    serverCalls.push({ url: request.url, headers: request.headers, payload });
    const json = (value) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url !== '/api/v1/user/machine/list') {
      response.writeHead(404).end('404 page not found');
      return;
    }
    if (!payload || !request.headers.authorization) {
      json({ code: 'AuthorizeFailed', data: null, msg: '登录超时，请重新登录' });
      return;
    }
    // 模擬站方把 page_size 夾小，逼擴充套件真的翻頁
    const size = Math.min(Number(payload.page_size) || 10, CLAMP_PAGE_SIZE);
    const pageIndex = Number(payload.page_index) || 1;
    json({
      code: 'Success',
      msg: '',
      data: {
        list: machines.slice((pageIndex - 1) * size, pageIndex * size),
        page_index: pageIndex,
        page_size: size,
        result_total: machines.length
      }
    });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
S.API_ORIGIN = `http://127.0.0.1:${port}`;

/* --------------------------------------------------------- 假 chrome API */

function makeChrome() {
  const store = {};
  const listeners = { message: [], storage: [], alarm: [], installed: [], startup: [], notifClick: [], notifButton: [], tabUpdated: [] };
  const notifications = [];
  const tones = [];

  async function get(keys) {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      for (const key of keys) if (key in store) out[key] = store[key];
      return out;
    }
    const out = {};
    for (const key of Object.keys(keys)) out[key] = key in store ? store[key] : keys[key];
    return out;
  }

  function emitStorage(changes) {
    for (const listener of listeners.storage) listener(changes, 'local');
  }

  const chrome = {
    storage: {
      local: {
        get,
        async set(items) {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: store[key], newValue: value };
            store[key] = value;
          }
          emitStorage(changes);
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of list) {
            if (key in store) { changes[key] = { oldValue: store[key], newValue: undefined }; delete store[key]; }
          }
          if (Object.keys(changes).length) emitStorage(changes);
        },
        async clear() {
          for (const key of Object.keys(store)) delete store[key];
        }
      },
      onChanged: { addListener: (fn) => listeners.storage.push(fn) }
    },
    alarms: {
      async clear() { return true; },
      create() { },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    notifications: {
      async create(id, options) { notifications.push({ id, options }); return id; },
      async clear() { return true; },
      onClicked: { addListener: (fn) => listeners.notifClick.push(fn) },
      onButtonClicked: { addListener: (fn) => listeners.notifButton.push(fn) }
    },
    offscreen: {
      async createDocument() { return undefined; }
    },
    scripting: {
      async executeScript({ func, args }) {
        // 只實作 background 用到的兩種注入：讀 localStorage / 在頁面發 fetch
        const source = func.toString();
        if (source.includes('localStorage')) {
          return [{ result: { token: 'TEST-TOKEN-123456', subName: '', version: '9.9.9', userName: 'tester' } }];
        }
        if (source.includes('window.fetch')) {
          const request = args[0];
          const response = await fetch(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: request.token, AppVersion: request.appVersion },
            body: JSON.stringify(request.body)
          });
          const text = await response.text();
          return [{ result: { httpStatus: response.status, text } }];
        }
        return [{ result: null }];
      }
    },
    tabs: {
      async query() { return []; },          // 沒有任何 AutoDL 分頁 → 走「開暫時分頁」流程
      async create() {
        const tab = { id: 901, url: 'https://www.autodl.com/market/list' };
        setTimeout(() => {
          for (const listener of listeners.tabUpdated) listener(901, { status: 'complete' }, tab);
        }, 5);
        return tab;
      },
      async remove() { },
      async update() { },
      onUpdated: {
        addListener: (fn) => listeners.tabUpdated.push(fn),
        removeListener: (fn) => {
          const index = listeners.tabUpdated.indexOf(fn);
          if (index >= 0) listeners.tabUpdated.splice(index, 1);
        }
      }
    },
    windows: { async update() { }, async getAll() { return []; } },
    action: {
      async setBadgeText() { }, async setBadgeBackgroundColor() { }, async setTitle() { },
      async openPopup() { }
    },
    runtime: {
      getURL: (relative) => `chrome-extension://test/${relative}`,
      getManifest: () => ({ version: '1.0.0' }),
      async getContexts() { return []; },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      async sendMessage(message) { if (message && message.type === 'OFFSCREEN_PLAY_TONE') tones.push(message); },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) }
    }
  };
  return { chrome, store, listeners, notifications, tones };
}

const fake = makeChrome();

/* ------------------------------------------- 把真正的 background.js 跑起來 */

const backgroundSource = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const run = new Function('importScripts', 'chrome', 'navigator', 'fetch', 'AdlShared', 'console', backgroundSource);
run(
  () => { },                    // importScripts：shared.js 已經先載好了
  fake.chrome,
  { onLine: true },
  (...args) => fetch(...args),
  S,
  console
);

function send(message) {
  return new Promise((resolve, reject) => {
    const listener = fake.listeners.message[0];
    if (!listener) { reject(new Error('background 沒有註冊 onMessage')); return; }
    const timer = setTimeout(() => reject(new Error(`等不到回應：${message.type}`)), 15000);
    listener(message, {}, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/* ------------------------------------------------------------ 開始測試 */

// 先確認沒有權杖時會自己去拿
const authResponse = await send({ type: 'ADL_CAPTURE_AUTH', allowTempTab: true });
check('取得登入權杖（自動開暫時分頁）', authResponse && authResponse.ok === true, JSON.stringify(authResponse));
eq('權杖寫入 storage', Boolean(fake.store.auth && fake.store.auth.token), true);

await send({
  type: 'ADL_SAVE_SETTINGS',
  patch: {
    enabled: true,
    intervalSeconds: 30,
    pageSize: 100,
    maxPages: 10,
    requestDelayMs: 0,
    transport: 'auto',
    targets: [{ id: 't1', query: '西北B区 / 824机', label: '西北B区 / 824机', required: 1 }],
    alarm: { enabled: true, notify: true, muted: false, sound: 'classic', repeatMinutes: 0, continuous: false }
  }
});

/* 第一輪：目標在第 3 頁、目前 0 空閒 */
serverCalls.length = 0;
let scan = await send({ type: 'ADL_SCAN_NOW' });
let status = scan.status;
eq('第 1 輪：抓了幾頁', status.pages, 3);
eq('第 1 輪：主機庫台數', status.machinesCount, 5);
eq('第 1 輪：目標狀態', status.results[0].state, 'unavailable');
eq('第 1 輪：沒有通知', fake.notifications.length, 0);
eq('第 1 輪：請求頁碼連號', serverCalls.map((call) => call.payload.page_index), [1, 2, 3]);
eq('第 1 輪：有帶 Authorization', serverCalls[0].headers.authorization, 'TEST-TOKEN-123456');
eq('第 1 輪：請求參數與站方一致', {
  charge_type: serverCalls[0].payload.charge_type,
  region_sign: serverCalls[0].payload.region_sign,
  gpu_idle_num: serverCalls[0].payload.gpu_idle_num,
  default_order: serverCalls[0].payload.default_order,
  mount_net_disk: serverCalls[0].payload.mount_net_disk,
  page_size: serverCalls[0].payload.page_size
}, {
  charge_type: 'payg',
  region_sign: '',
  gpu_idle_num: 0,
  default_order: true,
  mount_net_disk: false,
  page_size: 100
});
check('第 1 輪：findAll 路徑正確', serverCalls.every((call) => call.url === '/api/v1/user/machine/list'), serverCalls[0].url);

/* 第二輪：目標（在第 3 頁）出現空閒 → 應該通知 */
machines = machines.map((machine) => (
  machine.machine_id === 'm-824' ? { ...machine, gpu_idle_num: 2, binding_instance_num: 8 } : machine
));
scan = await send({ type: 'ADL_SCAN_NOW' });
status = scan.status;
eq('第 2 輪：目標狀態', status.results[0].state, 'available');
eq('第 2 輪：空閒數', status.results[0].idle, 2);
eq('第 2 輪：告警類型', status.alerts.map((alert) => alert.type), ['available']);
eq('第 2 輪：發出桌面通知', fake.notifications.length, 1);
check('第 2 輪：通知標題帶主機名', fake.notifications[0].options.title.includes('824机'), fake.notifications[0].options.title);
check('第 2 輪：播放提醒音', fake.tones.length >= 1, String(fake.tones.length));
eq('第 2 輪：寫入 activeAlert', Boolean(fake.store.activeAlert && fake.store.activeAlert.items.length), true);
eq('第 2 輪：徽章顯示提醒數', fake.store.activeAlert.items.length, 1);

/* 第三輪：持續可用 + repeatMinutes=0 → 不再吵 */
scan = await send({ type: 'ADL_SCAN_NOW' });
eq('第 3 輪：沒有重複告警', scan.status.alerts.length, 0);
eq('第 3 輪：通知數不變', fake.notifications.length, 1);

/* 第四輪：改成每 5 分鐘提醒，並把上次通知時間往前挪 → 應該再提醒 */
await send({ type: 'ADL_SAVE_SETTINGS', patch: { alarm: { repeatMinutes: 5 } } });
const snapshot = { ...fake.store.snapshot };
snapshot.t1 = { ...snapshot.t1, notifiedAt: Date.now() - 6 * 60000 };
await fake.chrome.storage.local.set({ snapshot });
scan = await send({ type: 'ADL_SCAN_NOW' });
eq('第 4 輪：重複提醒', scan.status.alerts.map((alert) => alert.type), ['remind']);
eq('第 4 輪：再發一次通知', fake.notifications.length, 2);

/* 第五輪：恢復無空閒 → 清掉提醒 */
machines = machines.map((machine) => (
  machine.machine_id === 'm-824' ? { ...machine, gpu_idle_num: 0, binding_instance_num: 10 } : machine
));
scan = await send({ type: 'ADL_SCAN_NOW' });
eq('第 5 輪：目標狀態', scan.status.results[0].state, 'unavailable');
eq('第 5 輪：清除 activeAlert', fake.store.activeAlert, undefined);

/* 第六輪：找不到主機（名稱打錯） */
await send({ type: 'ADL_SAVE_SETTINGS', patch: { targets: [{ id: 't2', query: '999机', label: '999机', required: 1 }] } });
scan = await send({ type: 'ADL_SCAN_NOW' });
eq('第 6 輪：找不到主機', scan.status.results[0].state, 'notfound');
eq('第 6 輪：不會誤發通知', fake.notifications.length, 2);

/* 第七輪：登入失效 → 必須明確回報需要登入 */
machines = machines.map((machine) => ({ ...machine }));
await fake.chrome.storage.local.set({ auth: { token: '', subName: '', appVersion: '0.0.0', at: 0 } });
await fake.chrome.storage.local.set({ authAttemptAt: Date.now() });   // 關掉暫時分頁冷卻，避免測試卡住
await fake.chrome.storage.local.remove('auth');
fake.chrome.tabs.query = async () => [];
scan = await send({ type: 'ADL_SCAN_NOW' });
check('第 7 輪：回報需要登入或錯誤', Boolean(scan.status.needsLogin) || (scan.status.errors && scan.status.errors.length > 0),
  JSON.stringify({ needsLogin: scan.status.needsLogin, errors: scan.status.errors }));

/* ---------------------------------------------------------------- 收尾 */

server.close();

console.log(`\nbackground.js 整合測試：通過 ${passed} 項，失敗 ${failures.length} 項`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('全部通過 ✅');

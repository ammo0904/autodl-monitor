/*
 * shared.js 的離線驗證（Node 執行，不需要瀏覽器 / 不需要 AutoDL 帳號）
 *   node tools/test-shared.mjs
 *
 * 這裡刻意用「跟 AutoDL 實際回應同樣欄位」的假資料，驗證：
 *   - 主機名稱正規化與比對（含全形、繁簡、少打「机」）
 *   - 可租用空閒卡數的判定（on_line / max_instance_num / binding_instance_num）
 *   - 分頁決策（page_size、result_total、maxPages、最後一頁）
 *   - 逾時登入 / 參數錯誤的解析
 *   - 告警差異（新出現、持續可用重複提醒、恢復不可用）
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const shared = require(path.join(here, '..', 'shared.js'));

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` → ${detail}` : ''}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, `got ${a}, want ${b}`);
}

/* ---------------------------------------------------------------- 假資料 */

function makeRow(overrides) {
  return Object.assign({
    machine_id: 'm-824',
    machine_alias: '824机',
    region_name: '西北B区',
    region_sign: 'west-B',
    gpu_name: 'RTX 4090',
    gpu_memory: 25769803776,
    gpu_idle_num: 0,
    gpu_number: 10,
    max_instance_num: 10,
    binding_instance_num: 10,
    on_line: 1,
    rent_deadline: '2027-07-01T00:00:00+08:00',
    max_data_disk_expand_size: 0,
    machine_sku_info: [{ current_price: 1980, level_config: { normal_user: { discounted_price: 1980 } } }],
    payg_price: 1980,
    driver_version: '550.90.07',
    highest_cuda_version: '12.4',
    chip_corp: 'nvidia'
  }, overrides || {});
}

/* ---------------------------------------------------------- 名稱正規化 */

eq('normalize 全形與分隔符', shared.normalizeName('西北Ｂ區　／　824機'), '西北b区824机');
eq('normalize 繁簡', shared.normalizeName('西北B區/824機'), shared.normalizeName('西北b区 824机'));
eq('stripMachineSuffix', shared.stripMachineSuffix('824机'), '824');

/* ------------------------------------------------------------ 主機解析 */

const machine = shared.machineFromRow(makeRow(), 'payg');
eq('主機顯示名稱', machine.name, '西北B区 / 824机');
eq('GPU 記憶體換算 GB', machine.gpuMemoryGB, 24);
eq('價格換算（元/時）', machine.price.current, 1.98);
eq('價格文字', shared.formatPrice(machine.price), '￥1.98/时');

const idleMachine = shared.machineFromRow(makeRow({ gpu_idle_num: 3, binding_instance_num: 7 }), 'payg');
eq('空閒卡數', shared.effectiveIdle(idleMachine), 3);
eq('實例數已滿 → 0', shared.effectiveIdle(shared.machineFromRow(makeRow({ gpu_idle_num: 5, binding_instance_num: 10 }), 'payg')), 0);
eq('on_line=3（已租完）→ 0', shared.effectiveIdle(shared.machineFromRow(makeRow({ gpu_idle_num: 5, binding_instance_num: 0, on_line: 3 }), 'payg')), 0);
eq('狀態文字', shared.machineStatusText(shared.machineFromRow(makeRow({ gpu_idle_num: 2, binding_instance_num: 0 }), 'payg')), '空閒 2/10');

/* ------------------------------------------------------------ 名稱比對 */

const pool = [
  shared.machineFromRow(makeRow(), 'payg'),
  shared.machineFromRow(makeRow({ machine_id: 'm-101', machine_alias: '101机', region_name: '北京B区', region_sign: 'bj-B1' }), 'payg'),
  shared.machineFromRow(makeRow({ machine_id: 'm-1824', machine_alias: '1824机', region_name: '西北C区', region_sign: 'west-C' }), 'payg')
];

check('比對：完整主機名稱', shared.matchMachines(pool, '西北B区 / 824机').length === 1);
check('比對：只有 alias', shared.matchMachines(pool, '824机').length === 1);
check('比對：alias 省略「机」', shared.matchMachines(pool, '824').length === 1);
check('比對：主機 ID', shared.matchMachines(pool, 'm-101').length === 1);
check('比對：全形＋繁體', shared.matchMachines(pool, '西北Ｂ區／８２４機').length === 1);
check('比對：不會誤中 1824机', shared.matchMachines(pool, '824机').every((m) => m.alias === '824机'));
check('比對：找不到', shared.matchMachines(pool, '999机').length === 0);

/* ------------------------------------------------------------ 目標判定 */

const available = shared.evaluateTarget({ id: 't1', query: '西北B区 / 824机', required: 1 }, [idleMachine, ...pool]);
eq('目標可用', available.state, 'available');
eq('目標可用空閒數', available.idle, 3);

const notFound = shared.evaluateTarget({ id: 't2', query: '404机', required: 1 }, pool);
eq('目標找不到', notFound.state, 'notfound');

const needMore = shared.evaluateTarget({ id: 't3', query: '824机', required: 4 }, [idleMachine]);
eq('需求 4 卡但只有 3 卡', needMore.state, 'unavailable');

/* -------------------------------------------------------------- 分頁邏輯 */

function simulatePages(opts) {
  const total = opts.total;
  const serverPageSize = opts.serverPageSize;
  const maxPages = opts.maxPages;
  let pageIndex = 1;
  let collected = 0;
  const visited = [];
  // 依 shared.nextPageDecision() 決定是否續抓
  for (;;) {
    const remaining = total - collected;
    const received = Math.max(0, Math.min(serverPageSize, remaining));
    visited.push(pageIndex);
    collected += received;
    const decision = shared.nextPageDecision({
      collected, received, pageSize: serverPageSize, total, pageIndex, maxPages
    });
    if (decision.done) return { visited, collected, reason: decision.reason };
    pageIndex = decision.nextPage;
  }
}

eq('分頁：250 台 / 每頁 100 → 3 頁', simulatePages({ total: 250, serverPageSize: 100, maxPages: 30 }),
  { visited: [1, 2, 3], collected: 250, reason: 'complete' });
eq('分頁：站方把 page_size 夾成 10 → 依實際 page_size 續抓', simulatePages({ total: 25, serverPageSize: 10, maxPages: 30 }),
  { visited: [1, 2, 3], collected: 25, reason: 'complete' });
eq('分頁：超過 maxPages 會被截斷', simulatePages({ total: 5000, serverPageSize: 100, maxPages: 5 }).reason, 'max-pages');
eq('分頁：maxPages 截斷只抓 5 頁', simulatePages({ total: 5000, serverPageSize: 100, maxPages: 5 }).collected, 500);
eq('分頁：空頁即停止', simulatePages({ total: 0, serverPageSize: 100, maxPages: 30 }).reason, 'empty');
eq('分頁：不知道總數時用 received < pageSize 收尾',
  shared.nextPageDecision({ collected: 40, received: 40, pageSize: 100, total: null, pageIndex: 1, maxPages: 30 }),
  { done: true, reason: 'last-page' });

/* ---------------------------------------------------------- 回應解析 */

eq('解析：未登入', shared.parseListResponse({ code: 'AuthorizeFailed', data: null, msg: '登录超时，请重新登录' }, 200).ok, false);
check('解析：未登入會帶提示', shared.parseListResponse({ code: 'AuthorizeFailed' }, 200).error.includes('登入'));
eq('解析：參數錯誤', shared.parseListResponse({ code: 'RequestParameterIsWrong', msg: '请求参数错误' }, 200).error, '请求参数错误');
const parsed = shared.parseListResponse({
  code: 'Success',
  data: { list: [makeRow()], page_index: 1, page_size: 10, result_total: 235 }
}, 200);
eq('解析：成功 ok', parsed.ok, true);
eq('解析：總數', parsed.total, 235);
eq('解析：實際 page_size', parsed.pageSize, 10);
eq('解析：第一列主機', shared.machineFromRow(parsed.rows[0]).name, '西北B区 / 824机');

/* ------------------------------------------------------------ 告警差異 */

const now = 1_700_000_000_000;
const prev = {
  t1: { state: 'unavailable', idle: 0, notifiedAt: 0 },
  t2: { state: 'available', idle: 2, notifiedAt: now - 6 * 60_000 }
};
const cur = [
  { id: 't1', label: '西北B区 / 824机', state: 'available', idle: 1, required: 1 },
  { id: 't2', label: '北京B区 / 101机', state: 'available', idle: 2, required: 1 },
  { id: 't3', label: '別的機', state: 'unavailable', idle: 0, required: 1 }
];
const noRepeat = shared.diffAlerts(prev, cur, { now, repeatMinutes: 0 });
eq('告警：新可用 + 不重複提醒', noRepeat.map((a) => `${a.type}:${a.id}`), ['available:t1']);
const withRepeat = shared.diffAlerts(prev, cur, { now, repeatMinutes: 5 });
eq('告警：新可用 + 持續可用的重複提醒', withRepeat.map((a) => `${a.type}:${a.id}`), ['available:t1', 'remind:t2']);

const cleared = shared.diffAlerts({ t1: { state: 'available', idle: 1 } }, [{ id: 't1', label: 'x', state: 'unavailable', idle: 0, required: 1 }], { now });
eq('告警：恢復不可用會清除', cleared.map((a) => a.type), ['cleared']);

const snapshot = shared.stateSnapshot(cur, prev, { t1: now });
eq('快照：新可用記下通知時間', snapshot.t1, { state: 'available', idle: 1, notifiedAt: now });
eq('快照：已不可用清空通知時間', shared.stateSnapshot([{ id: 't9', label: 'x', state: 'unavailable', idle: 0 }], { t9: { state: 'available', idle: 2, notifiedAt: 5 } }, {}).t9,
  { state: 'unavailable', idle: 0, notifiedAt: 0 });

/* -------------------------------------------------------------- 請求內容 */

const query = shared.buildQuery({ page_index: 2, gpu_type_name: ['RTX 4090'] });
eq('請求：預設計費方式', query.charge_type, 'payg');
eq('請求：預設不篩空閒', query.gpu_idle_num, 0);
eq('請求：帶入頁碼', query.page_index, 2);
eq('請求：region_sign_list 預設空', query.region_sign_list, []);
eq('請求：主帳號路徑', shared.listPath(''), '/api/v1/user/machine/list');
eq('請求：子帳號路徑', shared.listPath('sub01'), '/api/v1/sub_user/user/machine/list');
eq('請求：表頭', shared.buildHeaders('tok', '3.5.0'),
  { 'Content-Type': 'application/json', Authorization: 'tok', AppVersion: '3.5.0' });

/* ------------------------------------------------------------------ 結果 */

console.log(`\nshared.js 測試：通過 ${passed} 項，失敗 ${failures.length} 項`);
if (failures.length) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
console.log('全部通過 ✅');

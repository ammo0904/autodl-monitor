/*
 * AutoDL 主機 GPU 監控 — 介面實測工具（Node 執行，不經過瀏覽器）
 * -----------------------------------------------------------------
 * 用途：確認 AutoDL 的算力市場介面在你的帳號下回傳什麼，跟擴充套件用的是同一組
 *       請求參數與解析邏輯（載入 ../shared.js），所以結果可以直接對照。
 *
 * 用法（權杖只從環境變數讀取，不會寫入任何檔案）：
 *   PowerShell:
 *     $env:AUTODL_TOKEN = "你在 autodl.com 登入後的 localStorage token"
 *     node tools/probe.mjs
 *     node tools/probe.mjs --size 90 --max-pages 5 --gpu "RTX 4090" --region west-B
 *     node tools/probe.mjs --json        # 直接印出原始 JSON（前 2 頁）
 *
 * 取得權杖的方法：在已登入的 AutoDL 頁面按 F12 →
 *   Console 輸入 localStorage.getItem('token')
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const S = require(path.join(here, '..', 'shared.js'));

function parseArgs(argv) {
  const args = { size: 90, maxPages: 3, gpu: [], region: [], minIdle: 0, json: false, delay: 250 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => argv[++index];
    if (token === '--size') args.size = Number(next());
    else if (token === '--max-pages') args.maxPages = Number(next());
    else if (token === '--min-idle') args.minIdle = Number(next());
    else if (token === '--delay') args.delay = Number(next());
    else if (token === '--gpu') args.gpu.push(next());
    else if (token === '--region') args.region.push(next());
    else if (token === '--json') args.json = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log('用法：AUTODL_TOKEN=xxx node tools/probe.mjs [--size 90] [--max-pages 3] [--gpu "RTX 4090"] [--region west-B] [--json]');
  process.exit(0);
}

const token = process.env.AUTODL_TOKEN || '';
if (!token) {
  console.error('缺少 AUTODL_TOKEN 環境變數。請先設定：$env:AUTODL_TOKEN = "<你的 token>"');
  process.exit(2);
}

const appVersion = process.env.AUTODL_APP_VERSION || '0.0.0';
const subName = process.env.AUTODL_SUB_NAME || '';
const url = S.API_ORIGIN + S.listPath(subName);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const base = S.buildQuery({
    page_size: args.size,
    gpu_type_name: args.gpu,
    region_sign_list: args.region,
    gpu_idle_num: args.minIdle
  });
  console.log(`POST ${url}`);
  console.log(`參數：${JSON.stringify({ ...base, page_index: 1 })}`);
  console.log('');

  const machines = new Map();
  let pageIndex = 1;
  let pageSize = args.size;
  let total = null;
  const raw = [];

  for (;;) {
    const body = { ...base, page_index: pageIndex, page_size: pageSize };
    const response = await fetch(url, {
      method: 'POST',
      headers: S.buildHeaders(token, appVersion),
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_error) { /* 非 JSON */ }
    const parsed = S.parseListResponse(payload, response.status);
    if (args.json && raw.length < 2) raw.push({ page: pageIndex, body, response: payload });
    if (!parsed.ok) {
      console.error(`HTTP ${response.status} → ${parsed.code}：${parsed.error}`);
      console.error(text.slice(0, 600));
      process.exit(1);
    }
    if (pageIndex === 1) {
      total = parsed.total;
      pageSize = parsed.pageSize || pageSize;
      console.log(`HTTP ${response.status} · 成功 · 總共 ${total ?? '?'} 台 · 站方 page_size=${pageSize}`);
    }
    for (const row of parsed.rows) {
      const machine = S.machineFromRow(row, base.charge_type);
      if (machine.id) machines.set(machine.id, machine);
    }
    const decision = S.nextPageDecision({
      collected: machines.size,
      received: parsed.rows.length,
      pageSize,
      total,
      pageIndex,
      maxPages: args.maxPages
    });
    if (decision.done) {
      console.log(`共抓 ${pageIndex} 頁、${machines.size} 台（停止原因：${decision.reason}）\n`);
      break;
    }
    pageIndex = decision.nextPage;
    if (args.delay) await sleep(args.delay);
  }

  const list = [...machines.values()];
  const withIdle = list.filter((machine) => S.effectiveIdle(machine) > 0);
  console.log(`其中「現在有空閒」的主機：${withIdle.length} 台\n`);
  const width = (values) => Math.max(...values.map((value) => String(value).length));
  const rows = (withIdle.length ? withIdle : list).slice(0, 40);
  if (rows.length) {
    const cols = {
      名稱: rows.map((machine) => machine.name),
      GPU: rows.map((machine) => machine.gpuName),
      空閒: rows.map((machine) => `${S.effectiveIdle(machine)}/${machine.total}`),
      價格: rows.map((machine) => S.formatPrice(machine.price)),
      狀態: rows.map((machine) => (machine.offline ? '已租完' : '可租')),
      主機ID: rows.map((machine) => machine.id)
    };
    const head = Object.keys(cols).map((key) => key.padEnd(width(cols[key]), ' '));
    console.log(head.join('  '));
    for (let index = 0; index < rows.length; index += 1) {
      console.log(Object.keys(cols).map((key, column) => String(cols[key][index]).padEnd(width(cols[key]), ' ')).join('  '));
    }
    if ((withIdle.length ? withIdle : list).length > 40) console.log(`…（只列前 40 筆）`);
  } else {
    console.log('（沒有符合條件的主機）');
  }

  if (args.json) {
    console.log('\n---- 原始 JSON（前 2 頁，節錄）----');
    console.log(JSON.stringify(raw, null, 2).slice(0, 4000));
  }
}

main().catch((error) => {
  console.error('執行失敗：', error);
  process.exit(1);
});

/*
 * 介面對照檢查（Node 執行）
 *   node tools/check-ui.mjs
 *
 * 用純文字分析找出「在瀏覽器裡才會炸」的低級錯誤：
 *   - popup.js 取用的 element id 在 popup.html 不存在
 *   - 分頁按鈕 data-tab 與內容區 data-panel 對不上
 *   - content script / popup 用到 shared.js 沒有的函式
 *   - manifest 指到的檔案不存在
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let failed = 0;
function report(name, ok, detail) {
  if (ok) { console.log(`✓ ${name}`); return; }
  failed += 1;
  console.error(`✗ ${name}${detail ? ` → ${detail}` : ''}`);
}

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const matchAll = (text, pattern, group = 1) => [...text.matchAll(pattern)].map((match) => match[group]);

/* ---------------------------------------------------------- popup id 對照 */

const popupHtml = read('popup/popup.html');
const popupJs = read('popup/popup.js');
const htmlIds = new Set(matchAll(popupHtml, /id="([^"]+)"/g));
const usedIds = new Set(matchAll(popupJs, /\$\('([^']+)'\)/g));
const missingIds = [...usedIds].filter((id) => !htmlIds.has(id));
report('popup.js 取用的 id 都存在於 popup.html', missingIds.length === 0, missingIds.join(', '));

const tabs = matchAll(popupHtml, /data-tab="([^"]+)"/g);
const panels = matchAll(popupHtml, /data-panel="([^"]+)"/g);
report('data-tab 與 data-panel 一一對應',
  tabs.length > 0 && JSON.stringify(tabs) === JSON.stringify(panels),
  `tabs=[${tabs}] panels=[${panels}]`);

/* ---------------------------------------------- shared.js 匯出函式對照 */

const shared = require(path.join(root, 'shared.js'));
const exported = new Set(Object.keys(shared).filter((key) => typeof shared[key] === 'function' || typeof shared[key] === 'object'));
for (const file of ['popup/popup.js', 'content/panel.js', 'tools/probe.mjs']) {
  const source = read(file);
  const used = new Set(matchAll(source, /\bS\.([A-Za-z0-9_]+)/g));
  const unknown = [...used].filter((key) => !(key in shared));
  report(`${file} 用到的 shared.js 成員都存在`, unknown.length === 0, unknown.join(', '));
}

/* ------------------------------------------------------ manifest 檔案存在 */

const manifest = JSON.parse(read('manifest.json'));
const referenced = new Set([
  manifest.background && manifest.background.service_worker,
  manifest.action && manifest.action.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values((manifest.action && manifest.action.default_icon) || {}),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])])
].filter(Boolean));
const missingFiles = [...referenced].filter((file) => !fs.existsSync(path.join(root, file)));
report('manifest 指到的檔案都存在', missingFiles.length === 0, missingFiles.join(', '));

/* ---------------------------------------------- background 訊息名稱對照 */

const background = read('background.js');
const backgroundTypes = new Set(matchAll(background, /type === '([A-Z_]+)'/g));
const senderFiles = ['popup/popup.js', 'content/panel.js'];
const sentTypes = new Set();
for (const file of senderFiles) {
  for (const type of matchAll(read(file), /type: '([A-Z_]+)'/g)) sentTypes.add(type);
}
const unhandled = [...sentTypes].filter((type) => !backgroundTypes.has(type));
report('前端送出的訊息 background 都有處理', unhandled.length === 0, unhandled.join(', '));

/* ---------------------------------------------------------- 檔案編碼檢查 */

const decoder = new TextDecoder('utf-8', { fatal: true });
for (const file of ['popup/popup.html', 'popup/popup.js', 'popup/popup.css', 'content/panel.js', 'shared.js', 'background.js', '使用說明.md']) {
  const buffer = fs.readFileSync(path.join(root, file));
  let ok = true;
  try { decoder.decode(buffer); } catch (_error) { ok = false; }
  report(`${file} 是有效的 UTF-8`, ok);
}

// PowerShell 5.1 讀「UTF-8 無 BOM」的 .ps1 會用 ANSI 解讀，中文註解會吃掉下一行 → 必須有 BOM
const ps1 = fs.readFileSync(path.join(root, 'tools/make-icons.ps1'));
report('tools/make-icons.ps1 有 UTF-8 BOM（PS 5.1 才不會誤讀中文註解）',
  ps1[0] === 0xEF && ps1[1] === 0xBB && ps1[2] === 0xBF);

console.log(failed === 0 ? '\n介面對照全部通過 ✅' : `\n有 ${failed} 項要修 ❌`);
process.exit(failed === 0 ? 0 : 1);

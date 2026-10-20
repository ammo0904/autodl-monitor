# AutoDL 主機 GPU 監控（免刷新）

Chrome / Brave MV3 擴充套件：在 AutoDL 算力市場頁面上**不必刷新**，直接監控指定主機的空閒 GPU；有空時跳出通知＋響鈴。

- 自動翻頁抓完整主機清單（不依賴目前頁面看得到的那幾台）
- 監控條件、要盯的機型／地區可在 popup 設定
- 背景以 `alarms` 輪詢，`offscreen` 文件負責播放提示音
- 只在 `https://*.autodl.com/*` 生效

## 安裝（開發者模式）

1. 開 `chrome://extensions`（Brave 是 `brave://extensions`）
2. 右上開「開發人員模式」
3. 「載入未解壓縮的擴展」→ 選這個資料夾（含 `manifest.json` 的那一層）
4. 回 AutoDL 頁面按 `F5`

## 檔案

```
manifest.json        MV3 設定（storage/unlimitedStorage/alarms/notifications/offscreen/scripting）
background.js        service worker：輪詢、比對、通知
shared.js            共用邏輯（抓取、解析、條件比對）
content/panel.js     AutoDL 頁面浮動面板
content/panel.css    面板樣式
offscreen.html/js    背景播放提示音
popup/               設定面板（機型、地區、條件）
tools/               開發用驗證腳本（probe.mjs、test-background.mjs、test-shared.mjs、check-ui.mjs、make-icons.ps1）
使用說明.md           完整使用說明與疑難排解
```

## 開發備註

- 抓取走頁面自己的 `/api/v1/user/machine/list`（沿用登入態），分頁 `page_index`／`page_size`
- 後端回傳是 `{code:'Success', data:{list, result_total}}`，翻頁直到湊滿 `result_total`
- 驗證：`node tools/test-shared.mjs`、`node tools/test-background.mjs`（需 node ≥ 20）

## License

MIT

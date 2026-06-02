# 台股技術分析 Agent - 收工紀錄

日期：2026-06-02

## 目前狀態

本次已將台股技術分析 Agent 從單純靜態頁面，調整成 frontend + backend 架構的版本。

目前本地專案已完成下列修正，但尚未重新部署最新版到 AppDeploy，原因是安全審核擋下外部上傳，需要使用者明確同意後才能繼續。

公開線上版目前仍是上一個已通過 QA 的版本：

https://5742beed37784a9389.v2.appdeploy.ai/

## 已完成的本地更新

- `backend/index.ts`
  - 改抓 Yahoo Finance 1 年日線 OHLCV。
  - 以 TWSE MIS 補最新即時價。
  - 後端計算 MA5 / MA10 / MA20 / MA60 / MA120。
  - 後端計算 Bollinger Bands、%B、Bandwidth。
  - 後端計算 RSI14、KD、MACD。
  - 後端計算 20 日與 60 日支撐壓力。
  - 後端計算回檔機率分數。

- `index.html`
  - 前端改讀後端回傳的 `quote.analysis`。
  - 不再用前端代碼種子或推估價格產生技術分析。
  - 圖表渲染改成非阻斷流程：Chart.js 若載入失敗，文字、表格、策略仍會顯示。
  - 移除未驗證的 Elliott / Chan 浪型結論，改成保守的 swing high/low 結構說明。

- `src/main.ts`
  - 使用 AppDeploy client，讓前端符合 AppDeploy 對 backend API 呼叫的規則。

## 未完成

- 最新修正版尚未部署。
- 原因：AppDeploy 上傳本機檔案屬於外部資料匯出，安全審核要求使用者明確同意。
- 下一步：使用者回覆「同意部署到 AppDeploy」後，再送出 `index.html`、`src/main.ts`、`backend/index.ts`、`tests/tests.txt` 並跑 QA。

## 資料源設計

目前採用：

- Yahoo Finance chart API：主要日線 OHLCV，抓 1 年資料。
- TWSE MIS：補最新即時價、開高低、前收、成交量。
- Goodinfo：保留連結作為基本面延伸來源，目前不作為價格主來源。

理由：

- Yahoo / TWSE MIS 對價格與日線較適合。
- Goodinfo 更適合基本面與財報資料，不適合拿來做即時價格主來源。
- TradingView 的使用者提供連結是美股市場頁，若未來要支援美股，需要另做美股 symbol 與交易所資料路徑。

## 踩到的坑

1. 純前端無法穩定抓 Yahoo、TWSE MIS、Goodinfo。

   多數資料源沒有提供可讓任意網站跨網域讀取的 CORS header。直接在瀏覽器 fetch 會被擋，因此必須改成後端 proxy。

2. 不能在資料不足時用假價格補圖。

   前一版抓不到資料時會用代碼種子生成技術情境，這會讓畫面看起來像真實報價，但實際不是。已改成抓不到足夠日線時直接報錯。

3. AppDeploy 要求前端呼叫 backend API 必須用 `@appdeploy/client`。

   直接 `fetch('/api/quote')` 會被 validation 擋下。後來改成在 `src/main.ts` import AppDeploy client，掛到 `window.appApi` 給原本頁面使用。

4. inline module import 容易造成 build 不穩。

   把 `@appdeploy/client` 直接 import 在 `index.html` inline module 裡時，AppDeploy build 沒有給細 logs，較難判斷。後來改成放到 `src/main.ts`，比較符合模板預期。

5. 圖表不能阻斷整份報告。

   Chart.js CDN 若沒載入或某張圖資料異常，不能讓後面的訊號判讀與策略表完全消失。已改成先渲染文字與表格，再嘗試畫圖。

6. 技術說明不能寫沒有演算法支撐的結論。

   未真正實作 Elliott / Chan 演算法時，不應輸出「第 5 波」或「ABC 修正」等具體結論。已改成保守描述：僅用 20/60 日 swing high/low 做結構觀察。

7. Windows/PowerShell 與中文編碼容易造成亂碼。

   部分中文字串在 PowerShell 輸出中顯示為亂碼，後端訊息已盡量改成 ASCII，避免 TypeScript 或部署時出現不可預期的字串問題。

## 待辦

- 使用者同意後部署最新版。
- 部署後檢查：
  - 2330 / 2454 / 0050 是否都能產生完整分析。
  - 價格、MA、Bollinger、支撐壓力圖是否顯示。
  - 若 Chart.js 失敗，文字與策略表是否仍保留。
  - AppDeploy QA 是否 4/4 passed。


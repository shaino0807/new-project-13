# 排行榜資料可信度與 TradingView 採用決策

更新日期：2026-08-12

## 決策

排行榜繼續使用本站可追溯、可版本化的自有評分規則作為唯一排名來源。TradingView 不作為本站排行分數、篩選結果或資料匯入來源；現階段也不嵌入 TradingView Widget。日後若加入 TradingView，限於使用者主動開啟的「人工交叉檢視」外連，且必須先確認交易所對應與當時條款。

## 原因

- TradingView 的股票篩選器可依市場資料、技術指標、財務與股利欄位建立篩選條件，也可儲存個人篩選畫面；這些是使用者端的篩選能力，並不是公開、可重現的本站自有評分公式。[官方篩選器說明](https://www.tradingview.com/support/solutions/43000718866-tradingview-stock-screener-trade-smarter-not-harder/)
- 官方 Widget 文件確實提供 Screener 與 Market Overview，但它們是嵌入式展示元件，不能反映本站的自有權重、資料覆蓋門檻或資料缺漏規則。[官方 Widget 目錄](https://www.tradingview.com/widget/)
- 本次查核時，TradingView 的 Widget 亞洲市場清單列出 TPEx 的延遲股票、指數與期貨資料；同一份清單沒有列出 TWSE。雖然 TradingView 的互動個股頁可找到 TWSE:2330，仍不足以讓 Widget 擔任完整台股榜單的資料面或覆蓋承諾。[Widget 市場清單](https://www.tradingview.com/widget-docs/markets/asia-pacific/)、[TWSE:2330 個股頁](https://www.tradingview.com/symbols/TWSE-2330/)
- TradingView 條款將其市場資料限制於展示用途，明確禁止非展示使用、機器決策、處理其內容，以及未經另行協議的商業 API 使用；因此不可把其排行榜資料重算、抓取或餵入本站評分模型。[條款第 3 節](https://www.tradingview.com/policies/)

## 本站排行榜契約

1. 排名對象是「受控評分批次」，不是全台股即時名次。
2. 每列都顯示評分產生時間、報價日期、資料覆蓋率與資料狀態。
3. 可列入排名至少需要：總分、報價日期、60% 以上資料覆蓋，且沒有已標示的過期資料集。
4. 同分時依序使用資料覆蓋率、報價日期、股票代碼，避免瀏覽器或上游回傳順序影響名次。
5. 資料受限的列可在「包含資料受限列」篩選中檢視，但不給虛構名次。
6. 高信賴度是可列入排名且資料覆蓋率達 85% 以上；它是資料完整度標示，不是投資建議或報酬保證。

## 未來採用門檻

若未來評估 Widget 或商業方案，必須在實作前重新驗證：TWSE 與 TPEx 的資料層級與延遲、可用的元件設定、可否保留 TradingView 歸屬，以及是否取得適當的商業與資料授權。任何取得的第三方資料都必須與本站自有分數分欄呈現，不可混成同一個排行榜分數。

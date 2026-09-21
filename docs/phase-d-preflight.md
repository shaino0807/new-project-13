# Phase D 前置驗證與執行規格

更新：2026-09-21。狀態：本機修復、AppDeploy 部署及 GitHub 提交／推送已執行；pilot 完成兩市場各 120 日歷史及 240 份逐日讀回稽核，評分停在 160/250。FinMind 出現 8 次請求失敗，尚未通過來源驗收；未啟動全市場或排程。Phase D 尚未完成。

## 當日母體與來源

- TWSE 公司資料來源：https://openapi.twse.com.tw/v1/opendata/t187ap03_L ，資料日期 2026-09-18，原始 1,094 筆。
- TPEx 公司資料來源：https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O ，資料日期 2026-09-19，原始 892 筆。
- TWSE 排除 10 筆產業 91 的存託憑證後，普通股為 1,084；TPEx 為 892；合計 1,976。這是上述來源日期的基準，不是固定公司數。
- 四位數、非零開頭、排除 DR／ETF／ETN／受益證券；使用官方公司 profile 端點，不將 FinMind 歷史公司清單併入正式排名。保留 9904 等合法普通股，不能一律排除 9 開頭代碼。
- 舊 FinMind 1,985→1,986 的歷史精確集合差异仍未補證；新的官方基準不冒充舊名單重建。

原始資料、官方母體與容量估計保存在本機 `outputs/phase-d-preflight-20260920/`。日期差異保留在 sourceDates；週末不把下載日冒充來源資料日。

## 本機變更

- 正式 ranking job 使用 `loadOfficialRankingUniverse`。兩市場任一不可用、數量不足、重複代碼、來源日期缺漏／混雜／超過七日／在未來，都拒絕建立評分母體。
- 通用 `/api/universe` 與搜尋仍保留原有 FinMind 相容路徑；正式排名不以該路徑作為在市母體來源。
- schema 升為 `market-features-v7-official-universe`；直接 advance 與建立工作時的重用篩選都檢查 schema、建立時間與七日期限。updatedAt 變新不能讓舊工作重新取得有效期。
- 工作紀錄、每日行情、歷史 profile、特徵與排名／主題 snapshot 共用分片儲存路徑。companyProfiles 固定分片，其他超過 32 KiB 的欄位分片；主紀錄保留引用與進度。單筆限制 240 KiB，多筆寫入同時限制 50 筆及 900 KiB，為 SDK 的 256 KiB 單筆／1 MiB 請求上限預留空間。
- 新分片先寫入並核對回傳 ID，再更新主紀錄；未變更欄位重用原有分片。讀回核對分片順序、欄位與序列化位元組數；引用的歷史／特徵紀錄遺失時中止，不略過後繼續發布。registry 加入大小守門，超限拒絕寫入，不截斷資料。
- 舊 pilot `aa1d12c3-7c2e-4f86-a076-245e9cd33e3f` 唯讀回應仍為 queued/history、0/250、兩市場各 5/120 日；不續跑、不刪除。新規則部署後須建立新工作。

## 驗證

`node scripts/test-phase-d-preflight.mjs` 直接執行後端函式，使用可重現 fixtures 檢查雙市場、动态數量、排序、來源日期、重複碼、非普通股排除、舊工作拒絕、UTF-8 單筆與批次大小。可選參數 `outputs/phase-d-preflight-20260920` 讀取本機官方資料，無網路或遠端写入。

後端語法、前置測試、既有 720 個數值案例、兩個快取來源案例、1,985 檔合成模擬與差異檢查通過。這些不代表真實全市場評分通過。

## 分片與中斷續跑驗證

先前對 1,976 家公司加入簡化行情的 profile-only 估計為 321,185 bytes，超過單筆 256 KiB；本次已以分片引用處理該結構問題。

`node scripts/test-ranking-storage.mjs` 使用正式持久化函式與 advance 狀態機搭配本機資料庫替身，通過 1,976 家及 6,000 家完整 fixture 讀回，以及大型歷史、結果與 snapshot 欄位測試。測得最大單筆 119,623 bytes、最大請求 888,036 bytes；輸出保存在 `outputs/phase-d-preflight-20260920/storage-tests.json`。

分片部分寫入失敗不替換原有主紀錄；分片或必要特徵引用遺失會失敗。進度提交前中斷、提交成功但回應遺失兩種情境均由已持久化 checkpoint 恢復，續跑無重複計數。六榜 snapshot 部分寫入失敗及 pilot 執行都不啟用公開 registry；舊 inline 紀錄仍可讀取。

這是單一工作者的本機中斷模擬，不是遠端容量、配額、延遲或多工作者競態驗證。每欄最多 512 片，讀取時仍會完整還原資料；失敗寫入可能留下未被引用的分片，本次未刪除資料，也未實作回收。registry 成長目前以超限停止保護，尚未加入保留期限管理。Phase D 仍須後續遠端小批寫入／讀回與真實資料驗收。

## 2026-09-20 遠端小批驗證

使用者確認部署與一個歷史批次範圍後，僅更新既有應用的 `backend/index.ts`、`tests/tests.txt`。部署狀態 ready，兩檔遠端原始碼經正規化換行與尾端空白後均與本機一致；公開頁面 HTTP 200，平台 frontend/backend/network 錯誤陣列為空。E2E 為 null，不視為通過。秘密掃描涵蓋已知金鑰樣式、私鑰標記及實際部署金鑰比對，沒有命中，非完整秘密偵測保證。

新工作 `061bba93-70a2-4036-a576-4d2b5eda8a94` 使用 v7 schema，官方母體共 1,976 家，選樣 250 家。setup 四次來源請求成功；只執行一次 history advance，TWSE 與 TPEx 各保存 5/120 日，累計 14 次來源請求成功、零失敗。工作停在 queued/history、0/250 評分，未續跑。

setup 與 history 回應均以另一個 GET 讀回，深層欄位值一致。初版探測誤用 JSON 字串比較，因資料庫欄位順序不同而停止；改為深層比較後沿用同一工作，沒有重建工作或重複推進 history。公開榜單在前後都由既有證據守門拒絕發布；沒有將 pilot 結果發布為正式榜單。

證據位於 `outputs/phase-d-preflight-20260920/` 的 `phase-d-deploy-result.json`、`remote-final-verification.json`、`pilot-setup-readback.json`、`pilot-history-readback.json` 及 `bounded-pilot-result.json`。公開 job API 未曝露原始分片 bytes、母體來源日期／指紋與逐筆歷史內容；管理工具也無資料庫讀取介面。因此此次可確認工作分片成功讀回及歷史保存計數，不能宣稱已直接稽核每筆遠端資料大小或完整歷史內容。

## 2026-09-21 中斷修復與續跑授權

使用者已明確授權直接完成 Phase D、必要部署、精準提交及推送。既有 pilot 自動停止於 history candidate 55，兩市場各 54/120 日；不是使用上限導致資料庫毀損。停止原因是 2026-07-10 休市回應被當成 provider_failure。

已對照 [TWSE 2026 休市表](https://www.twse.com.tw/holidaySchedule/holidaySchedule?response=html) 與 [中央社轉述兩交易所的颱風休市公告](https://www.cna.com.tw/news/afe/202607090360.aspx)，加入明列來源的 2026 已知休市日期。未知日期不推定休市；已知休市不生成行情、不計入交易日數。舊錯誤保留並在公開 job 回應標為 verifiedClosures；後續略過日期記錄為 skippedClosures。這份日期表僅涵蓋 2026 已查證日期，未聲稱自動更新所有年份。

唯讀 storage-audit API 一次核對一份市場日資料及工作分片，檢查實際序列化 bytes、OHLCV 合法性、重複碼、引用完整性、母體來源日期及樣本指紋。初始 10 份市場日稽核通過，當時最大單筆 47,211 bytes。續跑工具逐次 GET 核對 checkpoint，遇未知來源／配額／批次錯誤停止。新執行證據放在 `outputs/phase-d-resume-20260921/`，保留原始中斷目錄。

## 剩餘驗收條件（已授權依門檻執行）

### 本次最終 checkpoint

### FinMind 請求策略修復

後續診斷發現有 Token 時仍先匿名請求，且 runner 使用嘗試失敗總數停止，會把成功重試也當成失敗。前 140 檔 280 次 FinMind 請求；後 20 檔增加 48 次、8 次失敗而全部保存成功，與額外重試吻合。依官方額度規則，匿名額度耗盡是高度疑似原因，但舊紀錄無 HTTP 狀態，不能斷言全部為 402。

修復後 Token 從第一個請求使用；402/429、401/403 不改身分重試，拒絕的 Token 在冷卻期間也不降級匿名。暫時 HTTP 5xx／傳輸錯誤最多再試一次。新增 recoveredFailures、unresolvedFinMind 及最多 40 筆結構化失敗紀錄（dataset、code、status、kind、authenticated），不含 Token 或原始錯誤內容。runner 區分已恢復嘗試與未解決資料集；HTTP 200 內含錯誤狀態也會阻擋。舊的未分類失敗不清零，仍需補證再續跑。

`node scripts/test-finmind-recovery.mjs` 以正式請求與合併函式、模擬傳輸驗證八種情境；既有 720 個數值案例、快取讀回及儲存測試通過。這不是 Token 方案額度或全市場資料驗收的證明。

- 同一 pilot `061bba93-70a2-4036-a576-4d2b5eda8a94` 完成 TWSE 120/120、TPEx 120/120。240 份市場日逐筆通過 OHLCV、重複碼、分片與實際序列化大小稽核，該輪最大單筆 47,211 bytes。
- 250 檔中 245 檔至少 60 日、192 檔完整 120 日。已處理 160 檔、保存 158 檔特徵、2 檔未保存。未完成全部評分或六榜驗收。
- 累計 FinMind 請求 328 次，HTTP/傳輸失敗計數 8；自動工具立即停止。這是請求層計數，不能推定為八檔股票失敗，也不能判定全是限流。舊紀錄未保存逐次 HTTP 原因，故無法還原確切失敗種類。它也不等同最終 provider_failure 股票分類。
- 唯讀 `feature-audit?batchKey=features-140` 證實該批 20 檔特徵完整讀回，最大單筆 49,155 bytes、4 片。既有 warnings 為空、部分資料来自官方備援；這不足以抵銷未釐清的請求異常。此診斷不新增上游請求，也不修改資料。
- 未啟用任何 pilot 排名、全市場工作或每日排程。下一步需先補齊來源失敗診斷與確認可用性，再續跑剩餘 90 檔及六榜驗收；不能透過放寬必要欄位或合成資料通關。
- 本機證據：`outputs/phase-d-resume3-20260921/audit-240-days.json`、`provider-diagnostics.json`、`stop.json` 與逐次 POST/GET checkpoint。原始錯誤、補抓、休市及 504 證據均保留。

續跑時另修復兩項實際問題：TPEx HTTP 回應中途斷線／逾時，及五日期批次觸發 API 504。新增 `retry-history` 只補抓已記錄的失敗日期，每 key 最多兩次；成功持久化並讀回才解決錯誤，保留 resolvedHistoryErrors，配額失敗不自動重試。歷史批次縮為一個日期、兩市場，每次來源請求上限八秒。已保存 market/date 紀錄重用，測試確認不重複計數。再次使用上限中斷時，工作已保存到 candidate 92、兩市場各 90/120 日，無未解決 historyErrors/batchErrors；沒有殘留本機續跑程序。

第一筆程式提交 `ad0ac75` 已推送 main，GitHub Actions `35522621947` build/deploy 成功；GitHub Pages 與 AppDeploy 都 HTTP 200。後續復原修復及最終 pilot 結果另列後續提交，不將此工作中紀錄當成 Phase D 完成證明。

1. 補足受限的遠端儲存稽核：可觀察母體來源日期／指紋、分片 bytes 與歷史讀回完整性，避免以公開進度計數替代底層驗證。
2. 再決定是否續跑同一個仍有效的新 pilot；若 schema 或建立時間失效則建立新工作，不續跑舊 schema 工作。
3. 完整 pilot：每批最多 20 檔、併發 4，最多 90 分鐘；遇配額、容量、schema 或日期異常停止，不無限重試。公開排名不得被 pilot 啟用。
4. 驗收至少 95% 建檔成功、零 provider_failure/unresolved、六榜必要欄位與 Top 64 截止稽核，以及至少 60 日真實歷史；120 日倉庫目標另列完成比例。
5. pilot 通過才提出全市場離峰工作配置與請求／時間預算。全市場完成後才驗證正式 snapshot 啟用和每日更新；首頁讀取不觸發重算。
6. GitHub 提交／推送、AppDeploy 更新、全市場啟用及每日排程均在各自明列的授權範圍內執行。Phase D 完成須具備真實資料驗收與發布證據，不能以本機 PASS 代替。

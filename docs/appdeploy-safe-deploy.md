# AppDeploy 安全部署流程

此流程用低記憶體 Node worker 取代 Windows PowerShell 5.1 的大型 multipart／深層 JSON 序列化。PowerShell 只負責啟動 worker，不讀取檔案內容、不保留上傳回應。

## 安全限制

- Node heap 上限：256 MB。
- 單次 HTTP 請求有明確逾時；整體流程預設最多 15 分鐘。
- `.appdeploy`、`.env*`、`secrets.*` 不可部署。
- `deploy` 模式必須明確列出真正變更的檔案，禁止預設重送整個專案。
- 更新前先取得 AppDeploy 指示、確認 app、檢查遠端來源標記。
- 部署後每五秒輪詢，直到 `ready`、`failed` 或 `deleted`。
- `ready` 後仍檢查錯誤陣列，並探測公開 HTML 與 `/api/macro-risk-scan`。
- worker 成功或失敗後都以明確 exit code 結束，不保留背景 PowerShell。

## 這次踩到的坑

- Windows PowerShell 5.1 用 `ConvertTo-Json` 建立大型或深層 payload，再交給 `.NET MultipartFormDataContent` 同步送出時，可能在本機持續配置記憶體；即使沒有對外 TCP 連線，也不代表命令已經正常完成。
- 本次兩個卡住的 PowerShell 各自占用約 53–55 GB 私有記憶體，但待傳檔案合計不到 1 MB。判斷部署是否仍在工作，不能只看程序還存在，必須一起看 TCP、子程序、CPU、記憶體走勢與遠端狀態。
- 終止已無網路連線、沒有子程序且遠端服務仍為 `ready` 的卡死上傳程序，不會刪除既有網站或資料；風險是該次尚未完成的部署不會生效，因此終止前後都要重新確認遠端版本與公開服務。
- `.appdeploy` 可能帶有 UTF-8 BOM；直接 `JSON.parse` 會失敗，讀取後必須先移除 BOM。同時不可把該檔案、API key 或其他秘密輸出到紀錄或提交到 Git。
- AppDeploy 明確要求不要重送未變更檔案。沒有原始碼變更時，只能做 `dry-run` 或 `transport-test`，不應呼叫 `deploy_app` 製造無意義版本。
- `ready` 不是唯一完成條件。還要驗證 E2E、前後端及 QA 錯誤陣列、公開首頁與 API，而且 worker／PowerShell 必須確實退出。
- PowerShell 僅適合作為薄啟動器；實際序列化、multipart、逾時與輪詢交給有 heap 上限的 Node worker，才能避免部署命令成功後仍殘留高記憶體程序。

## 指令

唯讀檢查本機檔案與遠端 app：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\appdeploy-safe-deploy.ps1 -Mode dry-run
```

只測試真實 upload slot 與 multipart 傳輸，不部署新版本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\appdeploy-safe-deploy.ps1 -Mode transport-test
```

有實際變更時，精準列出檔案並部署：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\appdeploy-safe-deploy.ps1 -Mode deploy -Files index.html,backend/index.ts,tests/tests.txt -ConfirmChangedFiles
```

若只有單一檔案變更，只傳該檔案：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\appdeploy-safe-deploy.ps1 -Mode deploy -Files index.html -ConfirmChangedFiles
```

## 完成判定

只有同時滿足下列條件才算完成：

1. worker exit code 為 0。
2. AppDeploy 狀態為 `ready`。
3. AppDeploy 前端、後端、QA 網路錯誤陣列皆空。
4. 公開首頁包含 `workspaceTabRisk`。
5. 公開總經 API 回傳 `macro-risk-scan-v2`。
6. `appdeploy-safe-deploy.mjs` 與其啟動 PowerShell 都已退出。

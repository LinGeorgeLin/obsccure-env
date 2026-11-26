# Obsccure Env Guard

> **VS Code 擴充套件：把 `.env` 加密並偽裝成無害檔案，保護機密不被 AI Agent 與自動化掃描器讀取。**

專案根目錄的 `.env` 是明文，會被檔案掃描器、git 自動提交或 AI 輔助工具讀走。這個擴充套件把它加密後偽裝成 PNG 圖片、系統日誌或二進位檔案，並接上 VS Code 的生命週期。

---

## ✨ 特色

- 🎭 **偽裝存檔**：密文包裝成合法 PNG 圖片 / Log 日誌 / BIN 二進位檔，躲過關鍵字掃描器。
- 🔒 **AES-256-GCM**：100,000 次 PBKDF2 密鑰衍生，GCM 認證標籤會直接否決錯誤金鑰，不會回傳亂碼。
- 🔄 **換外殼不換金鑰**：轉換偽裝格式時沿用同一份密文，舊金鑰仍然有效。
- 🚪 **生命週期自動化**：開啟專案自動解密、離開視窗時詢問封存、關閉視窗時自動封存。
- 📦 **免設定**：核心已內建於套件中，裝完即可用。
- 🧹 **自動維護 `.gitignore`**：把 `.env` 與各種保管檔自動加進 `.gitignore`。

---

## 📦 保管檔格式

| 格式 | 檔名 | 外觀 | 說明 |
| :--- | :--- | :--- | :--- |
| `png`（預設） | `verify.png` | 真實雜訊圖片 | 框架附在 PNG 的 IEND 之後 |
| `log` | `verify.log` | 純文字雜訊行 | 適合純文字環境 |
| `bin` | `vault.bin` | 隨機二進位位元組 | 框架埋於其中 |
| `plain` | `verify.txt` | 裸 JSON | 純密文路線，與 CLI 相容 |

**格式一律依「檔案內容」辨識，不看副檔名。** 同一個檔名在不同情況下可能是不同格式 —— 只有內容說得準。

---

## ⚡ 指令

| 指令 | 功能 |
| :--- | :--- |
| `Obsccure Env: Encrypt .env (純密文 verify.txt)` | 把 `.env` 加密為 `verify.txt` 並刪除明文 |
| `Obsccure Env: Restore .env (純密文 verify.txt)` | 把 `verify.txt` 解密還原為 `.env` |
| `Obsccure Env: 封存為偽裝格式 (png / log / bin)` | 把 `.env`（或純密文 `verify.txt`）轉為偽裝檔 |
| `Obsccure Env: 從偽裝保管檔還原 .env` | 從偽裝保管檔解密還原 `.env`，並移除該保管檔 |
| `Obsccure Env: 轉換偽裝格式 (換外殼不換金鑰)` | 在 png / log / bin 之間轉換，密文與金鑰不變 |
| `Obsccure Env: Show Status Hint` | 顯示目前防護狀態摘要 |

所有指令也可從右鍵選單或命令面板（`Cmd+Shift+P`）呼叫。右下角狀態列會直接顯示目前狀態並可點擊操作。

> 偽裝路線的還原**只需點一下** —— 只有一個保管檔時直接解密，不會跳出選擇清單。純密文路線的 `verify.txt` 則會保留，作為受保護的副本。

---

## ⚙️ 設定

| 設定鍵 | 預設 | 說明 |
| :--- | :--- | :--- |
| `obsccureEnv.corePath` | `""` | 核心資料夾的本機路徑。**一般不需要設定** —— 套件已內建核心；只有在使用外掛核心版本時才需填入。 |
| `obsccureEnv.camouflageFormat` | `"png"` | 偽裝路線的外殼格式（`png` / `log` / `bin`）。封存、以及「轉換偽裝格式」都以它為準。 |
| `obsccureEnv.autoDecrypt` | `false` | 開啟專案時若偵測到未解密的偽裝文件，直接解密還原 `.env`，不再詢問。 |
| `obsccureEnv.autoEncrypt` | `false` | 完全自動模式：視窗離開焦點時不再詢問，直接封存為偽裝格式。 |
| `obsccureEnv.sealOnClose` | `"prompt"` | 視窗真正關閉時的處置策略 —— 詳見下方「關窗前封存是怎麼運作的」。 |

### `sealOnClose` 的三種模式

| 值 | 行為 |
| :--- | :--- |
| `prompt`（預設） | 視窗關閉時若偵測到 `.env` 就直接封存；但若你在詢問時明確按了「取消」，則保持 `.env` 原狀。 |
| `always` | 視窗關閉時一律封存 `.env`，即使先前按過「取消」也照封。 |
| `never` | 視窗關閉時完全不動 `.env` —— 只有手動執行「封存」指令才會轉換。 |

---

## 🔑 金鑰

**加密時**使用的金鑰依序取自：環境變數 `OBSCURE_KEY` → 預設值 `local-device-secret`。

**還原時**則會逐一嘗試完整候選鏈（`OBSCURE_KEY` → 預設值 → 裝置指紋 → 系統預設鹽），因此即使換了金鑰來源，先前封存的檔案仍可解開。

> 想讓檔案離開這台機器就無法解密，可參考核心專案的 Device Binding（裝置指紋）功能。

---

## 📁 檔案放哪

加密後的檔案會留在**專案根目錄**：

```text
my-project/
├── .env              ← 明文（封存後會被移除）
├── verify.png        ← 偽裝保管檔（或 verify.log / vault.bin / verify.txt）
└── .gitignore        ← 自動加入 .env 與保管檔
```

---

## 🚪 關窗前封存是怎麼運作的

VS Code **沒有**「視窗即將關閉」的公開 API —— 實測 VS Code 1.147.0 的結果：

| 做法 | 能不能用 |
| :--- | :--- |
| `vscode.env.onWillShutdown` | **不行** —— 不在公開 API（`vscode.d.ts` 零命中）。執行期雖存在，但主執行緒把它接在 `powerService` 上，只在「系統關機／登出」時觸發；而且不帶參數、沒有 `waitUntil`，無法暫停關閉流程來等回應。 |
| `deactivate()` | 關窗時**必定**執行，且有 5 秒等待窗口 —— 但那時視窗正在消失，提示送不出去。 |
| `vscode.window.onDidChangeWindowState` | **可以** —— 公開 API，能正常顯示提示並等待回應。 |

所以這個擴充套件用兩段式處理：

1. **視窗失去焦點時**（切去別的 app、或正要關視窗都會先經過這個狀態）→ 跳出詢問：**轉換 / 取消 / 完全自動（不再詢問）**。這時視窗還活著，提示看得見、也等得到回應。
2. **視窗真正關閉時** → `deactivate()` 接手。這時沒有 UI，只能直接封存，策略由 `sealOnClose` 決定。

封存完成後會標記起來，後續路徑不會重複動手。

---

## ❓ 常見問題

**Q: 擴充套件怎麼找到核心的？**
A: 依序搜尋：`corePath` 設定值 → 擴充套件資料夾本身（內建核心）→ 上層目錄 → 目前開啟的專案 → 專案的 `node_modules/obscure-env`。正常安裝後會命中第二項。

**Q: 我不喜歡它每次切出去都跳提示。**
A: 把 `obsccureEnv.autoEncrypt` 設成 `true`（完全自動，不跳提示），或把 `obsccureEnv.sealOnClose` 設成 `never`（關窗時也不動）。前者會在視窗失焦時直接封存，後者則完全交由你手動執行封存指令。

**Q: 關閉 VS Code 時沒封存成功怎麼辦？**
A: 封存失敗會保持 `.env` 原狀 —— 這是刻意的「安全的失敗」，寧可留著明文也不要弄丟資料。再次開啟專案後手動執行封存指令即可。

**Q: 純密文 `verify.txt` 會被誤認成 log 偽裝檔嗎？**
A: 不會。格式依內容辨識：純密文必須具備 `{s,i,t,d}` 完整 JSON 形狀才會被判定為 `plain`。

---

## 🔗 相關連結

- 核心專案：`obscure-env/`（Node.js CLI 版，功能更完整，支援 preload 自動載入）
- 架構說明：[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md)
- 測試說明：[../docs/TESTING.md](../docs/TESTING.md)

# obscure-env 🛡️

> **防範 AI Agent 與自動化掃描器的環境變數加密與偽裝載入器**
>
> 明文 `.env` 極易被自動化 Agent 掃描、讀取或誤傳至外部。`obscure-env` 在硬碟上將 `.env` 加密並偽裝成無害檔案（PNG 圖片、系統日誌或二進位檔），並在 Node.js 啟動的瞬間於記憶體內解密注入 `process.env` —— 零明文存檔、零程式碼侵入。

---

## 🌟 核心特色

- 🔒 **高強度 AES-256-GCM 加密**：採用 100,000 次 PBKDF2 密鑰衍生與 GCM 認證標籤，保障資料不可篡改與不可明文讀取。
- 🎭 **靜態檔案隱碼偽裝 (Camouflage)**：支援將密文包裝為符合規範的 PNG 圖片、Log 系統日誌或 BIN 二進位檔，徹底躲過關鍵字掃描器。
- ⚡ **零程式碼改動預載入 (Zero-Code Preload)**：支援 Node.js `-r` 參數，無需在專案業務程式碼中編寫任何載入邏輯。
- 💻 **本機裝置綁定 (Device Binding)**：可自動結合網卡 MAC 位址與主機名稱生成獨特指紋金鑰，離機即無法解密。
- 🛡️ **安全記憶體管理**：解密後自動抹除環境變數中的金鑰，緩衝區用畢即清，防止二次洩漏。
- 📦 **零第三方套件依賴**：100% 基於 Node.js 原生內建模組 (`crypto`, `zlib`, `fs`, `os`, `path`, `http`) 實作。

---

## 🚀 快速開始

### 1. 安裝與準備

```bash
npm install obscure-env
```

### 2. 將明文 `.env` 加密並偽裝

```bash
# 預設加密並偽裝成 PNG 圖片 (verify.png)
npx obscure-env

# 指定自訂金鑰與偽裝格式 (支援 png / log / bin / plain)
npx obscure-env --secret "my-custom-key" --format png
```

| 偽裝格式 (`--format`) | 輸出檔案 | 外觀與特性 |
| :--- | :--- | :--- |
| **`png`** (預設) | `verify.png` | 真實 PNG 圖片規格，圖片檢視器可開啟，資料附於 `IEND` 區段後 |
| **`log`** | `verify.log` | 偽裝成幾十行 `#` 開頭的系統十六進位日誌 |
| **`bin`** | `vault.bin` | 隨機二進位點陣資料 |
| **`plain`** | `verify.txt` | 原始 CLI 相容 JSON 格式（無外殼） |

> **格式一律依「內容」辨識，不看副檔名。** 同一個檔名在不同情況下可能是不同格式 —— 例如舊版的 `log` 格式寫在 `verify.txt`，但它其實是偽裝檔而不是純密文；`verify.txt` 也可能是純 JSON。載入器與所有工具都以內容為準，因此改名或混用都不會出錯。
>
> 掃描目錄找保管檔時的候選檔名依序為：`verify.png`、`verify.log`、`vault.bin`、`verify.txt`、`.env.vault`。

**CLI 完整選項：**

| 選項 | 說明 | 預設值 |
| :--- | :--- | :--- |
| `--in <路徑>` | 輸入的明文 `.env` 檔 | 當前目錄的 `.env` |
| `--out <路徑>` | 輸出的保管檔路徑 | 依格式決定（見上表） |
| `--format <格式>` | 偽裝格式：`png` / `log` / `bin` / `plain` | `png` |
| `--secret <金鑰>` | 加密金鑰 | `OBSCURE_KEY` 環境變數，其次 `local-device-secret` |

> 加密完成後原始 `.env` 會被自動刪除，確保目錄中不留下明文機密檔。若輸出路徑與輸入路徑相同則不會刪除。

---

### 2-1. 還原與格式轉換

```bash
# 還原保管檔為 .env（未指定 --in 時會依內容自動偵測目錄內的保管檔）
npx obscure-env decrypt --in verify.png --secret "my-custom-key"

# 還原到指定的 .env 路徑
npx obscure-env decrypt --in verify.png --env-out .env --secret "my-custom-key"

# 換一個外殼：同一份密文重新包裝，不重新加密，原本的金鑰仍然有效
npx obscure-env convert --in verify.png --format bin
```

三個子指令：

| 指令 | 說明 |
| :--- | :--- |
| `encrypt` | 加密 `.env` 為偽裝保管檔，並刪除明文 |
| `decrypt` | 還原偽裝保管檔為 `.env`（四種格式皆可） |
| `convert` | 同一份密文換一個外殼（**不重新加密，舊金鑰仍然有效**） |

`decrypt` 的參數：

| 選項 | 說明 | 預設值 |
| :--- | :--- | :--- |
| `--in <路徑>` | 要還原的保管檔 | 依內容自動偵測 |
| `--out <路徑>` | 還原後 `.env` 的路徑（若該路徑本身是保管檔則視為來源） | 當前目錄的 `.env` |
| `--env-out <路徑>` | 明確指定還原後 `.env` 的路徑 | 當前目錄的 `.env` |
| `--secret <金鑰>` | 解密金鑰 | 依候選鏈逐一嘗試 |

> **安全保險：** `decrypt` 絕不會把明文寫在保管檔上。若輸出路徑與來源相同，指令會直接中止並保留原始密文。

---

### 3. 啟動 Node.js 應用程式

在啟動您的業務程式時加入 `-r obscure-env/register` 參數：

```bash
# 1. 搭配自訂金鑰啟動
OBSCURE_KEY="my-custom-key" node -r obscure-env/register app.js

# 2. 或直接啟動（自動套用預設金鑰 / 裝置指紋）
node -r obscure-env/register app.js
```

**業務程式碼 (`app.js`) 範例：**

```javascript
// 不需要任何 require('obscure-env')
console.log(process.env.DATABASE_URL); // 已自動注入解密後的環境變數
console.log(process.env.API_KEY);
```

---

## ⚙️ 進階配置與選項

除了使用 `-r` 自動預載外，您也可以在程式碼中手動引進與設定：

```javascript
const { config } = require('obscure-env');

const result = config({
  file: './my-custom-vault.png', // 指定保管檔路徑
  secret: 'my-custom-key',       // 明確指定金鑰
  overwrite: false,              // 是否覆蓋已有環境變數
  strict: false,                 // 失敗時是否拋出例外中止進程
  silent: false,                 // 是否隱藏載入成功日誌
});

console.log(result);
// Output: { ok: true, file: '...', format: 'png', loaded: { ... }, skipped: 0 }
```

---

## 🏗️ 系統架構與防禦原理

```text
  [ 硬碟上的偽裝檔 (.png / .txt / .bin) ]
                    │
                    ▼  (1) 讀取檔案與識別外殼 (src/camouflage/)
       剝離 PNG/LOG/BIN 外殼與 Frame 結構校驗 (Magic Header & SHA-256)
                    │
                    ▼  (2) 還原 Base64 加密 JSON { s, i, t, d }
                    │
                    ▼  (3) 多重金鑰嘗試鏈 (src/index.js)
        OBSCURE_KEY ➔ 本機裝置指紋 (MAC+Hostname) ➔ 預設金鑰
                    │
                    ▼  (4) 記憶體內 AES-256-GCM 解密 (src/crypto.js)
        通過 GCM 認證標籤 (authTag) 校驗並還原明文
                    │
                    ▼  (5) .env 語意解析與注入 (src/parse-env.js)
        解析鍵值對、處理引號與轉義 ➔ 注入 process.env ➔ 抹除記憶體金鑰
```

### 三種偽裝格式機制

1. **PNG 圖片偽裝 (`png`)**：
   依據 PNG ISO 規格，圖檔解碼器在讀取到 `IEND` (Image End Chunk) 後即會停止解析。`obscure-env` 在前方構建真實的 128x128 像素與防護 Chunk 後，將加密框架附於 `IEND` 之後。一般圖片檢視器能正常開啟圖檔，`file(1)` 命令亦判定為合法 PNG。
2. **系統日誌偽裝 (`log`)**：
   模擬標準伺服器排程日誌，生成多行 `#` 開頭的十六進位雜訊，並將加密標記行與 Base64 負載夾帶於隨機行數中。預設寫在 `verify.log`。
3. **二進位亂數偽裝 (`bin`)**：
   在加密框架前後填充隨機位元組（Entropy Padding），使整個檔案展現無規律的高熵特徵。

---

## 🧩 VS Code 擴充套件

擴充套件位於 `vscode-extension/`，把偽裝路線接上 VS Code 的生命週期：**關閉前自動封存、開啟後自動還原**。

### 兩條路線的分工

| 路線 | 檔案 | 觸發方式 | 加密核心 |
| :--- | :--- | :--- | :--- |
| **純密文** | `verify.txt`（裸 JSON） | 手動執行指令 | `src/crypto.js` |
| **偽裝** | `verify.png` / `verify.log` / `vault.bin` | 生命週期自動 + 手動指令 | `src/crypto.js` + `src/camouflage/` |

兩條路線共用同一把 AES-256-GCM 金鑰與同一份密文，差別只在「要不要套偽裝外殼」，因此**轉換格式不需要重新加密，原本的金鑰仍然有效**。

### 指令

| 指令 | 說明 |
| :--- | :--- |
| `Obsccure Env: Encrypt .env (純密文 verify.txt)` | 純密文路線（既有功能） |
| `Obsccure Env: Restore .env (純密文 verify.txt)` | 純密文路線（既有功能） |
| `Obsccure Env: 封存為偽裝格式 (png / log / bin)` | 把 `.env` 或純密文 `verify.txt` 封存成偽裝檔 |
| `Obsccure Env: 從偽裝保管檔還原 .env (還原後刪除保管檔)` | 從偽裝保管檔還原 `.env`，**並一併刪除該保管檔** |
| `Obsccure Env: 轉換偽裝格式 (換外殼不換金鑰)` | 在 png / log / bin 之間互換 |
| `Obsccure Env: Show Status Hint` | 顯示目前防護狀態摘要 |

> **偽裝路線的還原只需點一下**：只有一個偽裝保管檔時，點「還原」直接解密，不會跳出選擇清單。還原成功後偽裝保管檔會一併刪除（與封存方向對稱：封存會移除 `.env`，還原就會移除保管檔）。純密文路線的 `verify.txt` 則**保留**作為受保護的副本。

### 生命週期行為

VS Code **沒有**「視窗即將關閉」的公開 API —— `vscode.env.onWillShutdown` 執行期雖存在，但主執行緒把它接在 `powerService` 上，只在系統關機／登出時觸發，且不帶參數、沒有 `waitUntil`。因此擴充套件改用兩段式處理：

| 時機 | 行為 |
| :--- | :--- |
| **視窗失去焦點** | 詢問「是否將 `.env` 轉換為偽裝檔？」—— 這時視窗還活著，提示看得見、也等得到回應。選項：轉換 / 取消 / 完全自動（不再詢問） |
| **視窗關閉** | 由 `deactivate()` 保證封存 —— 這時沒有 UI，只能直接封存，策略由 `sealOnClose` 決定 |
| **開啟專案** | 偵測到未解密的偽裝文件時詢問「是否解密還原為 `.env`？」 |

### 設定項目

| 設定 | 型別 | 預設 | 說明 |
| :--- | :--- | :--- | :--- |
| `obsccureEnv.camouflageFormat` | `png` / `log` / `bin` | `png` | 偽裝路線使用的外殼格式 |
| `obsccureEnv.autoDecrypt` | boolean | `false` | 開啟專案時自動解密偽裝文件 |
| `obsccureEnv.autoEncrypt` | boolean | `false` | 完全自動模式：視窗離開焦點時不再詢問，直接封存 |
| `obsccureEnv.sealOnClose` | `prompt` / `always` / `never` | `prompt` | 視窗真正關閉時的封存策略（見下表） |
| `obsccureEnv.corePath` | string | `""` | obscure-env 核心資料夾的本機路徑。**一般不需要設定** —— 擴充套件已內建核心 |

`sealOnClose` 的三種模式：

| 值 | 行為 |
| :--- | :--- |
| `prompt`（預設） | 視窗關閉時若偵測到 `.env` 就直接封存；但若你在詢問時明確按了「取消」，則保持 `.env` 原狀 |
| `always` | 視窗關閉時一律封存 `.env`，即使先前按過「取消」也照封 |
| `never` | 視窗關閉時完全不動 `.env` —— 只有手動執行「封存」指令才會轉換 |

> 提問框上的「完全自動（不再詢問）」與「以後自動解密」按鈕會直接寫入對應設定，不需要手動去設定面板改。

---

## 🧪 測試與驗證

### 單元與整合測試 (131 項斷言)

```bash
npm test
```

| 測試檔 | 斷言數 | 涵蓋範圍 |
| :--- | :--- | :--- |
| `test/integration.js` | 32 | 載入器語義、注入行為、竄改防護、錯誤金鑰、誘餌檔、搜尋順序、strict 模式 |
| `test/formats-check.js` | 38 | 四種偽裝格式的外觀、權限、明文外洩檢查、完整往返一致性 |
| `test/extension-lifecycle.js` | 61 | 擴充套件生命週期：視窗失焦詢問、`sealOnClose` 三種模式、關窗封存、覆寫保護 |

只想單獨驗證偽裝格式：`npm run test:formats`
只想單獨驗證擴充套件：`npm run test:extension`

### 偽裝路線的端對端測試

偽裝路線（png / log / bin）與生命週期功能的完整驗證放在 `test-project/`：

```bash
cd ../test-project
npm install
npm test
```

| 測試區塊 | 涵蓋範圍 |
| :--- | :--- |
| 四種格式往返 | png / log / bin / plain 的 CLI 加密與解密、權限 0600、明文外洩檢查 |
| 格式轉換 | 同一份密文在 png → bin → log 之間互換，密文逐字相同、舊金鑰仍然有效 |
| 錯誤金鑰與損毀檔案 | 失敗時退出碼非 0、既有 `.env` 不被覆寫、保管檔完好 |
| 兩條路線互不干擾 | 純密文 `verify.txt` 仍辨識為 `plain`，偽裝檔仍辨識為 `png` |
| 依內容辨識 | 檔案改名成 `.dat` 後仍可解密；CLI 的 log 檔即使叫 `verify.txt` 仍辨識為 `log` |
| decrypt 資料保護 | 保管檔不會被明文覆寫、輸出與來源同路徑時直接中止 |
| 自動載入 | 擴充套件的 `verify.log` 可被載入器在未指定檔名時找到 |

> 測試全程在系統暫存目錄操作，`test-project` 自己的 `.env` 只會被讀取作為測試素材，不會被刪除或覆寫。

### 示範服務與進階文件

```bash
npm run demo
```

*啟動後存取 `http://127.0.0.1:8787`，可觀察在進程中解密注入後，網頁端如何僅顯示安全遮罩預覽。*

- [docs/TESTING.md](docs/TESTING.md) —— 5 步驟完整實機操作、錯誤金鑰與 strict 模式驗證、故障排除對照表
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— `src/crypto.js` 如何與模組 3、模組 4 串接

---

## 📄 授權條款

[MIT License](LICENSE)

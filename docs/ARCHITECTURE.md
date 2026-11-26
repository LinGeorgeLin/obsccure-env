# obscure-env 架構說明

本文件說明 `src/crypto.js`（密碼學核心）與模組 3（運行期載入器）、模組 4（靜態檔案偽裝）之間的合作關係。

---

## 一、整體數據管線

```text
  [ 硬碟上的保管檔 (PNG / LOG / BIN / 純 JSON) ]
                    │
                    ▼  模組 4：src/camouflage/
      讀取檔案 → 辨識外觀 → 校驗 Frame 結構 → 剝離外殼
                    │
                    ▼  產出：crypto.js 原生的 JSON 字串 {"s":"...","i":"...","t":"...","d":"..."}
                    │
                    ▼  模組 3：src/index.js
      產生金鑰候選鏈 → 逐一嘗試解密
                    │
                    ▼  呼叫 crypto.js 的 decryptEnv(jsonString, secretKey)
         [ src/crypto.js：AES-256-GCM 記憶體解密 ]
                    │
                    ▼  產出：明文 .env 字串
                    │
                    ▼  模組 3：src/parse-env.js
      解析鍵值對語意 → 注入 process.env → 抹除金鑰與中間緩衝
```

---

## 二、各模組的職責邊界

### src/crypto.js（唯一的密碼學核心）

這個檔案**完全不需要知道**外層偽裝格式的存在，也不需要知道 Node.js 的 preload 機制。它只負責兩件事：

* `encryptEnv(rawEnvContent, secretKey)`：把明文 `.env` 內容加密成一段標準 JSON 字串。
* `decryptEnv(packedContent, secretKey)`：把那段 JSON 字串還原成明文。

輸出格式固定為四個欄位：

| 欄位 | 意義 |
| :--- | :--- |
| `s` | salt（PBKDF2 鹽值，Base64） |
| `i` | iv（初始向量，Base64） |
| `t` | authTag（GCM 認證標籤，Base64） |
| `d` | d（密文，Base64） |

金鑰衍生方式為 `PBKDF2(userSecret, salt, 100000, 32, 'sha256')`。

---

### 模組 4：src/camouflage/（偽裝外殼）

職責是「幫加密後的 JSON 穿衣服，以及脫衣服」。

**寫入方向（加密）**

1. `crypto.js` 產生標準的 `{s, i, t, d}` JSON 字串。
2. 模組 4 將這段字串包進自訂 Frame 結構：`8 位元組隱蔽 Magic Header + 4 位元組長度 + 負載 + 32 位元組 SHA-256 校驗`。
3. Frame 再依指定格式嵌入 PNG / LOG / BIN 外殼，寫入磁碟，權限設為 `0600`。

**讀取方向（解密）**

1. `readVault()` 讀檔，呼叫 `unpack()` 判斷外觀。
2. 偵測順序為：純 JSON → PNG → 文字雜訊 → 二進位框架。
3. 剝除外殼並驗證 Frame 的 SHA-256 校驗，通過後還原出 `crypto.js` 能識別的 JSON 字串。

**關鍵設計**：偽裝層從不改變密文的任何一個位元組。它只決定「檔案看起來像什麼」，因此三種偽裝格式之間可以自由互換，同一份密文可以包成 PNG 也可以包成 LOG。

---

### 模組 3：src/index.js（運行期載入器）

職責是管理 Node.js 啟動瞬間的完整生命週期：定位檔案、準備金鑰、處理失敗、注入 `process.env`。

**金鑰候選鏈**

`resolveSecretCandidates()` 依序產生候選金鑰，去重後交給 `decryptVault()` 逐一嘗試：

1. 呼叫端明確傳入的 `secret`
2. `OBSCURE_KEY` 環境變數（CLI 的慣例）
3. `local-device-secret`（CLI 的預設金鑰）
4. 裝置指紋（含 MAC 位址）
5. 裝置指紋（不含 MAC，網路介面變動時的退路）
6. `default-system-salt`（`crypto.js` 的預設參數）

**為什麼可以安全地逐一嘗試？**

這是 `crypto.js` 使用 AES-256-GCM 認證加密的好處。金鑰錯誤時，認證標籤校驗會直接失敗並拋出例外，**絕不會返回一段看似合理但實際上是亂碼的結果**。因此載入器可以放心地把多個候選金鑰逐一試過去，錯的全被 GCM 標籤否決，唯一的正解才會通過。

**載入流程**（`config()`）

1. 定位保管檔：明確參數 → `OBSCURE_ENV_FILE` 環境變數 → 預設搜尋清單 `verify.txt`、`verify.png`、`.env.vault`、`vault.bin`。
2. 呼叫 `readVault()` 讀取並解除偽裝。
3. 呼叫 `decryptVault()` 在記憶體內解密。
4. 抹除 `process.env.OBSCURE_KEY`（除非設定 `OBSCURE_KEY_KEEP=1`）。
5. 呼叫 `parseEnv()` 解析，再注入 `process.env`；預設不覆蓋已存在的變數（與 dotenv 行為一致）。

**容錯語義**

找不到檔案或解密失敗時，預設只印出 `❌ [obscure-env] ...` 提示而不中斷宿主程式；設定 `OBSCURE_ENV_STRICT=1`（或傳入 `strict: true`）則改為直接拋錯，讓進程以非零狀態碼結束。

---

## 三、偽裝格式的機制細節

### PNG 圖片偽裝

依 PNG 規格，解碼器讀到 `IEND`（Image End Chunk）後即停止解析，其後的位元組一律忽略。`obscure-env` 因此在前方建構真實的 128x128、8-bit truecolor 圖片，包含：

* 8 位元組 PNG 簽章
* IHDR 區塊（寬高、位元深度、色彩型別）
* IDAT 區塊（`zlib.deflateSync` 壓縮的隨機像素，每條掃描線前綴 filter byte 0）
* IEND 區塊
* 每個區塊皆附 CRC-32 校驗碼

加密框架接在 IEND 之後。結果是一張可以用任何圖片檢視器正常打開的雜訊雪花圖，而 `file(1)` 會判定為標準 PNG。

### LOG 日誌偽裝

生成兩行標頭說明文字，之後是 24 到 55 行隨機十六進位雜訊。真實的承載行被插入隨機位置：

```text
#blk:<magic hex>:<payload base64>:<sha256 hex>
```

讀取時用正規表達式比對該行，並重新計算 SHA-256 驗證。

### BIN 二進位偽裝

前後各填充隨機位元組（前端 64 到 575 位元組，尾端任意），加密框架夾在中間。整體呈現無規律的高熵特徵。

### plain 純 JSON

不做任何偽裝，直接輸出 `{s, i, t, d}`。保留此格式是為了相容既有 CLI 的輸出，載入器會自動偵測。

---

## 四、兩層完整性的分工

| 機制 | 覆蓋範圍 | 性質 |
| :--- | :--- | :--- |
| Frame 的 SHA-256 校驗 | 外殼是否損毀、截斷、被竄改 | 非密碼學，用來快速判斷檔案是否完好 |
| GCM 的 authTag | 密文內容是否被竄改 | 密碼學，確保完整性與真實性 |

Frame 校驗先行，負責攔下「檔案損毀」這類常見情況；GCM 標籤則是最後一道防線，保證即使攻擊者能重組 Frame，密文本身被改過仍會被拒絕。

---

## 五、威脅模型定位

* **加密**（`crypto.js`）解決的是「內容會不會被讀懂」。
* **偽裝**（模組 4）解決的是「這個檔案會不會被多看一眼」。

加密後的檔案仍保有 JSON 結構、`s`/`i`/`t`/`d` 欄位名稱、長串 Base64 等結構性指紋。自動化掃描器與 AI Agent 正是靠這些指紋認出「這裡有憑證」，進而拾取、解析甚至外傳。偽裝層的價值就在於移除這些指紋，讓檔案在掃描器眼中只是「一張圖片」或「一份無關的日誌」。

必須誠實說明的是：**偽裝不會讓內容更難破解**。知道規則的人一樣能把密文從 PNG 中取出來餵給解密器，真正擋住他們的仍然是金鑰。因此偽裝層不能取代加密，它是加密之外的第二道防線，用來降低「被無差別掃描、隨手拾取、誤傳」的機率。

---

## 六、模組 5（記憶體生命週期控制）預留

目前解密後的值一旦注入 `process.env`，會存活到進程結束。規劃中的模組 5 將處理：

* 進程退出前主動覆寫敏感字串
* 對非必要的變數設定存活期限
* 降低核心傾印（core dump）時洩漏的風險

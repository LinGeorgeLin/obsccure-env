# obscure-env 測試指南

本文件說明如何從零開始驗證 obscure-env 的模組 3（運行期載入器）與模組 4（靜態檔案偽裝）。

---

## 零、先跑自動測試（最快確認整體是否正常）

專案內建兩組自動測試，一鍵執行：

```bash
cd /path/to/obscure-env
npm test
```

預期結尾輸出：

```text
結果:32 通過,0 失敗
結果:38 通過,0 失敗
結果:61 通過,0 失敗
```

`npm test` 會依序執行三個測試檔：

| 測試檔 | 斷言數 | 涵蓋範圍 |
| :--- | :--- | :--- |
| `test/integration.js` | 32 | 載入器語義、注入行為、竄改防護、錯誤金鑰、誘餌檔、搜尋順序、strict 模式 |
| `test/formats-check.js` | 38 | 四種偽裝格式的外觀、權限、明文外洩檢查、完整往返一致性 |
| `test/extension-lifecycle.js` | 61 | VS Code 擴充套件生命週期：視窗失焦詢問、`sealOnClose` 三種模式、關窗封存、覆寫保護 |

只想單獨驗證偽裝格式時：

```bash
npm run test:formats
```

只想單獨驗證擴充套件生命週期時：

```bash
npm run test:extension
```

測試涵蓋範圍：

| 區塊 | 內容 |
| :--- | :--- |
| 偽裝往返 | PNG、LOG、BIN、plain 四種格式的 pack 到 unpack 還原 |
| 外觀合法性 | PNG 具有真實簽章，`file(1)` 判定為標準圖檔 |
| .env 解析 | 註解、引號、跳脫字元、`export` 前綴、縮排 |
| Preload 載入 | 各格式在 `node -r` 下自動注入 `process.env` |
| 檔案權限 | 產出檔案自動設為 `0600` |
| 裝置綁定 | 未提供金鑰時自動以裝置指紋解密 |
| 防護語義 | 覆蓋策略、竄改偵測、錯誤金鑰、誘餌檔、無關檔案、檔案不存在、strict 模式 |
| 搜尋順序 | 未指定檔名時優先命中 `verify.txt` |

---

## 一、手動實機演練（5 步驟，完全從頭建立）

### 步驟 1：建立一個明文 `.env` 檔案

```bash
cd /tmp && rm -rf obscure-demo && mkdir obscure-demo && cd obscure-demo
cat << 'EOF' > .env
# 我的測試機密
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/mydb
MY_API_KEY=sk-test-secret-88888888
EOF
```

此時硬碟上確實存在明文機密，這正是我們要消除的狀態。

---

### 步驟 2：加密並偽裝成圖片檔

```bash
node ./bin/cli.js --secret my-super-secret --format png
```

預期輸出：

```text
✅ 加密與偽裝成功！
   輸出的保管檔: verify.png (格式: png)
   原始 .env 已安全刪除。
```

**立刻驗證外觀：**

```bash
ls -l verify.png
file verify.png
```

預期看到權限為 `600`，且 `file` 判定為：

```text
PNG image data, 128 x 128, 8-bit/color RGB, non-interlaced
```

用「預覽」應用程式打開它，會是一張 128x128 的彩色雜訊雪花圖。

---

### 步驟 3：確認明文已消失

```bash
ls -la
```

目錄中應只剩 `app.js` 與 `verify.png`，不再有 `.env`。

---

### 步驟 4：建立模擬業務程式

```bash
cat << 'EOF' > app.js
console.log('--- 業務系統啟動中 ---');
console.log('資料庫網址:', process.env.DATABASE_URL || '❌ 未讀取到');
console.log('API 金鑰:  ', process.env.MY_API_KEY || '❌ 未讀取到');
EOF
```

**重點：`app.js` 裡完全沒有 `require('obscure-env')`，也沒有任何讀檔邏輯。**

先直接執行看看：

```bash
node app.js
```

此時兩個變數都會顯示 `❌ 未讀取到`，因為還沒有啟用載入器。

---

### 步驟 5：帶入金鑰與 Preload 參數啟動

```bash
OBSCURE_KEY=my-super-secret node -r ./src/register.js app.js
```

預期輸出：

```text
[obscure-env] 已從 verify.png 載入 2 個變數(偽裝格式:png)
--- 業務系統啟動中 ---
資料庫網址: postgres://user:pass@127.0.0.1:5432/mydb
API 金鑰:   sk-test-secret-88888888
```

**這就是整個專案的核心價值：硬碟上沒有明文，業務程式碼零改動，環境變數卻自動到位。**

---

## 二、額外驗證情境

### 情境 A：錯誤金鑰

```bash
OBSCURE_KEY=wrong-password node -r ./src/register.js app.js
```

預期：

```text
❌ [obscure-env] 解密失敗:金鑰不符或檔案內容損毀
資料庫網址: ❌ 未讀取到
API 金鑰:   ❌ 未讀取到
```

注意程式**沒有崩潰**，這是刻意的容錯設計。

### 情境 B：嚴格模式（載入失敗就中止進程）

```bash
OBSCURE_KEY=wrong-password OBSCURE_ENV_STRICT=1 node -r ./src/register.js app.js
```

預期：進程以非零狀態碼結束，`app.js` 完全不會執行。適合 CI/CD 或正式環境。

### 情境 C：指定其他保管檔

```bash
OBSCURE_ENV_FILE=verify.png OBSCURE_KEY=my-super-secret node -r ./src/register.js app.js
```

未指定時，載入器會依序搜尋 `verify.txt`、`verify.png`、`.env.vault`、`vault.bin`。

### 情境 D：切換偽裝格式

切換格式只需要改 `--format`，其餘流程完全不變。以下指令可直接複製執行（每段都是獨立的一次完整加密）：

```bash
cd /tmp && rm -rf fmt && mkdir fmt && cd fmt

# ── log 格式 ──
printf 'MY_API_KEY=sk-log-test-9999\n' > .env
node ./bin/cli.js --secret k1 --format log
head -4 verify.txt                      # 看見 # 開頭的十六進位雜訊日誌
OBSCURE_ENV_FILE=verify.txt OBSCURE_KEY=k1 \
  node -r ./src/register.js -e \
  "console.log('載入結果:', process.env.MY_API_KEY)"
```

預期看到 `載入結果: sk-log-test-9999`，且載入訊息顯示 `偽裝格式:log`。

```bash
# ── bin 格式 ──
rm -f verify.txt
printf 'MY_API_KEY=sk-bin-test-8888\n' > .env
node ./bin/cli.js --secret k2 --format bin
file vault.bin                          # 判定為 data，不是文字
OBSCURE_ENV_FILE=vault.bin OBSCURE_KEY=k2 \
  node -r ./src/register.js -e \
  "console.log('載入結果:', process.env.MY_API_KEY)"
```

預期看到 `載入結果: sk-bin-test-8888`，且載入訊息顯示 `偽裝格式:bin`。

```bash
# ── png 格式(預設)──
rm -f vault.bin
printf 'MY_API_KEY=sk-png-test-7777\n' > .env
node ./bin/cli.js --secret k3
file verify.png                         # 判定為 PNG image data
OBSCURE_ENV_FILE=verify.png OBSCURE_KEY=k3 \
  node -r ./src/register.js -e \
  "console.log('載入結果:', process.env.MY_API_KEY)"
```

```bash
# ── plain 格式(無偽裝外殼，原始 JSON)──
rm -f verify.png
printf 'MY_API_KEY=sk-plain-test-6666\n' > .env
node ./bin/cli.js --secret k4 --format plain
head -c 80 verify.txt                   # 會看到 {"s":"...","i":"...","t":"...","d":"..."
OBSCURE_ENV_FILE=verify.txt OBSCURE_KEY=k4 \
  node -r ./src/register.js -e \
  "console.log('載入結果:', process.env.MY_API_KEY)"
```

**四種格式的載入訊息分別會顯示 `偽裝格式:png`、`log`、`bin`、`plain`，代表載入器是依內容特徵自動判斷的，不是靠副檔名。**

---

## 三、四種偽裝格式的自動化完整驗證

上面的手動指令只驗證了「能不能載入」。若要一次檢查四種格式的**全部性質**（明文是否外洩、外觀是否正確、權限、往返是否一致），執行專案提供的專用腳本：

```bash
npm run test:formats
```

預期輸出：

```text
[png] 格式驗證
  PASS  CLI 加密成功
  PASS  保管檔已產生
  PASS  原始 .env 已刪除
  PASS  保管檔權限 0600
  PASS  位元組中找不到明文片段
  PASS  PNG 簽章正確
  PASS  file(1) 判定為 PNG
  PASS  preload 載入的值與明文完全相同
  PASS  載入訊息標示的格式正確

[log] 格式驗證
  ...
[bin] 格式驗證
  ...
[plain] 格式驗證
  ...

[跨格式] 錯誤金鑰防護
  PASS  錯誤金鑰 → 拒絕解密
  PASS  錯誤金鑰 → 印出提示且進程存活

結果:38 通過,0 失敗
```

這個腳本對每一種格式都檢查五件事：

| 檢查項目 | 意義 |
| :--- | :--- |
| 原始 `.env` 已刪除 | 加密後不留明文檔案 |
| 保管檔權限 0600 | 只有檔案擁有者可讀寫 |
| 位元組中找不到明文片段 | 在整個檔案的位元組層面搜尋 `FORMAT_MARK` 與明文值，確認機密沒有以任何形式外洩 |
| 外觀符合預期 | PNG 簽章與 `file(1)` 判定、日誌開頭的 `#` 標頭、BIN 的資訊熵高於 7.0、plain 的 JSON 四欄位結構 |
| 載入值與明文完全相同 | 從加密到解密走完全程後，每個字元都必須一樣 |

每個格式都使用**不同的值**（`png-value-1111`、`log-value-2222`…），確保「載到的」一定是「剛加密的那一份」，不會誤載到目錄裡的其他檔案。

---

## 三-一、偽裝路線的端對端測試（test-project）

偽裝路線（png / log / bin）與生命週期功能的完整驗證放在 `test-project/` 資料夾：

```bash
cd ../test-project
npm install
npm test
```

預期輸出：

```text
結果:89 通過,0 失敗
```

涵蓋範圍：

| 測試區塊 | 內容 |
| :--- | :--- |
| 四種格式往返 | png / log / bin / plain 的 CLI 加密與解密、權限 0600、明文外洩檢查 |
| 格式轉換 | 同一份密文在 png → bin → log 之間互換，密文逐字相同、舊金鑰仍然有效 |
| 錯誤金鑰與損毀檔案 | 失敗時退出碼非 0、既有 `.env` 不被覆寫、保管檔完好 |
| 兩條路線互不干擾 | 純密文 `verify.txt` 仍辨識為 `plain`，偽裝檔仍辨識為 `png` |
| 依內容辨識 | 檔案改名成 `.dat` 後仍可解密；CLI 的 log 檔即使叫 `verify.txt` 仍辨識為 `log` |
| decrypt 資料保護 | 保管檔不會被明文覆寫、輸出與來源同路徑時直接中止 |
| 自動載入 | 擴充套件的 `verify.log` 可被載入器在未指定檔名時找到 |

> 測試全程在系統暫存目錄操作，`test-project` 自己的 `.env` 只會被讀取作為測試素材，不會被刪除或覆寫。

### 情境 E：格式轉換（換外殼不換金鑰）

轉換是純檔案層的操作 —— 同一份密文重新包裝，**不需要金鑰，也不會重新加密**：

```bash
cd /tmp && rm -rf conv && mkdir conv && cd conv
printf 'MY_API_KEY=sk-conv-test-5555\n' > .env

node ./bin/cli.js --secret k1 --format plain
# → verify.txt（裸 JSON）

node ./bin/cli.js convert --in verify.txt --format png
# → verify.png，verify.txt 已移除

OBSCURE_ENV_FILE=verify.png OBSCURE_KEY=k1 \
  node -r ./src/register.js -e \
  "console.log('載入結果:', process.env.MY_API_KEY)"
```

預期看到 `載入結果: sk-conv-test-5555`，載入訊息顯示 `偽裝格式:png` —— 證明轉換後原本的金鑰 `k1` 仍然有效。

### 情境 F：CLI 還原（decrypt）

```bash
cd /tmp && rm -rf dec && mkdir dec && cd dec
printf 'MY_API_KEY=sk-dec-test-4444\n' > .env
node ./bin/cli.js --secret k2 --format png

node ./bin/cli.js decrypt --in verify.png --secret k2
ls -l .env verify.png
```

預期：

* `.env` 內容是 `MY_API_KEY=sk-dec-test-4444`，權限 `600`
* `verify.png` **仍然存在**且內容不變 —— 還原不會刪掉或覆蓋保管檔

> `decrypt` 絕不會把明文寫在保管檔上。若輸出路徑與來源相同，指令會直接中止並保留原始密文。

---

## 四、Localhost 示範服務

專案內附一個示範 Web 服務，示範「解密後的值如何安全地呈現給瀏覽器」。

```bash
cd /path/to/obscure-env
npm run demo
```

接著開啟瀏覽器前往 <http://127.0.0.1:8787>，或另開終端機：

```bash
curl http://127.0.0.1:8787/status
```

重點觀察：

* 伺服器原始碼中沒有任何寫入機密值的邏輯，但頁面上顯示三個變數都已注入。
* 頁面只顯示遮罩預覽（例如 `sk••••••••••`），完整值永遠不離開伺服器進程記憶體。
* `/status` 只回傳鍵名，不含任何值。
* 服務只綁定 `127.0.0.1`，區域網路無法存取。

---

## 五、清理

```bash
cd /tmp && rm -rf obscure-demo
```

專案目錄內若產生了測試檔案，也一併刪除：

```bash
cd /path/to/obscure-env && rm -f verify.png verify.txt vault.bin .env.vault
```

---

## 六、故障排除對照表

| 症狀 | 可能原因 | 處理方式 |
| :--- | :--- | :--- |
| `❌ 解密失敗:金鑰不符或檔案內容損毀` | 金鑰與加密時不一致 | 確認加密時的 `--secret` 與啟動時的 `OBSCURE_KEY` 相同 |
| `❌ 保管檔已損壞或偽裝格式無法辨識` | 檔案被竄改、截斷或非本工具產生 | 重新加密產生保管檔 |
| `❌ 無法讀取保管檔` | 檔案不存在或權限不足 | 確認檔名與 `OBSCURE_ENV_FILE` |
| 變數顯示 `❌ 未讀取到` 且無任何錯誤 | 找不到保管檔（靜默略過） | 確認目錄下存在 `verify.txt` 或 `verify.png` |
| `file` 顯示 `PNG image data` 但解不開 | 圖片被影像軟體重新編碼過，尾端框架被剝除 | 重新加密，不要再編輯偽裝圖片 |

---

## 七、檔案對照

| 檔案 | 用途 |
| :--- | :--- |
| `bin/cli.js` | 加密、還原與格式轉換的指令列工具 |
| `src/crypto.js` | AES-256-GCM 密碼學核心（未經修改） |
| `src/camouflage/` | 四種偽裝格式的封裝與拆解 |
| `src/vault-ops.js` | 保管檔操作核心（封存 / 還原 / 格式轉換，兩條路線共用） |
| `src/index.js` | 運行期載入器與金鑰候選鏈 |
| `src/register.js` | Preload 進入點 |
| `src/parse-env.js` | `.env` 語意解析器 |
| `test/integration.js` | 32 項端對端整合測試（載入器語義與防護） |
| `test/formats-check.js` | 38 項偽裝格式專項驗證（外觀、權限、明文外洩、往返） |
| `vscode-extension/` | VS Code 擴充套件（偽裝路線的生命週期自動封存／還原） |
| `../test-project/camouflage-test.js` | 89 項偽裝路線端對端測試（往返、轉換、資料保護、依內容辨識） |
| `demo/prepare.js` | 產生示範用加密檔 |
| `demo/server.js` | Localhost 遮罩展示服務 |
| `docs/ARCHITECTURE.md` | 架構與 `crypto.js` 合作原理 |

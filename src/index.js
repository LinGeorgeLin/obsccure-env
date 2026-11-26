const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { decryptEnv } = require('./crypto');
const { readVault } = require('./camouflage');
const { parseEnv } = require('./parse-env');

// 預設依序搜尋的保管檔(verify.txt 為 CLI 預設輸出,優先)
// verify.log 為 VS Code 擴充套件的 log 偽裝檔名(與純密文的 verify.txt 分開,避免撞名)
const DEFAULT_VAULT_FILES = ['verify.txt', 'verify.png', 'verify.log', '.env.vault', 'vault.bin'];

// 裝置指紋(README 的 Device Binding 進階選配):
// 以本機特徵(主機名/使用者名/MAC)做為 secretKey 輸入,verify.txt 離開這台機器即無法解密。
// 先試含 MAC 的版本;若網路介面變動(如新增 Docker/VPN 虛擬網卡)則退回「主機名+使用者名」版本。
function machineFingerprint(withMac) {
  const parts = [os.hostname()];
  try {
    parts.push(os.userInfo().username);
  } catch (_) {
    parts.push(process.env.USER || process.env.USERNAME || '');
  }
  if (withMac) {
    try {
      const macs = [];
      for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const it of ifaces || []) {
          if (it && it.mac && !it.internal) macs.push(it.mac);
        }
      }
      parts.push(macs.sort().join(','));
    } catch (_) {
      /* 忽略,指紋退化為主機名+使用者名 */
    }
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// 金鑰候選,優先序與既有工具鏈對齊:
// 1. 呼叫端明確傳入的 secret
// 2. OBSCURE_KEY 環境變數(bin/cli.js 的慣例)
// 3. 'local-device-secret'(CLI 的預設金鑰)
// 4. 裝置指紋(含 MAC → 不含 MAC)
// 5. 'default-system-salt'(src/crypto.js 的預設參數)
// GCM 認證標籤會自動否決錯誤金鑰,故可安全逐一嘗試。
function resolveSecretCandidates(explicit) {
  const list = [];
  if (explicit) list.push(explicit);
  if (process.env.OBSCURE_KEY) list.push(process.env.OBSCURE_KEY);
  list.push('local-device-secret', machineFingerprint(true), machineFingerprint(false), 'default-system-salt');
  return [...new Set(list)];
}

// 逐一嘗試候選金鑰;全部失敗時丟出統一錯誤(不夾帶內部細節)
function decryptVault(jsonString, candidates) {
  for (const secret of candidates) {
    try {
      return { plain: decryptEnv(jsonString, secret) };
    } catch (_) {
      /* 金鑰不符或內容損毀,換下一個候選 */
    }
  }
  throw new Error('解密失敗:金鑰不符或檔案內容損毀');
}

// 核心運行期載入:讀取 → 解除偽裝 → 記憶體內解密 → 注入 process.env。
// 與 dotenv 的 config() 同型;任何失敗都不中斷宿主程式(除非 strict)。
function config(options = {}) {
  const {
    file,
    secret,
    overwrite = false,
    strict = false,
    silent = false,
    searchDir = process.cwd(),
  } = options;

  let target = null;
  try {
    // 1. 定位保管檔:明確參數 > OBSCURE_ENV_FILE 環境變數 > 預設搜尋清單
    target =
      file ||
      process.env.OBSCURE_ENV_FILE ||
      DEFAULT_VAULT_FILES.map((name) => path.join(searchDir, name)).find((p) => fs.existsSync(p)) ||
      null;
    if (!target) {
      // 與參考設計一致:找不到保管檔時靜默略過,不干擾宿主程式(strict 模式除外)
      const notFound = '找不到保管檔';
      if (strict) throw new Error(notFound);
      return { ok: false, file: null, loaded: {}, skipped: 0, error: notFound };
    }

    // 2. 讀取 + 解除偽裝(readVault 內含:讀檔錯誤統一訊息、密文緩衝用畢即清)
    const { jsonString, format } = readVault(target);

    // 3. 記憶體內解密
    const { plain } = decryptVault(jsonString, resolveSecretCandidates(secret));

    // 金鑰若經環境變數傳遞,用畢即從 process.env 抹除(可用 OBSCURE_KEY_KEEP=1 保留)
    if (!secret && process.env.OBSCURE_KEY && process.env.OBSCURE_KEY_KEEP !== '1') {
      delete process.env.OBSCURE_KEY;
    }

    // 4. 解析並注入(預設不覆蓋既有變數,與 dotenv 及參考設計一致)
    const entries = parseEnv(plain);
    const loaded = {};
    let skipped = 0;
    for (const { key, value } of entries) {
      if (!overwrite && process.env[key] !== undefined) {
        skipped++;
        continue;
      }
      process.env[key] = value;
      loaded[key] = value;
    }

    if (!silent) {
      console.error(`[obscure-env] 已從 ${path.basename(target)} 載入 ${Object.keys(loaded).length} 個變數(偽裝格式:${format})`);
    }
    return { ok: true, file: target, format, loaded, skipped };
  } catch (err) {
    if (strict) throw err;
    // 參考設計行為:解密/格式錯誤僅提示,不讓宿主程式崩潰
    console.error(`❌ [obscure-env] ${err.message}`);
    return { ok: false, file: target, loaded: {}, skipped: 0, error: err.message };
  }
}

module.exports = { config, machineFingerprint, resolveSecretCandidates, parseEnv, DEFAULT_VAULT_FILES };

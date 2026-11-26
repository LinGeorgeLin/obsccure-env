// src/vault-ops.js —— 保管檔操作核心（手動「純密文」路線 + 自動「偽裝」路線共用）
//
// 兩條路線共用同一個加密核心（src/crypto.js 的 AES-256-GCM），差別只在「要不要套偽裝外殼」：
//
//   純密文(plain)   .env → verify.txt（裸 JSON）              手動觸發
//   偽裝(camouflage) .env → verify.png / verify.log / vault.bin   生命週期自動觸發
//
// 重要慣例：格式一律「依內容」辨識（readVault → unpack），不看副檔名。
// 同一個檔名在不同情況下可能是不同格式，只有內容說得準。
// 偽裝層的加密內容與純密文完全相同 —— 換外殼不影響金鑰。

const fs = require('fs');
const path = require('path');
const { encryptEnv, decryptEnv } = require('./crypto');
const { readVault, writeVault } = require('./camouflage');
const { resolveSecretCandidates } = require('./index');

// 可偽裝的三種外殼 + 純密文
const CAMOUFLAGE_FORMATS = ['png', 'log', 'bin'];
const TEXT_FORMAT = 'plain';
const SUPPORTED_FORMATS = [...CAMOUFLAGE_FORMATS, TEXT_FORMAT];

// 各格式的預設檔名。
// 刻意讓 log 用 verify.log 而非 verify.txt —— 避免與純密文的 verify.txt 撞名。
// verify.txt 仍保留在掃描清單中，相容舊版的 log 檔與純密文檔。
const VAULT_NAMES = {
  png: 'verify.png',
  log: 'verify.log',
  bin: 'vault.bin',
  plain: 'verify.txt',
};

// 掃描時的候選檔名
const VAULT_CANDIDATES = ['verify.png', 'verify.log', 'vault.bin', 'verify.txt', '.env.vault'];

// 寫入後強制 0600（fs.writeFileSync 的 mode 只在「新建檔案」時生效，
// 覆寫既有的寬鬆權限檔案時不會自動收斂，故需顯式 chmod）。
function hardenPermissions(filePath) {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    /* 某些檔案系統不支援 chmod，忽略即可 */
  }
}

// 各格式的預設檔名
function vaultFileName(format) {
  return VAULT_NAMES[format] || VAULT_NAMES.png;
}

// 依內容辨識單一檔案的格式；不是保管檔或已損毀 → null
function inspectVault(filePath) {
  try {
    const { jsonString, format } = readVault(filePath);
    return { file: filePath, format, jsonString };
  } catch (_) {
    return null;
  }
}

// 掃描目錄內所有保管檔（依內容辨識，不是靠檔名）
function findVaults(dir, { candidates = VAULT_CANDIDATES } = {}) {
  const found = [];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const info = inspectVault(p);
    if (info) found.push(info);
  }
  return found;
}

// 找出指定格式的保管檔
function findVault(dir, format, opts) {
  return findVaults(dir, opts).find((v) => v.format === format) || null;
}

// 決定封存要用的金鑰。
// 刻意「不」採用 src/index.js 的裝置指紋候選：指紋會隨網路介面變動而失效，
// 用它加密等於把檔案綁死在單一機器的當下網路設定上。
// 封存要的是「下次一定解得開」，所以優先序固定為：明示 > OBSCURE_KEY > 預設值。
// 解密端則走完整候選鏈（resolveSecretCandidates），兩邊一起使用時仍能互通。
function resolveSealKey(explicit) {
  if (explicit) return { key: explicit, source: 'explicit' };
  if (process.env.OBSCURE_KEY) return { key: process.env.OBSCURE_KEY, source: 'env' };
  return { key: 'local-device-secret', source: 'default' };
}

// 逐一嘗試候選金鑰；全數失敗回傳 null。
// 安全性依據：AES-256-GCM 的認證標籤會直接否決錯誤金鑰，不會回傳亂碼。
function decryptWithCandidates(jsonString, candidates) {
  for (const key of candidates) {
    try {
      return decryptEnv(jsonString, key);
    } catch (_) {
      /* 金鑰不符或內容損毀，換下一把 */
    }
  }
  return null;
}

// 封存：.env → 偽裝保管檔，並刪除明文。
// outPath 可指定輸出路徑；不指定時用 vaultFileName(format) 的預設檔名。
// 輸出與來源同一路徑時不刪除來源（覆寫原檔的合理情境）。
function sealEnv({ envPath, format = 'png', secret, dir, outPath } = {}) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`不支援的偽裝格式 "${format}"`);
  }
  const target = outPath || path.join(dir || path.dirname(envPath), vaultFileName(format));
  const raw = fs.readFileSync(envPath, 'utf8');
  const json = encryptEnv(raw, secret);
  writeVault(json, target, { format });
  hardenPermissions(target);
  if (path.resolve(envPath) !== path.resolve(target)) {
    fs.unlinkSync(envPath);
  }
  return { file: target, format, bytes: fs.statSync(target).size };
}

// 還原：保管檔 → .env
function restoreVault({ vaultPath, envPath, secret, candidates } = {}) {
  const info = inspectVault(vaultPath);
  if (!info) throw new Error('保管檔已損壞或偽裝格式無法辨識');

  const list = candidates && candidates.length ? candidates : resolveSecretCandidates(secret);
  const plain = decryptWithCandidates(info.jsonString, list);
  if (plain === null) throw new Error('解密失敗:金鑰不符或檔案內容損毀');

  const target = envPath || path.join(path.dirname(vaultPath), '.env');
  fs.writeFileSync(target, plain, 'utf8');
  hardenPermissions(target); // .env 內含機密，同樣收斂權限
  return { format: info.format, file: target, bytes: Buffer.byteLength(plain) };
}

// 格式轉換：同一份密文換外殼，不重新加密 → 舊金鑰仍然有效。
// 這是純檔案層的操作，不需要知道金鑰。
function convertVault({ vaultPath, format = 'png', outPath, removeSource = true } = {}) {
  const info = inspectVault(vaultPath);
  if (!info) throw new Error('保管檔已損壞或偽裝格式無法辨識');

  const target = outPath || path.join(path.dirname(vaultPath), vaultFileName(format));

  if (path.resolve(target) === path.resolve(vaultPath)) {
    // 同名原地轉換：先寫暫存檔再置換，避免寫到一半被截斷
    const tmp = `${target}.tmp`;
    writeVault(info.jsonString, tmp, { format });
    hardenPermissions(tmp);
    fs.renameSync(tmp, target);
    return { file: target, format, source: vaultPath, sourceFormat: info.format };
  }

  writeVault(info.jsonString, target, { format });
  hardenPermissions(target);
  if (removeSource) fs.unlinkSync(vaultPath);
  return { file: target, format, source: vaultPath, sourceFormat: info.format };
}

module.exports = {
  CAMOUFLAGE_FORMATS,
  TEXT_FORMAT,
  SUPPORTED_FORMATS,
  VAULT_NAMES,
  VAULT_CANDIDATES,
  vaultFileName,
  inspectVault,
  findVaults,
  findVault,
  resolveSealKey,
  resolveSecretCandidates,
  decryptWithCandidates,
  sealEnv,
  restoreVault,
  convertVault,
};

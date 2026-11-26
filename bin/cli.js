#!/usr/bin/env node
// bin/cli.js —— 指令列工具
//
// 三個指令:
//   encrypt  .env → 偽裝保管檔(預設 verify.png),並刪除明文
//   decrypt  偽裝保管檔 → .env
//   convert  同一份密文換一個外殼(不重新加密,舊金鑰仍然有效)
//
// 格式一律「依內容」辨識,不看副檔名 —— 同一個檔名在不同情況下可能是不同格式。
const fs = require('fs');
const path = require('path');
const vaultOps = require('../src/vault-ops');

const args = process.argv.slice(2);

// 支援辨識第一個參數是否為指令 (encrypt / decrypt / convert)
let command = 'encrypt';
if (args[0] && !args[0].startsWith('--')) {
  command = args[0];
  args.shift(); // 移除指令，留下後續的參數
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const format = getArg('--format') || 'png';

// CLI 的預設輸出檔名。
// 刻意維持既有慣例(log → verify.txt、plain → verify.txt),團隊的
// test/formats-check.js 與 README 都依賴這個對應,不要輕易更動。
// 偽裝路線的檔名分歧由「依內容辨識」吸收,雙方都能正確載入。
const defaultOutMap = {
  png: 'verify.png',
  log: 'verify.txt',
  bin: 'vault.bin',
  plain: 'verify.txt',
};

function fail(message, detail) {
  console.error(`❌ ${message}`);
  if (detail) console.error(`   ${detail}`);
  process.exit(1);
}

// 依內容找出目錄內的保管檔;找不到回傳 null。
function detectVault(dir) {
  const found = vaultOps.findVaults(dir);
  return found.length ? found[0].file : null;
}

// ==================== 1. 加密流程 (Encrypt) ====================
if (command === 'encrypt') {
  const inputEnv = getArg('--in') || path.join(process.cwd(), '.env');
  const outPath = getArg('--out') || path.join(process.cwd(), defaultOutMap[format] || 'verify.png');

  if (!vaultOps.SUPPORTED_FORMATS.includes(format)) {
    fail(`不支援的偽裝格式 "${format}"`, `可用格式: ${vaultOps.SUPPORTED_FORMATS.join(' / ')}`);
  }
  if (!fs.existsSync(inputEnv)) {
    fail(`找不到輸入的 .env 檔案: ${inputEnv}`);
  }

  try {
    // 封存金鑰刻意「不」採用裝置指紋:指紋會隨網路介面變動而失效,
    // 用它加密等於把檔案綁死在單一機器的當下網路設定上。
    const { key, source } = vaultOps.resolveSealKey(getArg('--secret'));
    const result = vaultOps.sealEnv({ envPath: inputEnv, format, secret: key, outPath });

    console.log(`✅ 加密與偽裝成功！`);
    console.log(`   輸出的保管檔: ${path.basename(result.file)} (格式: ${result.format})`);
    console.log(`   權限已收斂為 0600,原始 .env 已安全刪除。`);
    console.log(`   金鑰來源: ${source === 'explicit' ? '--secret 參數' : source === 'env' ? 'OBSCURE_KEY 環境變數' : '預設值'}`);
  } catch (error) {
    console.error('❌ 加密過程發生錯誤:', error.message);
    process.exit(1);
  }
}
// ==================== 2. 反向還原流程 (Decrypt) ====================
else if (command === 'decrypt') {
  const cwd = process.cwd();
  const argIn = getArg('--in');
  const argOut = getArg('--out');
  const envOutArg = getArg('--env-out');

  // ── 來源保管檔判定 ──
  //   --in            一律視為來源保管檔
  //   --out(且存在且是保管檔)  相容舊版:`decrypt --out verify.png` 的 --out 本來就是來源
  //   都沒有          依內容自動偵測目前目錄的保管檔
  let vaultPath = null;
  let legacyOut = false;

  if (argIn) {
    vaultPath = argIn;
  } else if (argOut && fs.existsSync(argOut) && vaultOps.inspectVault(argOut)) {
    vaultPath = argOut;
    legacyOut = true;
  } else {
    vaultPath = detectVault(cwd);
  }

  if (!vaultPath) {
    fail('找不到加密保管檔,無法進行還原。', `請用 --in 指定,或在 ${cwd} 放入 ${vaultOps.VAULT_CANDIDATES.join(' / ')} 其中之一。`);
  }
  if (!fs.existsSync(vaultPath)) {
    fail(`找不到加密保管檔: ${vaultPath}`);
  }

  // ── 輸出 .env 判定 ──
  //   --env-out       明確指定輸出路徑,優先度最高
  //   --out           當 --out 不是保管檔本身時,視為輸出路徑
  //   預設            目前的目錄/.env
  let envPath = envOutArg || null;
  if (!envPath && argOut && !legacyOut) {
    envPath = argOut;
  }
  if (!envPath) {
    envPath = path.join(cwd, '.env');
  }

  // 安全閘:絕不把明文寫在保管檔上(那會直接毀掉唯一的密文副本)
  if (path.resolve(envPath) === path.resolve(vaultPath)) {
    fail('輸出路徑與保管檔相同,已中止。', '請改用 --env-out 指定要寫出的 .env 路徑。');
  }

  try {
    const info = vaultOps.inspectVault(vaultPath);
    if (!info) {
      fail(`保管檔已損壞或偽裝格式無法辨識: ${vaultPath}`);
    }

    // 走完整金鑰候選鏈:明示 → OBSCURE_KEY → local-device-secret → 裝置指紋 → 預設值
    const candidates = vaultOps.resolveSecretCandidates(getArg('--secret'));
    const result = vaultOps.restoreVault({ vaultPath, envPath, candidates });

    console.log(`✅ 反向還原成功！`);
    console.log(`   已將 ${path.basename(vaultPath)} (偽裝格式:${result.format}) 解密還原為 ${path.basename(result.file)}。`);
    console.log(`   權限已收斂為 0600。`);
    console.log(`💡 提示：修改完成後,請再次執行「npx obscure-env encrypt」將其重新加密保護。`);
  } catch (error) {
    console.error('❌ 還原過程發生錯誤（可能金鑰不正確或檔案格式毀損）:', error.message);
    process.exit(1);
  }
}
// ==================== 3. 格式轉換 (Convert) ====================
else if (command === 'convert') {
  const cwd = process.cwd();
  const argIn = getArg('--in');
  const targetFormat = format;
  const outPath = getArg('--out');

  if (!vaultOps.CAMOUFLAGE_FORMATS.includes(targetFormat)) {
    fail(`不支援的偽裝格式 "${targetFormat}"`, `可轉換為: ${vaultOps.CAMOUFLAGE_FORMATS.join(' / ')}`);
  }

  let vaultPath = argIn || detectVault(cwd);
  if (!vaultPath) {
    fail('找不到加密保管檔,無法轉換。', `請用 --in 指定,或在 ${cwd} 放入 ${vaultOps.VAULT_CANDIDATES.join(' / ')} 其中之一。`);
  }
  if (!fs.existsSync(vaultPath)) {
    fail(`找不到加密保管檔: ${vaultPath}`);
  }

  const target = outPath || path.join(path.dirname(path.resolve(vaultPath)), defaultOutMap[targetFormat]);

  try {
    // 換外殼不換金鑰:同一份密文重新包裝,舊金鑰仍然有效
    const result = vaultOps.convertVault({ vaultPath, format: targetFormat, outPath: target, removeSource: true });
    console.log(`✅ 格式轉換成功！`);
    console.log(`   ${path.basename(result.source)} (${result.sourceFormat}) → ${path.basename(result.file)} (${result.format})`);
    console.log(`   密文未重新加密,原本的金鑰仍然可以解開。`);
  } catch (error) {
    console.error('❌ 轉換過程發生錯誤:', error.message);
    process.exit(1);
  }
}
// ==================== 4. 說明導覽 ====================
else {
  console.log('📌 使用說明：');
  console.log('  npx obscure-env encrypt [--format png|log|bin|plain] [--in <.env>] [--out <保管檔>] [--secret <key>]');
  console.log('  npx obscure-env decrypt [--in <保管檔>] [--out <還原路徑>] [--env-out <.env>] [--secret <key>]');
  console.log('  npx obscure-env convert [--in <保管檔>] [--format png|log|bin] [--out <保管檔>]');
  console.log('');
  console.log('  說明：');
  console.log('    encrypt  加密 .env 為偽裝保管檔,並刪除明文');
  console.log('    decrypt  還原偽裝保管檔為 .env;未指定 --in 時會依內容自動偵測');
  console.log('    convert  同一份密文換一個外殼(不重新加密,舊金鑰仍然有效)');
}

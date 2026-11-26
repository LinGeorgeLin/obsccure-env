// 端對端整合測試:node test/integration.js
// 涵蓋:三種偽裝格式 + CLI 相容的純 JSON 格式、注入語義、裝置綁定、
// 錯誤金鑰/竄改/誘餌/隨機垃圾的容錯、檔案權限與搜尋順序。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { encryptEnv } = require('../src/crypto');
const { pack, unpack, writeVault, readVault, generateDecoy } = require('../src/camouflage');
const { parseEnv } = require('../src/parse-env');
const { machineFingerprint } = require('../src/index');

const ROOT = path.join(__dirname, '..');
const REGISTER = path.join(ROOT, 'src', 'register.js');
const SECRET = 'test-secret-123';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// ── 測試用 .env(涵蓋註解/引號/轉義/export/行內註解/空值/縮排)──
const ENV_TEXT = [
  '# 全行註解應被略過',
  'API_KEY=sk-test-123   # 行內註解應被去除',
  'DB_PASS="p\\"ass #1"',
  "MSG='kept as-is # not comment'",
  'export EMPTY=',
  '  SPACED  =  trimmed  ',
  'MULTI="line1\\nline2"',
].join('\n');

const EXPECT_FULL = {
  API_KEY: 'sk-test-123',
  DB_PASS: 'p"ass #1',
  MSG: 'kept as-is # not comment',
  EMPTY: '',
  SPACED: 'trimmed',
  MULTI: 'line1\nline2',
};

// ── 子進程檢查腳本:比對 process.env 與期望 JSON ──
const CHECK = `\
const fs = require('fs');
const expect = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let ok = true;
for (const [k, v] of Object.entries(expect.env || {})) {
  if (process.env[k] !== v) { ok = false; console.error('MISMATCH ' + k + ': got ' + JSON.stringify(process.env[k])); }
}
for (const k of expect.absent || []) {
  if (process.env[k] !== undefined) { ok = false; console.error('UNEXPECTED ' + k + ' = ' + JSON.stringify(process.env[k])); }
}
if (expect.secretGone && process.env.OBSCURE_KEY !== undefined) { ok = false; console.error('OBSCURE_KEY 未被抹除'); }
console.log(ok ? 'ENV_OK' : 'ENV_BAD');
`;

// ── 準備臨時工作目錄 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obscure-env-test-'));
fs.writeFileSync(path.join(tmp, 'check.js'), CHECK);
function expectFile(name, obj) {
  const p = path.join(tmp, name + '.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
function runNode(argsFile, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, ['-r', REGISTER, path.join(tmp, 'check.js'), argsFile], {
    cwd: tmp,
    env,
    encoding: 'utf8',
  });
}

// ═══════════ 1. 父進程直接往返:pack → unpack → decrypt ═══════════
console.log('\n[1] 父進程往返與偽裝外觀');
const packedJson = encryptEnv(ENV_TEXT, SECRET);
for (const fmt of ['png', 'log', 'bin']) {
  const container = pack(packedJson, { format: fmt });
  const out = unpack(container);
  check(`${fmt}: pack→unpack 往返`, out && out.format === fmt, JSON.stringify(out && out.format));
  if (out) {
    check(`${fmt}: 解密還原原文`, decryptVia(out.jsonString) === ENV_TEXT);
  }
}
function decryptVia(jsonString) {
  const { decryptEnv } = require('../src/crypto');
  return decryptEnv(jsonString, SECRET);
}
check('plain: 相容 CLI 直接輸出的純 JSON', (() => {
  const out = unpack(Buffer.from(packedJson, 'utf8'));
  return out && out.format === 'plain' && decryptVia(out.jsonString) === ENV_TEXT;
})());
check('png: 具備真實 PNG 簽名', pack(packedJson, { format: 'png' }).subarray(0, 4).equals(PNG_MAGIC));
check('隨機垃圾位元組 → unpack 回傳 null', unpack(require('crypto').randomBytes(1024)) === null);

// ═══════════ 2. parseEnv 單元測試 ═══════════
console.log('\n[2] .env 解析');
const entries = Object.fromEntries(parseEnv(ENV_TEXT).map((e) => [e.key, e.value]));
for (const [k, v] of Object.entries(EXPECT_FULL)) {
  check(`parseEnv: ${k}`, entries[k] === v, JSON.stringify(entries[k]));
}

// ═══════════ 3. 各格式的子進程載入(preload 注入)═══════════
console.log('\n[3] preload 載入(node -r register)');
const vaultFiles = { png: 'verify.png', log: 'verify.txt', bin: 'vault.bin' };
for (const [fmt, name] of Object.entries(vaultFiles)) {
  const filePath = path.join(tmp, name);
  writeVault(packedJson, filePath, { format: fmt });
  const argsFile = expectFile(fmt, { env: EXPECT_FULL, secretGone: true });
  const r = runNode(argsFile, { OBSCURE_ENV_FILE: name, OBSCURE_KEY: SECRET });
  check(`${fmt}: 注入正確且金鑰已抹除`, r.stdout.includes('ENV_OK'), (r.stderr || '').trim());
}
check('檔案權限 0600', (fs.statSync(path.join(tmp, 'verify.png')).mode & 0o777) === 0o600);

// CLI 相容:cli.js 是直接把 encryptEnv 字串寫成 verify.txt
const plainPath = path.join(tmp, 'verify-plain.txt');
fs.writeFileSync(plainPath, packedJson, { mode: 0o600 });
const rPlain = runNode(expectFile('plain', { env: EXPECT_FULL, secretGone: true }), {
  OBSCURE_ENV_FILE: 'verify-plain.txt',
  OBSCURE_KEY: SECRET,
});
check('plain: CLI 原始格式可載入', rPlain.stdout.includes('ENV_OK'), (rPlain.stderr || '').trim());

// ═══════════ 4. 裝置綁定(金鑰 = 機器指紋)═══════════
console.log('\n[4] 裝置綁定');
const fp = machineFingerprint(true);
check('指紋具決定性', fp === machineFingerprint(true));
check('含 MAC 與不含 MAC 的指紋不同', fp !== machineFingerprint(false));
const fpPath = path.join(tmp, 'vault-fp.png');
writeVault(encryptEnv(ENV_TEXT, fp), fpPath, { format: 'png' });
const rFp = runNode(expectFile('fp', { env: EXPECT_FULL }), {
  OBSCURE_ENV_FILE: 'vault-fp.png',
  // 故意不給 OBSCURE_KEY — 驗證指紋候選能自動命中
});
check('無金鑰時以裝置指紋解密', rFp.stdout.includes('ENV_OK'), (rFp.stderr || '').trim());

// ═══════════ 5. 防護語義:覆蓋 / 竄改 / 錯誤金鑰 / 誘餌 / 損毀 ═══════════
console.log('\n[5] 防護語義');
// 5a. 預設不覆蓋既有變數
const rOverwrite = runNode(expectFile('ow', { env: { API_KEY: 'preset-value', DB_PASS: 'p"ass #1' } }), {
  OBSCURE_ENV_FILE: 'verify.png',
  OBSCURE_KEY: SECRET,
  API_KEY: 'preset-value',
});
check('預設不覆蓋既有環境變數', rOverwrite.stdout.includes('ENV_OK'), (rOverwrite.stderr || '').trim());

// 5b. 竄改:破壞框架尾端校驗 → 失敗(不中斷宿主)
const tamperedPath = path.join(tmp, 'tampered.png');
fs.copyFileSync(path.join(tmp, 'verify.png'), tamperedPath);
const tampered = fs.readFileSync(tamperedPath);
tampered[tampered.length - 1] ^= 0xff;
fs.writeFileSync(tamperedPath, tampered, { mode: 0o600 });
const rTamper = runNode(expectFile('tamper', { absent: ['API_KEY'] }), {
  OBSCURE_ENV_FILE: 'tampered.png',
  OBSCURE_KEY: SECRET,
});
check('竄改檔案 → 失敗並提示', rTamper.status === 0 && /obscure-env/.test(rTamper.stderr), (rTamper.stderr || '').trim());

// 5c. 錯誤金鑰 → 失敗
const rWrong = runNode(expectFile('wrong', { absent: ['API_KEY'] }), {
  OBSCURE_ENV_FILE: 'verify.png',
  OBSCURE_KEY: 'totally-wrong-key',
});
check('錯誤金鑰 → 失敗並提示', rWrong.status === 0 && /obscure-env/.test(rWrong.stderr), (rWrong.stderr || '').trim());

// 5d. 誘餌檔:結構合法但內容為雜訊,解密失敗
const decoyPath = path.join(tmp, 'decoy.png');
generateDecoy(decoyPath, { format: 'png' });
check('誘餌檔具合法外觀(PNG 簽名)', fs.readFileSync(decoyPath).subarray(0, 4).equals(PNG_MAGIC));
check('誘餌檔通過 readVault(結構合法)但非有效加密承載', (() => {
  try {
    const { jsonString } = readVault(decoyPath);
    try {
      const o = JSON.parse(jsonString);
      return !(o && o.s && o.i && o.t && o.d); // 形狀不像 {s,i,t,d} → 誘餌成立
    } catch (_) {
      return true; // 內容為雜訊、無法解析為 JSON → 正是誘餌應有的行為
    }
  } catch (_) {
    return false; // readVault 應成功(誘餌結構是合法的)
  }
})());

// 5e. 完全無關的檔案 → 失敗
const junkPath = path.join(tmp, 'junk.txt');
fs.writeFileSync(junkPath, 'hello world this is not a vault', { mode: 0o600 });
const rJunk = runNode(expectFile('junk', { absent: ['API_KEY'] }), {
  OBSCURE_ENV_FILE: 'junk.txt',
  OBSCURE_KEY: SECRET,
});
check('非保管檔 → 失敗並提示', rJunk.status === 0 && /obscure-env/.test(rJunk.stderr), (rJunk.stderr || '').trim());

// 5f. 找不到保管檔 → 參考設計行為:靜默略過
const rMissing = runNode(expectFile('missing', { absent: ['API_KEY'] }), {
  OBSCURE_ENV_FILE: 'no-such-file.png',
  OBSCURE_KEY: SECRET,
});
check('指定檔案不存在 → 不中斷宿主程式', rMissing.status === 0 && rMissing.stdout.includes('ENV_OK'));

// 5g. strict 模式:失敗應拋錯讓進程終止
const rStrict = runNode(expectFile('strict', {}), {
  OBSCURE_ENV_FILE: 'no-such-file.png',
  OBSCURE_KEY: SECRET,
  OBSCURE_ENV_STRICT: '1',
});
check('strict 模式下失敗 → 進程非無退出', rStrict.status !== 0);

// ═══════════ 6. 搜尋順序(未指定 OBSCURE_ENV_FILE)═══════════
console.log('\n[6] 預設搜尋順序');
// verify.png / verify.txt / vault.bin 並存於目錄中,但 verify.txt 放入不同內容 —
// 若搜尋順序不是優先命中 verify.txt,載入到的 API_KEY 就會不同。
fs.writeFileSync(
  path.join(tmp, 'verify.txt'),
  encryptEnv('API_KEY=from-verify-txt', SECRET),
  { mode: 0o600 }
);
const rOrder = runNode(expectFile('order', { env: { API_KEY: 'from-verify-txt' } }), { OBSCURE_KEY: SECRET });
check('未指定檔名時優先命中 verify.txt', rOrder.stdout.includes('ENV_OK'), (rOrder.stderr || '').trim());

// ═══════════ 7. 偽裝外觀資訊(非斷言)═══════════
console.log('\n[7] 偽裝外觀(參考資訊)');
try {
  const { execFileSync } = require('child_process');
  console.log('  file(1): ' + execFileSync('file', ['-b', path.join(tmp, 'verify.png')], { encoding: 'utf8' }).trim());
} catch (_) {
  console.log('  (本機無 file 指令,略過外觀檢查)');
}

// ═══════════ 總結 ═══════════
console.log(`\n結果:${pass} 通過,${fail} 失敗`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

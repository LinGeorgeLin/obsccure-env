// 四種偽裝格式的完整往返驗證:node test/formats-check.js
//
// 每一個格式都獨立驗證五件事:
//   1. CLI 能把明文 .env 加密成該格式的保管檔
//   2. 原始 .env 已被刪除,且保管檔權限為 0600
//   3. 保管檔的位元組內容中「找不到」任何明文片段(機密未外洩)
//   4. 保管檔的外觀符合該格式的預期(PNG 簽章 / 日誌開頭 / 隨機位元組)
//   5. 以 preload 載入後,process.env 的值與原始明文完全相同
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const REGISTER = path.join(ROOT, 'src', 'register.js');

const SECRET = 'formats-check-secret';

// 每個格式使用不同的值,確保「載到的」一定是「剛加密的那一份」
const CASES = [
  { format: 'png', out: 'verify.png', env: 'FORMAT_MARK=png-value-1111' },
  { format: 'log', out: 'verify.txt', env: 'FORMAT_MARK=log-value-2222' },
  { format: 'bin', out: 'vault.bin', env: 'FORMAT_MARK=bin-value-3333' },
  { format: 'plain', out: 'verify.txt', env: 'FORMAT_MARK=plain-value-4444' },
];

const APP = `\
console.log('LOADED=' + (process.env.FORMAT_MARK || ''));
`;

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

function fileType(p) {
  try {
    return execFileSync('file', ['-b', p], { encoding: 'utf8' }).trim();
  } catch (_) {
    return '(本機無 file 指令)';
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obscure-formats-'));

for (const c of CASES) {
  console.log(`\n[${c.format}] 格式驗證`);

  // ── 準備:寫入明文 .env ──
  const envPath = path.join(tmp, '.env');
  const outPath = path.join(tmp, c.out);
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
  fs.writeFileSync(envPath, c.env + '\n');

  // ── 1. CLI 加密 ──
  const enc = spawnSync(process.execPath, [CLI, '--secret', SECRET, '--format', c.format], {
    cwd: tmp,
    encoding: 'utf8',
  });
  check('CLI 加密成功', enc.status === 0, (enc.stderr || '').trim());
  check('保管檔已產生', fs.existsSync(outPath));

  // ── 2. 明文已刪除 + 權限 0600 ──
  check('原始 .env 已刪除', !fs.existsSync(envPath));
  const mode = fs.statSync(outPath).mode & 0o777;
  check('保管檔權限 0600', mode === 0o600, '實際為 ' + mode.toString(8));

  // ── 3. 位元組層面:明文片段不可見 ──
  const raw = fs.readFileSync(outPath);
  const rawLatin1 = raw.toString('latin1');
  const rawUtf8 = raw.toString('utf8');
  const leaked =
    rawUtf8.includes(c.env) ||
    rawUtf8.includes('FORMAT_MARK') ||
    rawLatin1.includes(c.env) ||
    rawLatin1.includes('FORMAT_MARK');
  check('位元組中找不到明文片段', !leaked);

  // ── 4. 外觀符合預期 ──
  if (c.format === 'png') {
    check('PNG 簽章正確', raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    check('file(1) 判定為 PNG', /PNG image data/.test(fileType(outPath)), fileType(outPath));
  } else if (c.format === 'log') {
    check('開頭為 # 標頭列', rawUtf8.startsWith('#'));
    check('含多行 # 日誌內容', (rawUtf8.match(/^#/gm) || []).length >= 10);
    check('file(1) 判定為文字檔', /ASCII text|Unicode text/.test(fileType(outPath)), fileType(outPath));
  } else if (c.format === 'bin') {
    check('file(1) 判定為 data 而非文字', /^data/.test(fileType(outPath)), fileType(outPath));
    check('位元組組成的資訊熵夠高(前 512 bytes)', entropy(raw.subarray(0, 512)) > 7.0);
  } else if (c.format === 'plain') {
    const obj = JSON.parse(rawUtf8);
    check('為合法 JSON 且含 s/i/t/d 四欄位', !!(obj.s && obj.i && obj.t && obj.d));
  }

  // ── 5. Preload 載入:值必須完全相同 ──
  const appPath = path.join(tmp, 'app.js');
  fs.writeFileSync(appPath, APP);
  const run = spawnSync(
    process.execPath,
    ['-r', REGISTER, appPath],
    {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, OBSCURE_ENV_FILE: c.out, OBSCURE_KEY: SECRET },
    }
  );
  const loaded = (run.stdout.match(/LOADED=(.*)/) || [])[1];
  const expected = c.env.split('=')[1];
  check('preload 載入的值與明文完全相同', loaded === expected, `got=${loaded} expected=${expected}`);
  check('載入訊息標示的格式正確', (run.stderr || '').includes(`偽裝格式:${c.format}`), (run.stderr || '').trim());
}

// 以相同內容、不同金鑰再跑一次:確認 GCM 認證標籤能擋下錯誤金鑰
console.log('\n[跨格式] 錯誤金鑰防護');
{
  fs.writeFileSync(path.join(tmp, '.env'), 'FORMAT_MARK=wrong-key-test-9999\n');
  spawnSync(process.execPath, [CLI, '--secret', 'right-key', '--format', 'png'], { cwd: tmp, encoding: 'utf8' });
  const appPath = path.join(tmp, 'app.js');
  fs.writeFileSync(appPath, APP);
  const run = spawnSync(process.execPath, ['-r', REGISTER, appPath], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, OBSCURE_ENV_FILE: 'verify.png', OBSCURE_KEY: 'wrong-key' },
  });
  check('錯誤金鑰 → 拒絕解密', run.stdout.includes('LOADED=') && !run.stdout.includes('wrong-key-test-9999'));
  check('錯誤金鑰 → 印出提示且進程存活', run.status === 0 && /obscure-env/.test(run.stderr || ''));
}

function entropy(buf) {
  if (!buf.length) return 0;
  const freq = new Array(256).fill(0);
  for (const b of buf) freq[b]++;
  let h = 0;
  for (const f of freq) {
    if (!f) continue;
    const p = f / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

console.log(`\n結果:${pass} 通過,${fail} 失敗`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);

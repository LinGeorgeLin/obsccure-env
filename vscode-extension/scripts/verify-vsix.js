// scripts/verify-vsix.js —— 驗證打包出來的 .vsix 真的能用
//
// 為什麼需要這支腳本：
//   原始碼測得過，不代表封裝結果也對 —— 打包時可能漏檔、版本欄位不同步、
//   內附的核心路徑寫錯之類的問題。這支腳本把剛打包好的 .vsix 解壓到暫存目錄，
//   然後用同一套生命週期測試（../../test/extension-lifecycle.js）對著解壓出來的
//   內容跑一遍 —— 測的是「使用者真正裝到 VS Code 裡的那份」。
//
// 用法：node scripts/verify-vsix.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXT_DIR = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));
const VSIX = path.join(EXT_DIR, `${PKG.name}-${PKG.version}.vsix`);

if (!fs.existsSync(VSIX)) {
  console.error(`❌ 找不到 ${path.basename(VSIX)} —— 先跑 npm run package。`);
  process.exit(1);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'obscure-vsix-verify-'));
const testFile = path.resolve(EXT_DIR, '..', 'test', 'extension-lifecycle.js');

try {
  // 解壓 vsix（內含 extension/ 前綴的實際擴充套件內容）
  execFileSync('unzip', ['-q', '-o', VSIX, '-d', workdir], { stdio: 'inherit' });

  const extracted = path.join(workdir, 'extension');
  if (!fs.existsSync(path.join(extracted, 'extension.js'))) {
    console.error('❌ 解壓後找不到 extension/extension.js —— 封裝內容有問題。');
    process.exit(1);
  }

  console.log(`🔍 驗證 ${path.basename(VSIX)} 的內容…\n`);

  // 對著解壓出來的內容跑生命週期測試
  execFileSync(process.execPath, [testFile], {
    stdio: 'inherit',
    env: { ...process.env, OBSCCURE_EXT_DIR: extracted },
  });

  console.log(`\n✅ ${path.basename(VSIX)} 驗證通過。`);
} catch (err) {
  if (err.status) {
    console.error(`\n❌ 驗證失敗（${path.basename(VSIX)}）。`);
  }
  process.exit(err.status || 1);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

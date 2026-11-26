// scripts/stage-core.js —— 把 obscure-env 核心複製進擴充套件資料夾
//
// 為什麼需要這一步：
//   VSIX 只能打包擴充套件資料夾「裡面」的檔案，而核心在 `../src/`（套件本體）。
//   組員若把 VSIX 裝到 ~/.vscode/extensions/，核心並不在旁邊，
//   只能靠 obsccureEnv.corePath 指路 —— 換機器就得重填一次。
//   把核心一起打包進去，裝完就能直接用，免設定。
//
// 核心本體仍留在套件根目錄（`obsccure-env/src/`），npm 套件的結構完全不動；
// 這裡只是「打包時複製一份」到 vscode-extension/src/。
//
// 用法：node scripts/stage-core.js

const fs = require('fs');
const path = require('path');

const EXT_DIR = path.resolve(__dirname, '..');
const CORE_SRC = path.resolve(EXT_DIR, '..', 'src');
const TARGET = path.join(EXT_DIR, 'src');

// 擴充套件實際會 require 的核心檔案。
// 不含 register.js —— 那是給 Node 應用的 preload 進入點，擴充套件用不到。
const WANTED = ['crypto.js', 'index.js', 'parse-env.js', 'vault-ops.js', 'camouflage'];

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (!stat.isDirectory()) {
    // 單一檔案：確保目標目錄存在後直接複製
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    copyRecursive(path.join(from, entry.name), path.join(to, entry.name));
  }
}

// 先清掉舊的產物，避免刪檔後的殘留混進新封包
fs.rmSync(TARGET, { recursive: true, force: true });

if (!fs.existsSync(CORE_SRC)) {
  console.error(`❌ 找不到核心來源目錄: ${CORE_SRC}`);
  process.exit(1);
}

let count = 0;
for (const name of WANTED) {
  const src = path.join(CORE_SRC, name);
  if (!fs.existsSync(src)) {
    console.error(`❌ 核心缺少預期檔案: ${src}`);
    process.exit(1);
  }
  copyRecursive(src, path.join(TARGET, name));
  count++;
}

// 驗證關鍵檔案確實到位 —— 少了任何一個，裝了也會在執行期才爆
const REQUIRED = [
  'crypto.js',
  'index.js',
  'parse-env.js',
  'vault-ops.js',
  'camouflage/index.js',
  'camouflage/frame.js',
  'camouflage/formats/png.js',
  'camouflage/formats/log.js',
  'camouflage/formats/bin.js',
];
const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(TARGET, rel)));
if (missing.length) {
  console.error(`❌ 核心複製不完整，缺少: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`✅ 核心已複製到 ${path.relative(process.cwd(), TARGET)}（${count} 個項目）`);
console.log(`   包含: ${WANTED.join(', ')}`);

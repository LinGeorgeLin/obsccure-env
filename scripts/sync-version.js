// scripts/sync-version.js —— 把版本號從唯一來源（version.json）同步到各個檔案
//
// 為什麼需要這支腳本：
//   npm 套件的版本與 VS Code 擴充套件的版本各自住在自己的 package.json 裡，
//   但「要改版號」只該有一個地方 —— version.json。
//   這支腳本負責把 version.json 的值寫進去：
//
//     version.json.package    → package.json（npm 套件）
//                               package-lock.json
//                               ../test-project/package.json 的相依版本範圍
//     version.json.extension  → vscode-extension/package.json
//                               vscode-extension/package-lock.json
//
//   vsix 的檔名（obsccure-env-vscode-<版本>.vsix）與 extension.vsixmanifest
//   裡的 Version 欄位都是從 vscode-extension/package.json 讀的，
//   所以同步完這一處，套件的檔名與中繼資料就自動一致了。
//
// 用法：
//   node scripts/sync-version.js          同步（會改寫檔案）
//   node scripts/sync-version.js --check  只檢查有沒有落差，不改檔（落差時 exit 1）

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

// ── 讀取唯一來源 ────────────────────────────────────────────────
const versionFile = path.join(ROOT, 'version.json');
if (!fs.existsSync(versionFile)) {
  console.error(`❌ 找不到版本來源檔：${versionFile}`);
  process.exit(1);
}
const source = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
const versions = {
  package: source.package,
  extension: source.extension,
};

for (const [key, value] of Object.entries(versions)) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ''))) {
    console.error(`❌ version.json 的 "${key}" 不是合法的語意化版本號：${value}`);
    process.exit(1);
  }
}

// ── 要同步的目標 ────────────────────────────────────────────────
// 每個目標都是「某個 JSON 檔裡的某個欄位路徑」。
// 檔案不存在就跳過（例如 test-project 不在這個 repo 裡時）。
const targets = [
  { file: path.join(ROOT, 'package.json'), path: ['version'], value: versions.package },
  { file: path.join(ROOT, 'package-lock.json'), path: ['version'], value: versions.package },
  {
    file: path.join(ROOT, 'package-lock.json'),
    path: ['packages', '', 'version'],
    value: versions.package,
  },
  {
    file: path.join(ROOT, 'vscode-extension', 'package.json'),
    path: ['version'],
    value: versions.extension,
  },
  {
    file: path.join(ROOT, 'vscode-extension', 'package-lock.json'),
    path: ['version'],
    value: versions.extension,
  },
  {
    file: path.join(ROOT, 'vscode-extension', 'package-lock.json'),
    path: ['packages', '', 'version'],
    value: versions.extension,
  },
  {
    file: path.join(ROOT, '..', 'test-project', 'package.json'),
    path: ['dependencies', 'obscure-env'],
    value: `^${versions.package}`,
  },
];

// ── 讀出／寫入 ──────────────────────────────────────────────────
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getIn(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setIn(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// 先依檔案分組 —— 同一個檔案有多個目標時只讀寫一次
const byFile = new Map();
for (const t of targets) {
  if (!fs.existsSync(t.file)) continue;
  if (!byFile.has(t.file)) byFile.set(t.file, []);
  byFile.get(t.file).push(t);
}

const drifted = [];

for (const [file, list] of byFile) {
  const json = readJson(file);
  const changes = [];

  for (const t of list) {
    const current = getIn(json, t.path);
    if (current === t.value) continue;
    changes.push({ path: t.path.join('.') || '(root)', from: current, to: t.value });
    setIn(json, t.path, t.value);
  }

  if (changes.length === 0) continue;

  const rel = path.relative(ROOT, file);
  if (CHECK_ONLY) {
    drifted.push({ file: rel, changes });
    continue;
  }

  // 保持原本的縮排風格（package.json 慣用 2 空格）
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  for (const c of changes) {
    console.log(`✅ ${rel} → ${c.path}: ${c.from ?? '(無)'} → ${c.to}`);
  }
}

if (CHECK_ONLY) {
  if (drifted.length > 0) {
    console.error('\n❌ 版本號有落差（version.json 與下列檔案不一致）：');
    for (const d of drifted) {
      console.error(`   ${d.file}`);
      for (const c of d.changes) {
        console.error(`     ${c.path}: ${c.from ?? '(無)'} → ${c.to}`);
      }
    }
    console.error('\n   執行 node scripts/sync-version.js 修正。');
    process.exit(1);
  }
  console.log(
    `✅ 版本號一致（npm 套件 ${versions.package}、VS Code 擴充套件 ${versions.extension}）`
  );
} else {
  console.log(
    `✅ 版本號已同步 —— npm 套件 ${versions.package}、VS Code 擴充套件 ${versions.extension}`
  );
}

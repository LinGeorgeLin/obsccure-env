// 產生示範用保管檔:加密成 verify.txt(與 bin/cli.js 相同的純 JSON 格式)
// 執行:node demo/prepare.js
// 注意:此處內嵌的是「假的」示範值;真實使用請用你的 CLI 加密真正的 .env,
//       並在加密後刪除原始 .env — 目錄中不應留有任何明文機密檔。
const fs = require('fs');
const path = require('path');
const { encryptEnv } = require('../src/crypto');

const DEMO_ENV = [
  '# 示範環境變數(皆為虛構值)',
  'API_KEY=sk-demo-1234567890abcdef',
  'DB_PASS="p@ss w0rd #1"',
  'MSG=你好,obscure-env',
].join('\n');

const secret = process.env.OBSCURE_KEY || 'local-device-secret';
const out = process.argv[2] || path.join(__dirname, 'verify.txt');

fs.writeFileSync(out, encryptEnv(DEMO_ENV, secret), { mode: 0o600 });
console.log(
  `✅ 已產生 ${out}(金鑰來源:${process.env.OBSCURE_KEY ? 'OBSCURE_KEY 環境變數' : '預設 local-device-secret'})`
);
console.log('   檔案內容是高熵密文,AI/編輯器開啟只會看到無意義字串。');

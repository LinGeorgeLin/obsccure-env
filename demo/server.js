// 示範:以 localhost 方式「打開」obscure-env
// 執行:cd demo && node -r ../src/register.js server.js
// 然後瀏覽 http://127.0.0.1:8787
//
// 設計要點:
// - config() 已由 -r preload 執行完畢,此檔任何程式碼執行時 process.env 已是解密後的值
// - 只綁定 127.0.0.1:示範服務不對區域網路開放
// - 對瀏覽器的所有回應只含「鍵名與遮罩值」— 完整機密永不離開伺服器進程
const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const DEMO_KEYS = ['API_KEY', 'DB_PASS', 'MSG'];

// 遮罩:只露出前 2 字元,其餘以圓點取代並標註長度
function mask(value) {
  if (value === undefined) return { present: false, preview: '(未注入)' };
  if (value === '') return { present: true, preview: '(空字串)' };
  const dots = '•'.repeat(Math.max(0, Math.min(value.length - 2, 12)));
  return { present: true, preview: `${value.slice(0, 2)}${dots}(共 ${value.length} 字元)` };
}

const rows = DEMO_KEYS.map((key) => {
  const m = mask(process.env[key]);
  return `      <tr><td><code>${key}</code></td><td>${m.present ? '✅ 已注入' : '❌ 未注入'}</td><td><code>${m.preview}</code></td></tr>`;
}).join('\n');

const allInjected = DEMO_KEYS.every((k) => process.env[k] !== undefined);
const banner = allInjected
  ? '✅ obscure-env 已在此進程解密注入'
  : '⚠️ 尚未載入保管檔 — 請確認 cwd 內有 verify.txt,或設定 OBSCURE_ENV_FILE';

const html = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>obscure-env localhost 示範</title>
<style>
  body { font-family: -apple-system, "PingFang TC", sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #1c1c1e; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #d1d1d6; padding: .5rem .75rem; text-align: left; }
  th { background: #f2f2f7; }
  code { background: #f2f2f7; padding: .1rem .3rem; border-radius: 4px; }
  .note { color: #6e6e73; font-size: .9rem; }
</style></head>
<body>
  <h1>${banner}</h1>
  <table>
    <thead><tr><th>變數</th><th>狀態</th><th>遮罩預覽</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="note">完整值只存在於伺服器進程的 process.env — 硬碟上沒有明文,本頁回應也永遠只顯示遮罩。</p>
  <p class="note">試試 <code>/status</code>(JSON,僅鍵名)。重啟進程機密即隨記憶體釋放。</p>
</body></html>`;

http
  .createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify(
          {
            ok: DEMO_KEYS.every((k) => process.env[k] !== undefined),
            injectedKeys: DEMO_KEYS.filter((k) => process.env[k] !== undefined),
            note: '值不出伺服器進程',
          },
          null,
          2
        )
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  })
  .listen(PORT, HOST, () => {
    console.log(`obscure-env 示範伺服器 → http://${HOST}:${PORT}`);
  });

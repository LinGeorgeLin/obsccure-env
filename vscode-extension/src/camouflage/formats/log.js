const crypto = require('crypto');
const { MAGIC } = require('../frame');

// 文字雜訊偽裝:把真正的 Base64 行埋在一堆假的「完整性檢查」雜訊行之間,
// 適合 verify.txt 這類純文字檔 — AI 抓取後只看到高熵的無意義字串。

function build(payload) {
  const head = ['# integrity snapshot', '# auto-generated - do not edit'];

  const body = [];
  const junkCount = 24 + (crypto.randomBytes(1)[0] % 32);
  for (let i = 0; i < junkCount; i++) {
    const n = 40 + (crypto.randomBytes(1)[0] % 60);
    body.push('#' + crypto.randomBytes(n).toString('hex'));
  }
  // 真正的承載行:魔術標記(hex)+ Base64 payload + SHA-256 校驗(hex)
  const payloadLine =
    '#blk:' +
    MAGIC.toString('hex') +
    ':' +
    payload.toString('base64') +
    ':' +
    crypto.createHash('sha256').update(payload).digest('hex');
  const at = crypto.randomBytes(1)[0] % (body.length + 1);
  body.splice(at, 0, payloadLine);

  return Buffer.from(head.concat(body).join('\n') + '\n', 'utf8');
}

function extract(buffer) {
  const text = buffer.toString('latin1'); // 承載行為純 ASCII,latin1 讀取安全
  const re = new RegExp(
    '#blk:' + MAGIC.toString('hex') + ':([A-Za-z0-9+/=]+):([0-9a-f]{64})'
  );
  const m = text.match(re);
  if (!m) return null;
  let payload;
  try {
    payload = Buffer.from(m[1], 'base64');
  } catch (_) {
    return null;
  }
  const actual = crypto.createHash('sha256').update(payload).digest('hex');
  return actual === m[2] ? payload : null;
}

module.exports = { build, extract };

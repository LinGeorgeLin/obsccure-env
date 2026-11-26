const crypto = require('crypto');

// 框架魔術標記:由專案常數經 SHA-256 派生(取前 8 位元組),
// 避免使用明顯 ASCII 特徵,讓掃描器無法靠簽名直接命中「有價值位元組」。
const MAGIC = crypto.createHash('sha256').update('obscure-env-frame-v1').digest().subarray(0, 8);

// 將 payload 打包成框架:MAGIC(8) + 長度(4) + payload + SHA-256 校驗(32)
function frame(payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  const sum = crypto.createHash('sha256').update(payload).digest();
  return Buffer.concat([MAGIC, len, payload, sum]);
}

// 在任意位元組中定位並解析第一個合法框架;
// 回傳 payload 的獨立副本(呼叫端可安全清零原緩衝),找不到或校驗失敗回傳 null。
function unframe(buffer) {
  const idx = buffer.indexOf(MAGIC);
  if (idx === -1) return null;
  if (idx + 8 + 4 + 32 > buffer.length) return null;
  const len = buffer.readUInt32BE(idx + 8);
  if (len > 64 * 1024 * 1024) return null; // 合理性檢查,避免損壞資料導致瘋狂長度
  if (idx + 8 + 4 + len + 32 > buffer.length) return null;
  const payload = buffer.subarray(idx + 12, idx + 12 + len);
  const sum = buffer.subarray(idx + 12 + len, idx + 12 + len + 32);
  const actual = crypto.createHash('sha256').update(payload).digest();
  if (!actual.equals(sum)) return null;
  return Buffer.from(payload); // 獨立副本,與原緩衝脫鉤
}

module.exports = { MAGIC, frame, unframe };

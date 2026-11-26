const crypto = require('crypto');
const { frame, unframe } = require('../frame');

// 二進位雜訊偽裝:真正的框架埋在隨機位元組之中,
// 前後綴長度隨機,讓框架在檔案中的位置每次都不同。

function build(payload) {
  const headLen = 64 + (crypto.randomBytes(2).readUInt16BE(0) % 512);
  const tailLen = 64 + (crypto.randomBytes(2).readUInt16BE(0) % 512);
  const head = crypto.randomBytes(headLen);
  const tail = crypto.randomBytes(tailLen);
  return Buffer.concat([head, frame(payload), tail]);
}

function extract(buffer) {
  return unframe(buffer);
}

module.exports = { build, extract };

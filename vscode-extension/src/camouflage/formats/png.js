const zlib = require('zlib');
const crypto = require('crypto');
const { frame, unframe } = require('../frame');

// PNG 檔頭簽名(8 位元組)
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG 規範要求的 CRC32
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 組出單一 PNG chunk:長度(4) + 類型(4) + 資料 + CRC(4)
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// 產生一張真實可開啟的雜訊圖片(彩色靜電),加密框架附在 IEND 之後 —
// 一般解析器只讀到 IEND,圖片完全正常;框架對外只是圖檔尾端的隨機位元組。
function build(payload, opts = {}) {
  const width = opts.width || 128;
  const height = opts.height || 128;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // 其餘欄位(compression / filter / interlace)為 0,Buffer.alloc 已歸零

  // 每條掃描線以 filter byte 0 開頭,像素全為隨機值 → 高熵雜訊圖
  const stride = 1 + width * 3;
  const raw = crypto.randomBytes(height * stride);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
    frame(payload),
  ]);
}

function isPng(buffer) {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

function extract(buffer) {
  if (!isPng(buffer)) return null;
  return unframe(buffer);
}

module.exports = { build, extract, isPng };

const crypto = require('crypto');
const fs = require('fs');
const png = require('./formats/png');
const log = require('./formats/log');
const bin = require('./formats/bin');

// 偽裝容器登記表:
// - png:  真實雜訊圖片,框架附在 IEND 之後
// - log:  純文字雜訊行,承載行埋在其中(適合 .txt)
// - bin:  隨機二進位位元組,框架埋於其中
// - plain: 不加偽裝,直接輸出 JSON(與 CLI 原始輸出完全相容)
const FORMATS = {
  png,
  log,
  bin,
  plain: {
    build: (payload) => Buffer.from(payload),
    extract: null, // plain 由 unpack 的 JSON 偵測路徑處理
  },
};

// 將(加密後的)JSON 字串打包成指定偽裝格式的容器位元組
function pack(jsonString, { format = 'png' } = {}) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`obscure-env: 不支援的偽裝格式 "${format}"`);
  return fmt.build(Buffer.from(jsonString, 'utf8'));
}

// 從容器位元組還原 JSON 字串。
// 偵測順序:純 JSON(CLI 原始格式)→ PNG → 文字雜訊 → 二進位框架。
// 回傳 { jsonString, format };無法還原時回傳 null。
function unpack(buffer) {
  // 1) 純 JSON:必須具備 {s,i,t,d} 完整形狀才視為加密承載
  try {
    const s = buffer.toString('utf8');
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && obj.s && obj.i && obj.t && obj.d) {
      return { jsonString: s, format: 'plain' };
    }
  } catch (_) {
    /* 非純文字 JSON,續查各偽裝格式 */
  }

  // 2) PNG 偽裝
  if (png.isPng(buffer)) {
    const payload = png.extract(buffer);
    if (payload) return { jsonString: payload.toString('utf8'), format: 'png' };
    return null; // 具 PNG 簽名但框架損壞 → 視為損毀
  }

  // 3) 文字雜訊偽裝
  const logPayload = log.extract(buffer);
  if (logPayload) return { jsonString: logPayload.toString('utf8'), format: 'log' };

  // 4) 二進位框架
  const binPayload = bin.extract(buffer);
  if (binPayload) return { jsonString: binPayload.toString('utf8'), format: 'bin' };

  return null;
}

// 寫入保管檔:加密內容 + 偽裝,權限收斂為 0600
function writeVault(jsonString, filePath, opts = {}) {
  const packed = pack(jsonString, opts);
  fs.writeFileSync(filePath, packed, { mode: 0o600 });
  return { bytes: packed.length, format: opts.format || 'png' };
}

// 讀取保管檔;讀檔或還原失敗一律丟出統一訊息(不外洩內部細節)
function readVault(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (_) {
    throw new Error(`無法讀取保管檔 ${filePath}`);
  }
  const out = unpack(buffer);
  buffer.fill(0); // 用畢即清,盡力縮短密文在記憶體的滯留
  if (!out) throw new Error('保管檔已損壞或偽裝格式無法辨識');
  return out;
}

// 產生誘餌檔:外觀與真實保管檔完全相同,內容僅為隨機雜訊 —
// 結構合法、可被 unpack,但解密必失敗,用來混淆目錄掃描。
function generateDecoy(filePath, { format = 'png' } = {}) {
  const fmt = FORMATS[format];
  if (!fmt) throw new Error(`obscure-env: 不支援的偽裝格式 "${format}"`);
  const noise = crypto.randomBytes(256 + (crypto.randomBytes(1)[0] % 256));
  const packed = fmt.build(noise);
  fs.writeFileSync(filePath, packed, { mode: 0o600 });
  return { bytes: packed.length, format };
}

module.exports = { pack, unpack, writeVault, readVault, generateDecoy, FORMATS };

// 極簡 .env 解析器:
// - 支援 KEY=VALUE 與 KEY:VALUE
// - 支援 export 前綴、全行註解、單/雙引號
// - 雙引號內支援 \n \r \t \" \\ 轉義
// - 未加引號的值會去除行內註解(value 後的「 #...」)

function parseLine(line) {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice(7).trimStart();

  const m = s.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*[=:]\s?(.*)$/);
  if (!m) return null;
  const key = m[1];
  let value = m[2].trim();
  if (!value) return { key, value: '' };

  const quote = value[0];
  if (quote === "'" || quote === '"') {
    const end = value.lastIndexOf(quote);
    if (end > 0) {
      value = value.slice(1, end);
      if (quote === '"') {
        value = value
          .replace(/\\\\/g, '\u0000')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\u0000/g, '\\');
      }
      return { key, value };
    }
  }

  const hash = value.indexOf(' #');
  if (hash !== -1) value = value.slice(0, hash).trim();
  return { key, value };
}

function parseEnv(text) {
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

module.exports = { parseEnv, parseLine };

// scripts/build-vsix.js —— 產生可安裝的 .vsix（純 Node，不依賴 vsce）
//
// .vsix 本質是一個 zip，內含：
//   extension.vsixmanifest   —— 中繼資料（ID / 版本 / 發布者 / 引擎需求）
//   [Content_Types].xml       —— 內容型別對應
//   extension/                —— 擴充套件本體（extension.js、package.json、src/…）
//
// 官方做法是 `vsce package`，但那需要另外安裝 @vscode/vsce（此環境離線裝不了）。
// 這個腳本依同一份格式規格自行封裝，產出的檔案 VS Code 可以直接安裝。
// 若之後要改用官方的 vsce，只要把 scripts.package 換成 `vsce package` 即可。
//
// 用法：node scripts/build-vsix.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EXT_DIR = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));

// ── 決定要打包哪些檔案 ──
// 刻意不打包 node_modules（@types/vscode 有 750KB，VS Code 自己就有型別宣告）、
// .vscode/（開發用啟動設定）、scripts/（打包工具本身）、舊的 .vsix。
const INCLUDE = new Set(['extension.js', 'package.json', 'README.md', 'LICENSE']);
const EXCLUDE_DIRS = new Set(['node_modules', '.vscode', 'scripts', '.git']);
const EXCLUDE_FILES = new Set(['.DS_Store', 'package-lock.json']);

function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_FILES.has(entry.name)) continue;
    if (entry.name.endsWith('.vsix')) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(abs, rel));
    } else if (INCLUDE.has(rel) || rel.startsWith('src/')) {
      out.push(rel);
    }
  }
  return out;
}

const files = collect(EXT_DIR).sort();

if (!files.includes('extension.js')) {
  console.error('❌ 找不到 extension.js');
  process.exit(1);
}
if (!files.includes('src/vault-ops.js')) {
  console.error('❌ 找不到 src/vault-ops.js —— 請先執行 node scripts/stage-core.js');
  process.exit(1);
}

// ── 中繼資料 ──
const publisher = PKG.publisher || 'undefined';
const identity = `		<Identity Language="en-US" Id="${PKG.name}" Version="${PKG.version}" Publisher="${publisher}" />`;

const vsixmanifest = `<?xml version="1.0" encoding="utf-8"?>
	<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
		<Metadata>
			${identity}
			<DisplayName>${PKG.displayName || PKG.name}</DisplayName>
			<Description xml:space="preserve">${PKG.description || ''}</Description>
			<Tags></Tags>
			<Categories></Categories>
			<GalleryFlags>Public</GalleryFlags>
			<Properties>
				<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${(PKG.engines && PKG.engines.vscode) || '^1.85.0'}" />
				<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
				<Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
				<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
				<Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
				<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
				<Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
				<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
				<Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
			</Properties>
		</Metadata>
		<Installation>
			<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
		</Installation>
		<Dependencies/>
		<Assets>
			<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		</Assets>
	</PackageManifest>
`;

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
	<Default Extension="json" ContentType="application/json" />
	<Default Extension="js" ContentType="application/javascript" />
	<Default Extension="md" ContentType="text/markdown" />
	<Default Extension="txt" ContentType="text/plain" />
	<Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`;

// ── 最小 zip 寫出器（deflate + central directory）──
// 只用 Node 內建的 zlib，不引入任何第三方相依。
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// DOS 時間戳（固定值，讓同樣的內容打包出來結果一致）
const DOS_TIME = 0x0000;
const DOS_DATE = 0x2821; // 2024-01-01

function makeEntry(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(content, { level: 9 });
  const useDeflate = deflated.length < content.length;
  const body = useDeflate ? deflated : content;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // flags: UTF-8 名稱
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  return { local: Buffer.concat([local, nameBuf, body]), nameBuf, method, crc: crc32(content), compressed: body.length, size: content.length };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    chunks.push(e.local);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressed, 20);
    cd.writeUInt32LE(e.size, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, e.nameBuf]));
    offset += e.local.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

// ── 組裝 ──
const entries = [
  makeEntry('extension.vsixmanifest', Buffer.from(vsixmanifest, 'utf8')),
  makeEntry('[Content_Types].xml', Buffer.from(contentTypes, 'utf8')),
];

for (const rel of files) {
  const content = fs.readFileSync(path.join(EXT_DIR, rel));
  entries.push(makeEntry(`extension/${rel}`, content));
}

const outName = `${PKG.name}-${PKG.version}.vsix`;
const outPath = path.join(EXT_DIR, outName);
fs.writeFileSync(outPath, buildZip(entries));

console.log(`✅ 已產生 ${outName}`);
console.log(`   檔案數: ${entries.length}`);
console.log(`   大小: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
console.log(`   包含核心: ${files.some((f) => f.startsWith('src/')) ? '是（安裝後免設定）' : '否'}`);
console.log(`   發布者: ${publisher}`);
if (publisher === 'undefined') {
  console.log('   提醒: package.json 沒有 publisher 欄位，VS Code 會顯示為 undefined_publisher。');
}

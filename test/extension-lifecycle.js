// test/extension-lifecycle.js —— 用 mock 的 vscode API 來測試擴充套件的生命週期行為
//
// 手法：攔截 Module._load，把 require('vscode') 換成我們的假 API，
// 然後在暫存目錄裡跑真實的封存／還原／轉換，檢查結果是否符合預期。
//
// 被測對象由 OBSCCURE_EXT_DIR 決定：
//   預設           → 同一個 repo 裡的 vscode-extension/（測原始碼）
//   指向解壓目錄   → 測打包後的 vsix 內容（scripts/verify-vsix.js 會這麼做）

const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_DIR = process.env.OBSCCURE_EXT_DIR
  ? path.resolve(process.env.OBSCCURE_EXT_DIR)
  : path.resolve(__dirname, '..', 'vscode-extension');
const EXT_PATH = path.join(EXT_DIR, 'extension.js');
const CORE = path.join(EXT_DIR, 'src', 'vault-ops.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ''));
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

// ── mock vscode ────────────────────────────────────────────────
function makeMock(state) {
  const disposable = () => ({ dispose() {} });

  return {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { file: (p) => ({ fsPath: p }) },
    env: {
      onWillShutdown: {
        listener: (fn) => {
          state.shutdownHandlers.push(fn);
          return disposable();
        },
      },
    },
    workspace: {
      workspaceFolders: state.root
        ? [{ uri: { fsPath: state.root }, name: 'ws', index: 0 }]
        : undefined,
      getConfiguration: (section) => ({
        get: (key, def) => {
          const full = `${section}.${key}`;
          return Object.prototype.hasOwnProperty.call(state.config, full)
            ? state.config[full]
            : def;
        },
        update: (key, value) => {
          state.config[`${section}.${key}`] = value;
          return Promise.resolve();
        },
      }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable(),
        onDidDelete: () => disposable(),
        onDidChange: () => disposable(),
        dispose() {},
      }),
      onDidChangeWorkspaceFolders: () => disposable(),
      onDidChangeConfiguration: () => disposable(),
    },
    window: {
      createStatusBarItem: () => ({
        text: '',
        tooltip: '',
        command: '',
        show() {},
        hide() {},
        dispose() {},
      }),
      showInformationMessage: (msg, ...items) => {
        state.info.push({ msg, items });
        return Promise.resolve(state.nextInfo);
      },
      showErrorMessage: (msg) => {
        state.errors.push(msg);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (msg) => {
        state.warnings.push(msg);
        return Promise.resolve(undefined);
      },
      showQuickPick: (items, opts) => {
        state.quickPicks.push({ items, opts });
        const wanted = state.nextPicks.length ? state.nextPicks.shift() : state.nextPick;
        if (wanted === undefined || wanted === null) return Promise.resolve(undefined);
        // 可以只給 label 字串 —— 自動對應回清單裡真正的項目物件
        if (typeof wanted === 'string') {
          const hit = items.find((i) => i.label === wanted);
          return Promise.resolve(hit || undefined);
        }
        // 給了 label 但不是清單裡的項目 → 補上對應欄位
        if (wanted.vault === undefined && wanted.label !== undefined) {
          const hit = items.find((i) => i.label === wanted.label);
          if (hit) return Promise.resolve(hit);
        }
        return Promise.resolve(wanted);
      },
      onDidChangeWindowState: (fn) => {
        state.windowStateHandlers.push(fn);
        return disposable();
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        state.commands[id] = fn;
        return disposable();
      },
      executeCommand: (id) => {
        const fn = state.commands[id];
        return Promise.resolve(fn ? fn() : undefined);
      },
    },
  };
}

// ── 載入一份全新的 extension 實例 ───────────────────────────────
function loadExtension(state) {
  const mock = makeMock(state);

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') return mock;
    return origLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve(EXT_PATH)];
  const ext = require(EXT_PATH);
  Module._load = origLoad;
  return ext;
}

function newState(config = {}, root = null) {
  return {
    config,
    root,
    commands: {},
    info: [],
    errors: [],
    warnings: [],
    quickPicks: [],
    windowStateHandlers: [],
    shutdownHandlers: [],
    nextInfo: undefined,
    nextPick: undefined,
    nextPicks: [],
  };
}

const makeContext = () => ({ subscriptions: [] });

// ── 測試工具 ───────────────────────────────────────────────────
let tmpCounter = 0;
function makeWorkspace({ env = 'DATABASE_URL=postgres://x\nAPI_KEY=abc123\n', files = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `obsccure-ext-${process.pid}-${tmpCounter++}-`));
  if (env !== null) fs.writeFileSync(path.join(root, '.env'), env);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

function sealFixture(root, format = 'png', secret = 'local-device-secret') {
  const core = require(CORE);
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, 'DATABASE_URL=postgres://x\nAPI_KEY=abc123\n');
  }
  const out = path.join(root, core.vaultFileName(format));
  core.sealEnv({ envPath, format, secret, outPath: out });
  return out;
}

function readCipher(root, file) {
  const core = require(CORE);
  const info = core.inspectVault(path.join(root, file));
  return info ? info.jsonString : null;
}

// 每個情境都要一份全新的擴充套件實例 —— 把模組狀態（cachedRoot、shutdownState…）清掉
function clean() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(EXT_DIR)) delete require.cache[k];
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ── 情境 ───────────────────────────────────────────────────────
async function main() {
  console.log('\n[S1] activate 註冊 6 個指令');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    const ids = Object.keys(st.commands).sort();
    check('註冊了 6 個指令', ids.length === 6, `實際 ${ids.length}`);
    check(
      '指令 id 正確',
      JSON.stringify(ids) ===
        JSON.stringify([
          'obsccureEnv.convertFormat',
          'obsccureEnv.decrypt',
          'obsccureEnv.encrypt',
          'obsccureEnv.restore',
          'obsccureEnv.seal',
          'obsccureEnv.statusHint',
        ]),
      ids.join(',')
    );
    check('訂閱了視窗狀態監聽', st.windowStateHandlers.length === 1);
    clean();
  }

  console.log('\n[S2] 封存指令：.env → verify.png');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    st.nextInfo = '轉換';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.seal']();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    check(
      '.gitignore 已更新',
      fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('verify.png')
    );
    check('沒有錯誤訊息', st.errors.length === 0, st.errors.join(' | '));
    clean();
  }

  console.log('\n[S3] 還原指令：verify.png → .env 並刪除保管檔');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    check('前置：verify.png 存在', fs.existsSync(path.join(root, 'verify.png')));
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.restore']();
    check('.env 已還原', fs.existsSync(path.join(root, '.env')));
    check(
      '內容正確',
      fs.readFileSync(path.join(root, '.env'), 'utf8').includes('DATABASE_URL=postgres://x')
    );
    check('偽裝保管檔已刪除', !fs.existsSync(path.join(root, 'verify.png')));
    clean();
  }

  console.log('\n[S4] 格式轉換指令：png → bin，密文不變');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const before = readCipher(root, 'verify.png');
    const st = newState({}, root);
    st.nextPicks = ['verify.png', 'bin'];
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.convertFormat']();
    check('vault.bin 已產生', fs.existsSync(path.join(root, 'vault.bin')));
    check('verify.png 已移除', !fs.existsSync(path.join(root, 'verify.png')));
    check('密文逐字相同（舊金鑰仍有效）', before === readCipher(root, 'vault.bin'));
    check('沒有錯誤訊息', st.errors.length === 0, st.errors.join(' | '));
    clean();
  }

  console.log('\n[S5] 純密文路線：encrypt → verify.txt');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.encrypt']();
    check('verify.txt 已產生', fs.existsSync(path.join(root, 'verify.txt')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    const parsed = JSON.parse(fs.readFileSync(path.join(root, 'verify.txt'), 'utf8'));
    check('是 {s,i,t,d} 形狀', ['s', 'i', 't', 'd'].every((k) => k in parsed));
    clean();
  }

  console.log('\n[S6] 純密文路線：decrypt → .env');
  {
    const root = makeWorkspace({ env: null });
    const { encryptEnv } = require(path.join(EXT_DIR, 'src', 'crypto.js'));
    const { writeVault } = require(path.join(EXT_DIR, 'src', 'camouflage'));
    writeVault(encryptEnv('API_KEY=zzz\n', 'local-device-secret'), path.join(root, 'verify.txt'), {
      format: 'plain',
    });
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.decrypt']();
    check('.env 已還原', fs.existsSync(path.join(root, '.env')));
    check('內容正確', fs.readFileSync(path.join(root, '.env'), 'utf8') === 'API_KEY=zzz\n');
    clean();
  }

  console.log('\n[S7] statusHint 顯示狀態');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.statusHint']();
    check('有顯示資訊', st.info.length > 0);
    check('提到偽裝格式', st.info.some((i) => i.msg.includes('偽裝格式設定')));
    check('提到 .env 存在', st.info.some((i) => i.msg.includes('.env：存在')));
    clean();
  }

  console.log('\n[S8] 視窗失焦 → 跳出詢問');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('跳出了詢問', st.info.length === 1, `實際 ${st.info.length}`);
    check(
      '按鈕是 轉換/取消/完全自動',
      st.info[0] && st.info[0].items.join(',') === '轉換,取消,完全自動（不再詢問）'
    );
    clean();
  }

  console.log('\n[S8b] 視窗保持焦點 → 不跳詢問');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: true });
    await tick();
    check('沒有跳詢問', st.info.length === 0);
    clean();
  }

  console.log('\n[S9] 失焦 → 選「轉換」→ 完成封存');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    st.nextInfo = '轉換';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S10] 失焦 → 選「取消」→ 關窗時也不封存');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    st.nextInfo = '取消';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    ext.deactivate();
    check('.env 保持原狀', fs.existsSync(path.join(root, '.env')));
    check('沒有產生保管檔', !fs.existsSync(path.join(root, 'verify.png')));
    clean();
  }

  console.log('\n[S11] autoEncrypt=true → 失焦直接封存，不跳詢問');
  {
    const root = makeWorkspace();
    const st = newState({ 'obsccureEnv.autoEncrypt': true }, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('沒有跳詢問', st.info.length === 0, `實際 ${st.info.length}`);
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S12] 直接關窗（deactivate）→ 自動封存');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    ext.deactivate();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S13] sealOnClose=never → 關窗不動 .env');
  {
    const root = makeWorkspace();
    const st = newState({ 'obsccureEnv.sealOnClose': 'never' }, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    ext.deactivate();
    check('.env 保持原狀', fs.existsSync(path.join(root, '.env')));
    check('沒有產生保管檔', !fs.existsSync(path.join(root, 'verify.png')));
    clean();
  }

  console.log('\n[S14] sealOnClose=always → 就算按過取消也照封');
  {
    const root = makeWorkspace();
    const st = newState({ 'obsccureEnv.sealOnClose': 'always' }, root);
    st.nextInfo = '取消';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    ext.deactivate();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S15] 已有保管檔 + .env → 不覆寫既有資料');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const original = fs.readFileSync(path.join(root, 'verify.png'));
    fs.writeFileSync(path.join(root, '.env'), 'NEW=secret\n');
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    ext.deactivate();
    check('.env 保持原狀', fs.existsSync(path.join(root, '.env')));
    check('verify.png 內容未被改動', fs.readFileSync(path.join(root, 'verify.png')).equals(original));
    clean();
  }

  console.log('\n[S16] 系統關機／登出路徑（env.onWillShutdown）');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    check('已訂閱 onWillShutdown', st.shutdownHandlers.length === 1);
    st.shutdownHandlers[0]();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S17] 開啟專案 → 提示解密');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const st = newState({}, root);
    st.nextInfo = '解密';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await tick(400);
    check('跳出了解密詢問', st.info.some((i) => i.msg.includes('是否解密還原')));
    check('.env 已還原', fs.existsSync(path.join(root, '.env')));
    check('保管檔已刪除', !fs.existsSync(path.join(root, 'verify.png')));
    clean();
  }

  console.log('\n[S18] autoDecrypt=true → 開啟專案自動解密');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const st = newState({ 'obsccureEnv.autoDecrypt': true }, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await tick(400);
    check('.env 已還原', fs.existsSync(path.join(root, '.env')));
    check('沒有跳詢問', !st.info.some((i) => i.msg.includes('是否解密還原')));
    clean();
  }

  console.log('\n[S19] 已經封存（無 .env）→ 失焦不跳詢問');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const st = newState({}, root);
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('沒有跳詢問', st.info.length === 0);
    clean();
  }

  console.log('\n[S20] 提示被直接關掉 → 關窗時仍封存（保護優先）');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    st.nextInfo = undefined; // 使用者沒按任何按鈕
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('確實跳了詢問', st.info.length === 1);
    ext.deactivate();
    check('關窗時仍完成封存', fs.existsSync(path.join(root, 'verify.png')));
    check('.env 已移除', !fs.existsSync(path.join(root, '.env')));
    clean();
  }

  console.log('\n[S21] 重複失焦不會重複跳詢問');
  {
    const root = makeWorkspace();
    const st = newState({}, root);
    st.nextInfo = '取消';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    st.windowStateHandlers[0]({ focused: false });
    st.windowStateHandlers[0]({ focused: true });
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('只跳一次詢問', st.info.length === 1, `實際 ${st.info.length}`);
    clean();
  }

  console.log('\n[S22] 純密文 verify.txt → 失焦詢問 → 轉成偽裝檔（密文不變）');
  {
    const root = makeWorkspace({ env: null });
    const { encryptEnv } = require(path.join(EXT_DIR, 'src', 'crypto.js'));
    const { writeVault } = require(path.join(EXT_DIR, 'src', 'camouflage'));
    writeVault(encryptEnv('TOKEN=keep\n', 'local-device-secret'), path.join(root, 'verify.txt'), {
      format: 'plain',
    });
    const before = readCipher(root, 'verify.txt');
    const st = newState({}, root);
    st.nextInfo = '轉換';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    st.windowStateHandlers[0]({ focused: false });
    await tick();
    check('verify.png 已產生', fs.existsSync(path.join(root, 'verify.png')));
    check('verify.txt 已移除', !fs.existsSync(path.join(root, 'verify.txt')));
    check('密文逐字相同（舊金鑰仍有效）', before === readCipher(root, 'verify.png'));
    clean();
  }

  console.log('\n[S23] 沒有開啟專案 → 不崩潰');
  {
    const st = newState({}, null);
    const ext = loadExtension(st);
    let threw = false;
    try {
      ext.activate(makeContext());
    } catch (e) {
      threw = true;
      console.log('    ' + e.message);
    }
    check('activate 沒有拋錯', !threw);
    clean();
  }

  console.log('\n[S24] 覆寫保護：手動封存時目標已存在 → 報錯且不動資料');
  {
    const root = makeWorkspace({ env: null });
    sealFixture(root, 'png');
    const original = fs.readFileSync(path.join(root, 'verify.png'));
    fs.writeFileSync(path.join(root, '.env'), 'NEW=secret\n');
    const st = newState({}, root);
    st.nextInfo = '轉換';
    const ext = loadExtension(st);
    ext.activate(makeContext());
    await st.commands['obsccureEnv.seal']();
    check('有錯誤訊息', st.errors.length > 0, st.errors.join(' | '));
    check('.env 保持原狀', fs.existsSync(path.join(root, '.env')));
    check('verify.png 內容未被改動', fs.readFileSync(path.join(root, 'verify.png')).equals(original));
    clean();
  }

  // ── 總結 ─────────────────────────────────────────────────────
  console.log(`\n結果:${pass} 通過,${fail} 失敗`);
  if (fail > 0) {
    console.log('\n失敗項目:');
    for (const f of failures) console.log('  · ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n測試腳本本身出錯：', e);
  process.exit(1);
});

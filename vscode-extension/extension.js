const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let cachedCore = null;
let camoStatusBtn = null;   // 偽裝路線的狀態列
let txtStatusBtn = null;    // 純密文(txt)路線的狀態列（既有功能）
// 生命週期狀態：
//   asked    —— 已經問過使用者一次（避免反覆跳提示）
//   done     —— 已經封存完成，不需要再動
//   declined —— 使用者明確按了「取消」，不再自動封存
let shutdownState = { asked: false, done: false, declined: false };
let cachedRoot = null;

// 可偽裝的三種格式（純密文 verify.txt 不在此列 —— 那是既有路線）
const CAMOUFLAGE_FORMATS = ['png', 'log', 'bin'];

// 關窗時的三種處置策略
const SEAL_ON_CLOSE_MODES = ['prompt', 'always', 'never'];

function getCoreModules() {
  if (cachedCore) return cachedCore;

  const configuredCorePath = vscode.workspace
    .getConfiguration('obsccureEnv')
    .get('corePath', '')
    .trim();

  // 候選根目錄（每個候選底下都要有 src/crypto 與 src/camouflage）：
  //   1. 使用者在設定裡明確指定的路徑
  //   2. 擴充套件資料夾本身 —— 安裝後核心被包在 <extension>/src/ 的情況（免設定）
  //   3. 擴充套件資料夾的上一層 —— 開發模式下 ../src/ 的情況
  //   4. 上兩層、../../obsccure-env —— 專案內其他編排方式
  //   5. 目前開啟的專案資料夾
  //   6. 專案底下的 node_modules/obscure-env —— 專案有裝這個套件時最省事
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const candidateBases = [
    configuredCorePath,
    path.resolve(__dirname),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../obsccure-env'),
    workspaceRoot,
    workspaceRoot ? path.join(workspaceRoot, 'node_modules', 'obscure-env') : null,
  ].filter(Boolean);

  for (const base of candidateBases) {
    const cryptoPath = path.join(base, 'src', 'crypto');
    const camouflagePath = path.join(base, 'src', 'camouflage');
    const hasCrypto =
      fs.existsSync(cryptoPath + '.js') || fs.existsSync(path.join(cryptoPath, 'index.js'));
    const hasCamouflage =
      fs.existsSync(camouflagePath + '.js') ||
      fs.existsSync(path.join(camouflagePath, 'index.js'));

    if (hasCrypto && hasCamouflage) {
      const core = {
        ...require(cryptoPath),
        ...require(camouflagePath),
      };

      // vault-ops 是偽裝路線的檔案層核心（封存/還原/格式轉換）。
      // 舊版核心可能沒有這個檔案 —— 缺了就把偽裝路線整個停用，
      // 純密文路線仍可正常使用（降級而不是整個擴充套件壞掉）。
      const vaultOpsPath = path.join(base, 'src', 'vault-ops');
      if (
        fs.existsSync(vaultOpsPath + '.js') ||
        fs.existsSync(path.join(vaultOpsPath, 'index.js'))
      ) {
        try {
          Object.assign(core, require(vaultOpsPath));
          core.hasVaultOps = true;
        } catch (_) {
          core.hasVaultOps = false;
        }
      } else {
        core.hasVaultOps = false;
      }

      cachedCore = core;
      return cachedCore;
    }
  }

  throw new Error(
    `找不到 src/crypto 或 src/camouflage。請在 VS Code 設定中填寫 obsccureEnv.corePath（已搜尋：${candidateBases.join(' ; ')}）`
  );
}

function getConfig() {
  return vscode.workspace.getConfiguration('obsccureEnv');
}

// 目前選擇的偽裝格式；設定值不合法時退回 png
function getCamouflageFormat() {
  const value = getConfig().get('camouflageFormat', 'png');
  return CAMOUFLAGE_FORMATS.includes(value) ? value : 'png';
}

// 開啟專案就自動解密
function isAutoDecryptEnabled() {
  return getConfig().get('autoDecrypt', false) === true;
}

// 完全自動：關閉時不再詢問，直接封存
function isAutoEncryptEnabled() {
  return getConfig().get('autoEncrypt', false) === true;
}

// 關窗時的處置策略：
//   'prompt'（預設）—— 問過使用者；使用者明確按「取消」就不封存，否則封存
//   'always'        —— 一律封存（連「取消」都無視）
//   'never'         —— 關窗時不動 .env，只有手動指令能封存
function getSealOnClose() {
  const value = getConfig().get('sealOnClose', 'prompt');
  return SEAL_ON_CLOSE_MODES.includes(value) ? value : 'prompt';
}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('請先開啟一個專案資料夾再操作。');
    return null;
  }
  return folders[0].uri.fsPath;
}

function getSecretKey() {
  return process.env.OBSCURE_KEY || 'local-device-secret';
}

function ensureGitignore(root) {
  const gitignorePath = path.join(root, '.gitignore');
  const entriesToEnsure = ['.env', 'verify.txt', 'verify.png', 'verify.log', 'vault.bin'];

  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split(/\r?\n/);
  const normalizedSet = new Set(lines.map((line) => line.trim()));
  const missing = entriesToEnsure.filter((entry) => !normalizedSet.has(entry));

  if (missing.length > 0) {
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const updated = `${content}${prefix}${missing.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, updated, 'utf8');
  }
}

// ── 偽裝路線：狀態判定 ──────────────────────────────────
// 格式一律「依內容」辨識（findVaults → readVault → unpack），不看副檔名。
// 同一個檔名在不同情況下可能是不同格式，只有內容說得準。
// 因此 verify.txt 有可能是純密文（txt 路線），也有可能是 log 偽裝檔 ——
// 由內容決定它屬於哪條路線。
function inspectState(root) {
  const core = getCoreModules();
  const envPath = path.join(root, '.env');
  const hasEnv = fs.existsSync(envPath);

  if (!core.hasVaultOps) {
    return { hasEnv, camoVaults: [], plainVault: null, hasVaultOps: false };
  }

  const vaults = core.findVaults(root);
  const camoVaults = vaults.filter((v) => CAMOUFLAGE_FORMATS.includes(v.format));
  const plainVault = vaults.find((v) => v.format === 'plain') || null;

  return { hasEnv, camoVaults, plainVault, hasVaultOps: true };
}

// 決定關閉前要「封存」的來源：
//   1. 有 .env          → 加密後套上偽裝外殼（並刪除明文）
//   2. 只有純密文 verify.txt → 換外殼即可（密文不變，金鑰不變）
//   3. 已有偽裝保管檔   → 已經封存好了，不需要動
function planSeal(root) {
  const state = inspectState(root);
  if (!state.hasVaultOps) return { kind: 'unsupported' };
  if (state.hasEnv) return { kind: 'env' };
  if (state.plainVault) return { kind: 'plain', vaultPath: state.plainVault.file };
  if (state.camoVaults.length > 0) return { kind: 'already', camoVaults: state.camoVaults };
  return { kind: 'none' };
}

// 執行封存。全部是同步檔案操作 —— 即使視窗正在關閉也能完成。
function performSeal(root, plan) {
  const core = getCoreModules();
  const format = getCamouflageFormat();
  const target = path.join(root, core.vaultFileName(format));

  // 不覆寫既有保管檔。
  // sealEnv / convertVault 都是無條件寫入目標檔 —— 若目標已經存在，
  // 封存會把別的保管檔直接蓋掉。關窗時的自動封存尤其不能冒這個險：
  // 寧可這次不封存（.env 保持原狀），也不要毀掉既有資料。
  if (fs.existsSync(target)) {
    const sourcePath = plan.kind === 'env' ? path.join(root, '.env') : plan.vaultPath;
    if (path.resolve(target) !== path.resolve(sourcePath)) {
      throw new Error(
        `目標保管檔 ${path.basename(target)} 已經存在 —— 為了不覆寫既有資料，這次不封存。` +
          `請先還原或刪除該檔，或改用其他偽裝格式（obsccureEnv.camouflageFormat）。`
      );
    }
  }

  if (plan.kind === 'env') {
    const result = core.sealEnv({
      envPath: path.join(root, '.env'),
      format,
      secret: getSecretKey(),
      outPath: target,
    });
    ensureGitignore(root);
    return { ok: true, message: `已封存為 ${path.basename(result.file)}（${format} 偽裝），.env 已移除。` };
  }

  if (plan.kind === 'plain') {
    // 同一份密文換外殼 —— 不重新加密，所以舊金鑰仍然有效
    const result = core.convertVault({
      vaultPath: plan.vaultPath,
      format,
      outPath: target,
      removeSource: true,
    });
    ensureGitignore(root);
    return {
      ok: true,
      message: `已把 ${path.basename(plan.vaultPath)} 轉換為 ${path.basename(result.file)}（${format} 偽裝），密文與金鑰不變。`,
    };
  }

  return { ok: false, message: '沒有可封存的內容。' };
}

// 從偽裝保管檔還原 .env，並移除該保管檔。
// 與封存方向對稱：seal 把 .env 換成保管檔，restore 把保管檔換回 .env。
// 保管檔的唯一用處就是守住 .env —— 還原出 .env 之後它只是多餘的密文副本，
// 留著反而多一份檔案等著被掃描器看到。
function performRestore(root, vaultFile) {
  const core = getCoreModules();
  const result = core.restoreVault({
    vaultPath: vaultFile,
    envPath: path.join(root, '.env'),
    candidates: core.resolveSecretCandidates(),
  });

  // 只在解密成功、.env 確實寫出來之後才刪保管檔。
  // restoreVault 擲錯代表 .env 沒寫成 —— 此時保管檔必須留著，否則資料全沒了。
  let removed = false;
  try {
    fs.unlinkSync(vaultFile);
    removed = true;
  } catch (_) {
    /* 刪不掉不算還原失敗 —— .env 已經回來了，保管檔留著只是冗餘 */
  }

  ensureGitignore(root);
  const note = removed
    ? '，偽裝保管檔已一併移除。'
    : '（偽裝保管檔刪除失敗，請手動移除。）';
  return {
    ok: true,
    removed,
    message: `已從 ${path.basename(vaultFile)} 解密還原 .env（偽裝格式：${result.format}）${note}`,
  };
}

// ── 狀態列 ────────────────────────────────────────────────
function updateCamoStatusBar() {
  if (!camoStatusBtn) return;

  const root = cachedRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    camoStatusBtn.text = '$(shield) 偽裝防護';
    camoStatusBtn.tooltip = '請先開啟專案資料夾';
    camoStatusBtn.command = 'obsccureEnv.statusHint';
    camoStatusBtn.show();
    return;
  }

  const format = getCamouflageFormat();
  const targetName = getCoreModules().vaultFileName(format);
  let state;
  try {
    state = inspectState(root);
  } catch (_) {
    state = { hasEnv: false, camoVaults: [], plainVault: null, hasVaultOps: false };
  }

  if (!state.hasVaultOps) {
    camoStatusBtn.text = '$(shield) 偽裝防護（不可用）';
    camoStatusBtn.tooltip = '找不到 src/vault-ops，請更新 obsccureEnv.corePath 指向的核心版本。';
    camoStatusBtn.command = 'obsccureEnv.statusHint';
    camoStatusBtn.show();
    return;
  }

  const camoName = state.camoVaults.length
    ? path.basename(state.camoVaults[0].file)
    : targetName;

  if (state.hasEnv && state.camoVaults.length > 0) {
    camoStatusBtn.text = '$(warning) .env 與保管檔並存';
    camoStatusBtn.tooltip = `偵測到 .env 與偽裝保管檔 ${camoName} 同時存在。點擊查看說明。`;
    camoStatusBtn.command = 'obsccureEnv.statusHint';
  } else if (state.hasEnv) {
    camoStatusBtn.text = '$(shield) 未封存';
    camoStatusBtn.tooltip = `工作階段結束時會詢問是否將 .env 封存為 ${targetName}（${format} 偽裝）。點擊立即封存。`;
    camoStatusBtn.command = 'obsccureEnv.seal';
  } else if (state.camoVaults.length > 0) {
    camoStatusBtn.text = '$(shield) 已封存';
    camoStatusBtn.tooltip = `已封存於 ${camoName}。工作階段開始時會詢問是否解密。點擊立即還原。`;
    camoStatusBtn.command = 'obsccureEnv.restore';
  } else {
    camoStatusBtn.text = '$(shield) 偽裝防護';
    camoStatusBtn.tooltip = `尚無 .env 或偽裝保管檔。工作階段結束時會詢問是否封存為 ${targetName}。`;
    camoStatusBtn.command = 'obsccureEnv.statusHint';
  }

  camoStatusBtn.show();
}

// 純密文(txt)路線的狀態列 —— 既有功能，行為不變
function updateTxtStatusBar() {
  if (!txtStatusBtn) return;

  const root = cachedRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    txtStatusBtn.text = '$(shield) Env Guard';
    txtStatusBtn.tooltip = '請先開啟專案資料夾';
    txtStatusBtn.command = 'obsccureEnv.statusHint';
    txtStatusBtn.show();
    return;
  }

  const hasEnv = fs.existsSync(path.join(root, '.env'));
  const hasVault = fs.existsSync(path.join(root, 'verify.txt'));

  if (hasEnv) {
    txtStatusBtn.text = '$(lock) Lock .env';
    txtStatusBtn.tooltip = '偵測到 .env：點擊加密為 verify.txt 並移除明文';
    txtStatusBtn.command = 'obsccureEnv.encrypt';
  } else if (hasVault) {
    txtStatusBtn.text = '$(unlock) Restore .env';
    txtStatusBtn.tooltip = '偵測到 verify.txt：點擊解密還原為 .env';
    txtStatusBtn.command = 'obsccureEnv.decrypt';
  } else {
    txtStatusBtn.text = '$(warning) No .env / Vault';
    txtStatusBtn.tooltip = '找不到 .env 或 verify.txt，點擊查看提示';
    txtStatusBtn.command = 'obsccureEnv.statusHint';
  }

  txtStatusBtn.show();
}

function updateAllStatusBars() {
  updateCamoStatusBar();
  updateTxtStatusBar();
}

// ── 生命週期：開啟專案 → 詢問是否解密 ────────────────────
async function handleStartup() {
  const root = cachedRoot;
  if (!root) return;

  const core = getCoreModules();
  if (!core.hasVaultOps) return;

  const state = inspectState(root);
  if (state.camoVaults.length === 0) return;
  // 已經有明文 .env 就不動它 —— 避免蓋掉使用者正在編輯的內容
  if (state.hasEnv) return;

  const vaultFile = state.camoVaults[0].file;
  const vaultName = path.basename(vaultFile);

  if (isAutoDecryptEnabled()) {
    try {
      const result = performRestore(root, vaultFile);
      vscode.window.showInformationMessage(`[obscure-env] ${result.message}`);
    } catch (err) {
      vscode.window.showErrorMessage(`[obscure-env] 自動解密失敗：${err.message}`);
    }
    updateAllStatusBars();
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `偵測到未解密的偽裝文件（${vaultName}），是否解密還原為 .env？`,
    '解密',
    '忽略',
    '以後自動解密'
  );

  if (choice === '解密') {
    try {
      const result = performRestore(root, vaultFile);
      vscode.window.showInformationMessage(result.message);
    } catch (err) {
      vscode.window.showErrorMessage(`解密失敗：${err.message}`);
    }
  } else if (choice === '以後自動解密') {
    await getConfig().update('autoDecrypt', true, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      '已啟用「開啟專案就自動解密」。要關閉請到設定 obsccureEnv.autoDecrypt。'
    );
  }

  updateAllStatusBars();
}

// ── 生命週期：關閉 VS Code 前 → 詢問是否封存 ────────────
//
// VS Code 的公開 API 沒有「視窗即將關閉」的事件。查證結果（VS Code 1.147.0 / @types 1.146.0）：
//
//   · vscode.env.onWillShutdown —— 不在公開 API（out/vscode-dts/vscode.d.ts 零命中，
//     且套件沒有附任何 vscode.proposed.*.d.ts），但執行期確實存在。
//     主執行緒把它接在 powerService 上：
//       this.powerService.onWillShutdown(this.proxy.$onWillShutdown, this.proxy)
//     所以它只在「系統關機／登出」時觸發，對「使用者按 Cmd+Shift+W 關視窗」完全無效。
//     而且 $onWillShutdown() 不帶任何參數，沒有 waitUntil —— 無法暫停關閉流程來等回應。
//   · deactivate() —— 視窗關閉時必定執行，且有 5 秒等待窗口，
//     但那時視窗正在消失，showInformationMessage 送不出去（送出去也看不見）。
//
// 因此詢問必須在使用者「還看得見視窗」的時候做，也就是視窗失去焦點的那一刻 ——
// 使用者切去別的 app、或正要關視窗，都會先經過這個狀態。
// 這是公開 API（window.onDidChangeWindowState），能正常顯示提示並等待回應。
//
// 完整行為：
//   視窗失焦      → handleWindowBlur()：跳出詢問（轉換 / 取消 / 完全自動）
//   視窗關閉      → deactivate()：無 UI，只能直接封存（依 sealOnClose 策略）
//   系統關機／登出 → env.onWillShutdown：同上
function subscribeWillShutdown(handler) {
  try {
    const candidate = vscode.env && vscode.env.onWillShutdown;
    if (!candidate) return null;
    // VS Code 的 Event 形狀：{ listener, event }
    if (typeof candidate.event === 'function') {
      return candidate.event(handler);
    }
    if (typeof candidate.listener === 'function') {
      return candidate.listener(handler);
    }
    if (typeof candidate === 'function') {
      return candidate(handler);
    }
  } catch (_) {
    /* 不支援就走 deactivate() 的降級路徑 */
  }
  return null;
}

// 使用者離開視窗（切去別的 app、或正要關視窗）時 → 詢問是否封存。
// 這時視窗還活著，提示看得見、也等得到回應。
async function handleWindowBlur() {
  if (shutdownState.asked || shutdownState.done || shutdownState.declined) return;

  const root = cachedRoot;
  if (!root) return;

  const core = getCoreModules();
  if (!core.hasVaultOps) return;

  const plan = planSeal(root);
  if (plan.kind !== 'env' && plan.kind !== 'plain') return;

  // 真的要問了 —— 這才把 asked 標記起來，避免每次切 app 都跳一次
  shutdownState.asked = true;

  const format = getCamouflageFormat();
  const targetName = core.vaultFileName(format);
  const sourceName = plan.kind === 'env' ? '.env' : path.basename(plan.vaultPath);

  // 完全自動：不問，直接封存
  if (isAutoEncryptEnabled()) {
    try {
      performSeal(root, plan);
      shutdownState.done = true;
    } catch (_) {
      /* 失敗就維持原狀，不動 .env */
    }
    return;
  }

  let choice;
  try {
    choice = await vscode.window.showInformationMessage(
      `是否將 ${sourceName} 轉換為偽裝檔 ${targetName}（${format}）？`,
      '轉換',
      '取消',
      '完全自動（不再詢問）'
    );
  } catch (_) {
    return; // 提示送不出去 → 保持 .env 原狀（安全的失敗）
  }

  if (choice === '轉換') {
    try {
      performSeal(root, plan);
      shutdownState.done = true;
    } catch (_) {
      /* 保持 .env 原狀 */
    }
  } else if (choice === '完全自動（不再詢問）') {
    try {
      await getConfig().update('autoEncrypt', true, vscode.ConfigurationTarget.Global);
    } catch (_) {
      /* 設定寫不進去也無妨，先把檔案封存 */
    }
    try {
      performSeal(root, plan);
      shutdownState.done = true;
    } catch (_) {
      /* 保持 .env 原狀 */
    }
  } else if (choice === '取消') {
    // 使用者明確拒絕 —— 關窗時也不再自動封存，尊重他的意願。
    shutdownState.declined = true;
  }
  // 提示被直接關掉（沒按任何按鈕）→ 視為「沒回答」，
  // 關窗時仍會依 sealOnClose 策略封存（保護優先）。
}

// 視窗真正關閉時 → 只能做純檔案操作（沒有 UI 可用）。
// 這是「關窗前封存」唯一保證會被呼叫到的路徑：
//   · deactivate()      —— 視窗關閉時必定執行
//   · env.onWillShutdown —— 系統關機／登出時觸發
// 策略由 sealOnClose 決定：
//   'never'  —— 不動 .env
//   'always' —— 一律封存
//   'prompt' —— 使用者明確按過「取消」就不封存，否則封存（保護優先）
function sealOnClose() {
  if (shutdownState.done) return;

  const mode = getSealOnClose();
  if (mode === 'never') return;
  if (mode === 'prompt' && shutdownState.declined) return;

  const root = cachedRoot;
  if (!root) return;

  try {
    const core = getCoreModules();
    if (!core.hasVaultOps) return;
    const plan = planSeal(root);
    if (plan.kind !== 'env' && plan.kind !== 'plain') return;
    performSeal(root, plan);
    shutdownState.done = true;
  } catch (_) {
    /* 保持 .env 原狀 —— 寧可留著明文也不要弄丟資料 */
  }
}

// ── 命令 ──────────────────────────────────────────────────
function registerCommands(context) {
  // 純密文(txt)路線 —— 既有功能，這裡原封不動
  const encryptCmd = vscode.commands.registerCommand('obsccureEnv.encrypt', () => {
    const root = getWorkspaceRoot();
    if (!root) return;

    const envPath = path.join(root, '.env');
    const outPath = path.join(root, 'verify.txt');

    if (!fs.existsSync(envPath)) {
      vscode.window.showWarningMessage('找不到 .env 檔案，無法加密。');
      updateAllStatusBars();
      return;
    }

    try {
      const { encryptEnv, writeVault } = getCoreModules();
      const rawContent = fs.readFileSync(envPath, 'utf8');
      const encrypted = encryptEnv(rawContent, getSecretKey());
      writeVault(encrypted, outPath, { format: 'plain' });
      fs.unlinkSync(envPath);
      ensureGitignore(root);
      updateAllStatusBars();
      vscode.window.showInformationMessage('已加密為 verify.txt、移除 .env，並確認 .gitignore 設定。');
    } catch (err) {
      vscode.window.showErrorMessage(`加密失敗：${err.message}`);
    }
  });

  const decryptCmd = vscode.commands.registerCommand('obsccureEnv.decrypt', () => {
    const root = getWorkspaceRoot();
    if (!root) return;

    const envPath = path.join(root, '.env');
    const vaultPath = path.join(root, 'verify.txt');

    if (!fs.existsSync(vaultPath)) {
      vscode.window.showWarningMessage('找不到 verify.txt，無法還原。');
      updateAllStatusBars();
      return;
    }

    try {
      const { decryptEnv } = getCoreModules();
      const packed = fs.readFileSync(vaultPath, 'utf8');
      const decrypted = decryptEnv(packed, getSecretKey());
      fs.writeFileSync(envPath, decrypted, 'utf8');
      ensureGitignore(root);
      updateAllStatusBars();
      vscode.window.showInformationMessage('已還原 .env 檔案，並確認 .gitignore 設定。');
    } catch (err) {
      vscode.window.showErrorMessage(`還原失敗（金鑰不符或檔案損毀）：${err.message}`);
    }
  });

  // 偽裝路線：手動封存（與關閉時走完全相同的程式路徑）
  const sealCmd = vscode.commands.registerCommand('obsccureEnv.seal', async () => {
    const root = getWorkspaceRoot();
    if (!root) return;

    const core = getCoreModules();
    if (!core.hasVaultOps) {
      vscode.window.showErrorMessage('找不到 src/vault-ops，偽裝路線無法使用。請更新核心路徑。');
      return;
    }

    const plan = planSeal(root);
    if (plan.kind === 'unsupported') {
      vscode.window.showErrorMessage('找不到 src/vault-ops，偽裝路線無法使用。請更新核心路徑。');
      return;
    }
    if (plan.kind === 'none') {
      vscode.window.showInformationMessage('沒有可封存的內容（既沒有 .env，也沒有純密文 verify.txt）。');
      return;
    }
    if (plan.kind === 'already') {
      const names = plan.camoVaults.map((v) => path.basename(v.file)).join('、');
      vscode.window.showInformationMessage(
        `已經有偽裝保管檔（${names}），不需重複封存。若要改變外觀，請使用「轉換偽裝格式」。`
      );
      return;
    }

    const format = getCamouflageFormat();
    const targetName = core.vaultFileName(format);
    const sourceName = plan.kind === 'env' ? '.env' : path.basename(plan.vaultPath);
    const extra = plan.kind === 'env' ? '（.env 將被移除）' : '（來源檔將被移除）';

    const choice = await vscode.window.showInformationMessage(
      `將 ${sourceName} 轉換為偽裝檔 ${targetName}（${format}）${extra}？`,
      '轉換',
      '取消'
    );
    if (choice !== '轉換') return;

    try {
      const result = performSeal(root, plan);
      updateAllStatusBars();
      vscode.window.showInformationMessage(result.message);
    } catch (err) {
      vscode.window.showErrorMessage(`封存失敗：${err.message}`);
    }
  });

  // 偽裝路線：手動還原
  const restoreCmd = vscode.commands.registerCommand('obsccureEnv.restore', async () => {
    const root = getWorkspaceRoot();
    if (!root) return;

    const core = getCoreModules();
    if (!core.hasVaultOps) {
      vscode.window.showErrorMessage('找不到 src/vault-ops，偽裝路線無法使用。請更新核心路徑。');
      return;
    }

    const state = inspectState(root);
    if (state.camoVaults.length === 0) {
      vscode.window.showWarningMessage('找不到偽裝保管檔（verify.png / verify.log / vault.bin）。');
      updateAllStatusBars();
      return;
    }

    // 只有一個保管檔時直接還原 —— 跟純密文路線一樣「點一下就好」。
    // 多個並存才需要讓使用者挑選（格式轉換後正常只會剩一個）。
    let picked;
    if (state.camoVaults.length === 1) {
      const only = state.camoVaults[0];
      picked = { label: path.basename(only.file), vault: only.file };
    } else {
      const items = state.camoVaults.map((v) => ({
        label: path.basename(v.file),
        description: `${v.format} 偽裝`,
        vault: v.file,
      }));
      picked = await vscode.window.showQuickPick(items, {
        placeHolder: '選擇要還原的偽裝保管檔',
      });
      if (!picked) return;
    }

    try {
      const result = performRestore(root, picked.vault);
      updateAllStatusBars();
      vscode.window.showInformationMessage(result.message);
    } catch (err) {
      vscode.window.showErrorMessage(`還原失敗：${err.message}`);
    }
  });

  // 偽裝路線：轉換檔案形態（換外殼不換金鑰）
  const convertCmd = vscode.commands.registerCommand('obsccureEnv.convertFormat', async () => {
    const root = getWorkspaceRoot();
    if (!root) return;

    const core = getCoreModules();
    if (!core.hasVaultOps) {
      vscode.window.showErrorMessage('找不到 src/vault-ops，偽裝路線無法使用。請更新核心路徑。');
      return;
    }

    const state = inspectState(root);
    const sources = state.camoVaults.map((v) => ({
      label: path.basename(v.file),
      description: `${v.format} 偽裝`,
      vault: v.file,
    }));
    if (state.plainVault) {
      sources.push({
        label: path.basename(state.plainVault.file),
        description: 'plain 純密文',
        vault: state.plainVault.file,
      });
    }
    if (sources.length === 0) {
      vscode.window.showWarningMessage('找不到可轉換的保管檔。');
      return;
    }

    const pickedSource = await vscode.window.showQuickPick(sources, {
      placeHolder: '選擇要轉換外觀的保管檔',
    });
    if (!pickedSource) return;

    const formatItems = CAMOUFLAGE_FORMATS.map((f) => ({
      label: f,
      description: core.vaultFileName(f),
    }));
    const pickedFormat = await vscode.window.showQuickPick(formatItems, {
      placeHolder: '選擇目標偽裝格式',
    });
    if (!pickedFormat) return;

    const target = path.join(root, core.vaultFileName(pickedFormat.label));
    if (path.resolve(target) === path.resolve(pickedSource.vault)) {
      vscode.window.showInformationMessage('目標檔名與來源相同，無需轉換。');
      return;
    }

    try {
      const result = core.convertVault({
        vaultPath: pickedSource.vault,
        format: pickedFormat.label,
        outPath: target,
        removeSource: true,
      });
      ensureGitignore(root);
      updateAllStatusBars();
      vscode.window.showInformationMessage(
        `已轉換為 ${path.basename(result.file)}（${result.format} 偽裝）。密文與金鑰不變，舊金鑰仍然有效。`
      );
    } catch (err) {
      vscode.window.showErrorMessage(`格式轉換失敗：${err.message}`);
    }
  });

  const hintCmd = vscode.commands.registerCommand('obsccureEnv.statusHint', () => {
    const root = cachedRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showInformationMessage('請先開啟一個專案資料夾。');
      return;
    }

    const core = getCoreModules();
    if (!core.hasVaultOps) {
      vscode.window.showInformationMessage(
        '偽裝路線不可用：找不到 src/vault-ops。請在設定 obsccureEnv.corePath 指向更新後的核心。'
      );
      return;
    }

    const state = inspectState(root);
    const format = getCamouflageFormat();
    const lines = [];

    lines.push(`偽裝格式設定：${format}（${core.vaultFileName(format)}）`);
    lines.push(`自動解密：${isAutoDecryptEnabled() ? '開啟專案就自動解密' : '每次詢問'}`);
    lines.push(`完全自動：${isAutoEncryptEnabled() ? '關閉時直接封存，不再詢問' : '每次詢問'}`);
    lines.push('');

    if (state.hasEnv) lines.push('· .env：存在（明文）');
    else lines.push('· .env：不存在');

    if (state.camoVaults.length > 0) {
      for (const v of state.camoVaults) {
        lines.push(`· 偽裝保管檔：${path.basename(v.file)}（${v.format}）`);
      }
    } else {
      lines.push('· 偽裝保管檔：無');
    }

    if (state.plainVault) {
      lines.push(`· 純密文：${path.basename(state.plainVault.file)}`);
    }

    if (state.hasEnv && state.camoVaults.length > 0) {
      lines.push('');
      lines.push('注意：.env 與偽裝保管檔同時存在。關閉工作階段時會以 .env 重新封存。');
    }

    vscode.window.showInformationMessage(lines.join('\n'));
  });

  context.subscriptions.push(
    encryptCmd,
    decryptCmd,
    sealCmd,
    restoreCmd,
    convertCmd,
    hintCmd
  );
}

function activate(context) {
  cachedRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;

  // 偽裝路線的狀態列
  camoStatusBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  // 純密文(txt)路線的狀態列 —— 既有功能，保留
  txtStatusBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

  registerCommands(context);

  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{.env,verify.txt,verify.png,verify.log,vault.bin,.env.vault}'
  );
  watcher.onDidCreate(() => updateAllStatusBars());
  watcher.onDidDelete(() => updateAllStatusBars());
  watcher.onDidChange(() => updateAllStatusBars());

  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    cachedRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    updateAllStatusBars();
  });

  const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('obsccureEnv')) updateAllStatusBars();
  });

  // 視窗失去焦點 → 趁使用者還看得到視窗時詢問是否封存。
  // 這是公開 API（window.onDidChangeWindowState），能顯示提示並等回應。
  // 只在「由有焦點變成沒焦點」時觸發，避免反覆詢問。
  const windowStateSub = vscode.window.onDidChangeWindowState((state) => {
    if (!state.focused) {
      handleWindowBlur().catch(() => {
        /* 提示失敗不影響其他功能 */
      });
    }
  });

  // 系統關機／登出時才會觸發（不是視窗關閉）—— 保留作為補充路徑。
  const shutdownSub = subscribeWillShutdown(() => {
    sealOnClose();
  });

  updateAllStatusBars();

  context.subscriptions.push(
    camoStatusBtn,
    txtStatusBtn,
    watcher,
    folderSub,
    configSub,
    windowStateSub,
    shutdownSub
  );

  // 開啟專案後詢問是否解密 —— 延遙一點讓視窗先就緒
  setTimeout(() => {
    handleStartup().catch(() => {
      /* 啟動提示失敗不影響其他功能 */
    });
  }, 300);
}

function deactivate() {
  // 視窗關閉時唯一保證會被呼叫到的鉤子 —— 沒有 UI 可用，只能做純檔案操作。
  // 「關窗前詢問」已經在視窗失去焦點時（handleWindowBlur）做掉了；
  // 這裡負責補上「使用者直接關窗、根本沒機會回答」的情況。
  sealOnClose();
}

module.exports = { activate, deactivate };

// Preload 自動註冊檔:node -r ./src/register.js index.js
// 在業務程式運行前,於記憶體中解密保管檔並注入 process.env — 零程式碼改動。
// 預設:載入失敗僅提示、不中斷宿主程式;設 OBSCURE_ENV_STRICT=1 可改為直接拋錯。
require('./index').config({
  strict: process.env.OBSCURE_ENV_STRICT === '1',
});

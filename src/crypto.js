const crypto = require('crypto');

// 使用本地機器獨有的特徵（如 MAC/主機名）或用戶自訂的金鑰來派生 Key
function getDerivedKey(salt, userSecret = 'default-system-salt') {
  return crypto.pbkdf2Sync(userSecret, salt, 100000, 32, 'sha256');
}

// 加密 .env 內容
function encryptEnv(rawEnvContent, secretKey) {
  const iv = crypto.randomBytes(16);
  const salt = crypto.randomBytes(16);
  const key = getDerivedKey(salt, secretKey);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(rawEnvContent, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  // 將 salt, iv, authTag, encrypted 組合寫入檔案
  return JSON.stringify({
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    t: authTag.toString('base64'),
    d: encrypted
  });
}

// 解密 verify.txt 內容
function decryptEnv(packedContent, secretKey) {
  const { s, i, t, d } = JSON.parse(packedContent);
  const salt = Buffer.from(s, 'base64');
  const iv = Buffer.from(i, 'base64');
  const authTag = Buffer.from(t, 'base64');
  const key = getDerivedKey(salt, secretKey);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(d, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encryptEnv, decryptEnv };
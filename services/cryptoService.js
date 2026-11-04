/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Enkripsi token GitHub sebelum disimpan ke database JSON.
 * Token TIDAK PERNAH disimpan dalam bentuk plaintext.
 * Pakai AES-256-GCM (built-in Node.js crypto, tidak perlu library tambahan).
 */
const crypto = require("crypto");
const { config } = require("../config");

const ALGORITHM = "aes-256-gcm";

function getKeyBuffer() {
  return Buffer.from(config.ENCRYPTION_KEY, "hex");
}

/**
 * Enkripsi string token.
 * Return format: "iv:authTag:ciphertext" (semua hex), disimpan sebagai satu string.
 */
function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKeyBuffer(), iv);

  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Dekripsi token yang sebelumnya dienkripsi dengan encryptToken().
 */
function decryptToken(encryptedString) {
  const [ivHex, authTagHex, dataHex] = encryptedString.split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Format token terenkripsi tidak valid.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, getKeyBuffer(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

module.exports = { encryptToken, decryptToken };
/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Konfigurasi global bot.
 * Semua nilai sensitif diambil dari environment variable (.env).
 */
require("dotenv").config();

const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  // Key untuk enkripsi token GitHub user (wajib 32 byte / 64 hex char)
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,

  // (opsional) Daftar Telegram user ID yang BOLEH memakai bot, dipisah koma. Kosong = semua orang.
  // Sangat disarankan diisi, karena bot ini menyimpan token GitHub/Vercel. Cek ID kamu lewat @userinfobot.
  ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || "")
    .split(",").map((x) => x.trim()).filter(Boolean),

  // Path file database JSON
  DB_PATH: process.env.DB_PATH || "./data/db.json",

  // Telegram Bot API membatasi download file bot biasa maksimal 20MB
  MAX_FILE_SIZE_MB: 20,
  MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024,
};

function validateConfig() {
  const missing = [];
  if (!config.TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.ENCRYPTION_KEY) missing.push("ENCRYPTION_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Environment variable belum diset: ${missing.join(", ")}. Cek file .env kamu.`
    );
  }
  if (config.ENCRYPTION_KEY && config.ENCRYPTION_KEY.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY harus 64 karakter hex (32 byte). Generate dengan:\n" +
      `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
}

module.exports = { config, validateConfig };
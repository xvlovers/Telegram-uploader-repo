/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Helper untuk tombol inline BERWARNA, memakai field "style" dari Telegram Bot API 9.4+
 * (Februari 2026): "primary" (biru), "success" (hijau), "danger" (merah).
 *
 * PENTING - kompatibilitas:
 * - Field ini resmi dari Telegram, TAPI baru didukung di Bot API versi 9.4 ke atas.
 * - Telegraf v4.16.3 (versi yang dipakai project ini) dirilis SEBELUM field ini ada,
 *   jadi helper Markup.button.callback() bawaannya tidak punya opsi style secara eksplisit.
 *   Untungnya Telegraf hanya meneruskan object JSON apa adanya ke Telegram API, jadi
 *   menambahkan field "style" secara manual ke object button tetap terkirim dengan benar.
 * - Kalau client Telegram si user versinya lama / belum update, field ini akan diabaikan
 *   dengan aman oleh Telegram (bukan error) — tombol tetap tampil normal tanpa warna.
 *
 * Cara pakai:
 *   coloredButton("🗑️ Ya, hapus", "confirmdelete", "danger")
 *   coloredButton("✅ Ya, lanjut", "confirmupload", "success")
 *   coloredButton("🚀 Deploy", "dodeploy", "primary")
 */

/**
 * Buat 1 tombol callback dengan warna.
 * @param {string} text - label tombol
 * @param {string} callbackData - callback_data
 * @param {"primary"|"success"|"danger"} style - warna tombol
 * @returns {object} button object siap dipakai di baris inline_keyboard
 */
function coloredButton(text, callbackData, style) {
  return { text, callback_data: callbackData, style };
}

module.exports = { coloredButton };

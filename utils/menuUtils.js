/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Utility untuk tombol menu utama & navigasi "Back" yang konsisten di seluruh bot.
 * Semua alur multi-langkah sebaiknya punya jalan untuk kembali ke menu utama
 * dengan MENGEDIT pesan yang sama (bukan mengirim pesan baru), supaya chat
 * tidak penuh dengan riwayat langkah-langkah lama.
 */
const { Markup } = require("telegraf");

/** Tombol tunggal "⬅️ Menu" yang mengarah ke callback "menu:home". */
function backToMenuButton() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Menu", "menu:home")]]);
}

/**
 * Gabungkan baris-baris tombol yang sudah ada dengan baris "⬅️ Menu" di akhir.
 * @param {Array<Array>} rows - array of array of Markup.button
 */
function withBackToMenu(rows) {
  return Markup.inlineKeyboard([...rows, [Markup.button.callback("⬅️ Menu", "menu:home")]]);
}

module.exports = { backToMenuButton, withBackToMenu };

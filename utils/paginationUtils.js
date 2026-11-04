/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Utility untuk membangun inline keyboard grid + pagination (tombol Prev/Next)
 * dari daftar item yang panjang. Dipakai oleh fitur /download untuk browsing folder.
 */
const { Markup } = require("telegraf");

const ITEMS_PER_PAGE = 8; // jumlah item per halaman
const COLUMNS = 2; // jumlah tombol per baris

/**
 * Susun array item jadi grid tombol dengan pagination.
 *
 * @param {Array<{label: string, callbackData: string}>} items - semua item (belum dipotong per halaman)
 * @param {number} page - halaman aktif, 0-based
 * @param {object} opts
 * @param {Array<{label: string, callbackData: string}>} [opts.extraButtons] - tombol tambahan di baris paling bawah (mis. "Kembali")
 * @param {string} [opts.pageCallbackPrefix] - prefix callback_data untuk tombol Prev/Next, hasil: `${prefix}:${pageNumber}`
 * @returns {{ keyboard: object, totalPages: number, pageItems: Array }}
 */
function buildPaginatedKeyboard(items, page, opts = {}) {
  const { extraButtons = [], pageCallbackPrefix = "page" } = opts;

  const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);

  const start = safePage * ITEMS_PER_PAGE;
  const pageItems = items.slice(start, start + ITEMS_PER_PAGE);

  // Susun jadi baris-baris berisi COLUMNS tombol
  const rows = [];
  for (let i = 0; i < pageItems.length; i += COLUMNS) {
    const rowItems = pageItems.slice(i, i + COLUMNS);
    rows.push(rowItems.map((it) => Markup.button.callback(it.label, it.callbackData)));
  }

  // Baris navigasi Prev/Next, hanya muncul kalau lebih dari 1 halaman
  if (totalPages > 1) {
    const navRow = [];
    if (safePage > 0) {
      navRow.push(Markup.button.callback("◀️ Prev", `${pageCallbackPrefix}:${safePage - 1}`));
    }
    navRow.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, "noop"));
    if (safePage < totalPages - 1) {
      navRow.push(Markup.button.callback("▶️ Next", `${pageCallbackPrefix}:${safePage + 1}`));
    }
    rows.push(navRow);
  }

  // Tombol tambahan (mis. "⬆️ Kembali", "❎ Batal") di baris paling bawah
  if (extraButtons.length > 0) {
    rows.push(extraButtons.map((it) => Markup.button.callback(it.label, it.callbackData)));
  }

  return { keyboard: Markup.inlineKeyboard(rows), totalPages, pageItems };
}

module.exports = { buildPaginatedKeyboard, ITEMS_PER_PAGE };

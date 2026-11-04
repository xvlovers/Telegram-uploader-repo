/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Utility format HTML untuk pesan Telegram. Project ini pakai parse_mode: "HTML"
 * di semua pesan (bukan "Markdown"), karena hanya HTML yang mendukung <blockquote>
 * secara resmi di Telegram Bot API.
 *
 * PENTING: teks yang berasal dari luar (nama file, nama repo, path, dsb) HARUS
 * di-escape dengan esc() sebelum digabung ke pesan, supaya karakter <, >, & dari
 * data pengguna tidak dikira tag HTML oleh Telegram dan merusak/menggagalkan pesan.
 */

/** Escape karakter spesial HTML supaya teks dinamis aman disisipkan ke pesan. */
function esc(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function bold(text) {
  return `<b>${text}</b>`;
}

function code(text) {
  return `<code>${esc(text)}</code>`;
}

function italic(text) {
  return `<i>${text}</i>`;
}

/** Bungkus teks (boleh multi-baris) jadi blockquote Telegram. */
function quote(text) {
  return `<blockquote>${text}</blockquote>`;
}

/** Bungkus teks jadi expandable blockquote (bisa di-collapse user, berguna untuk daftar panjang). */
function expandableQuote(text) {
  return `<blockquote expandable>${text}</blockquote>`;
}

module.exports = { esc, bold, code, italic, quote, expandableQuote };

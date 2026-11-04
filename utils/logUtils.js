/**
 * Helper untuk merapikan log GitHub Actions supaya enak dibaca di layar HP / pesan Telegram:
 * - buang timestamp di awal tiap baris
 * - buang kode warna ANSI
 * - ubah penanda ##[group]/##[error]/##[warning] jadi simbol
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
const TIMESTAMP_RE = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

/** Bersihkan log mentah GitHub -> array baris yang rapi. */
function cleanLog(raw) {
  const out = [];
  for (let line of String(raw).split(/\r?\n/)) {
    line = line.replace(TIMESTAMP_RE, "").replace(ANSI_RE, "");
    if (line.startsWith("##[endgroup]")) continue;
    if (line.startsWith("##[group]")) line = "▶ " + line.slice(9);
    else if (line.startsWith("##[error]")) line = "❌ " + line.slice(9);
    else if (line.startsWith("##[warning]")) line = "⚠️ " + line.slice(11);
    else if (line.startsWith("##[notice]")) line = "ℹ️ " + line.slice(10);
    else if (line.startsWith("##[debug]")) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Potong baris yang terlalu panjang (layar HP sempit). */
function clipLine(line, max = 100) {
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** N baris terakhir, tiap baris dipotong. */
function tailLines(lines, n = 15, maxWidth = 100) {
  return lines.slice(-n).map((l) => clipLine(l, maxWidth));
}

/** Ambil baris yang menandai error (##[error] dan sejenisnya) beserta nomor barisnya. */
function extractErrors(lines, max = 8) {
  const hits = [];
  for (const l of lines) {
    if (l.startsWith("❌ ") || /^(npm ERR!|error:|Error:|fatal:)/i.test(l)) {
      hits.push(clipLine(l, 140));
      if (hits.length >= max) break;
    }
  }
  return hits;
}

/** Potong teks agar muat di batas pesan Telegram, buang bagian AWAL (yang terbaru dipertahankan). */
function fitTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  return "…" + text.slice(text.length - (maxChars - 1));
}

module.exports = { cleanLog, clipLine, tailLines, extractErrors, fitTail };

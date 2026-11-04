/**
 * Helper khusus sisi Telegram supaya bot tahan banting terhadap:
 * - callback query kedaluwarsa ("query is too old") -> sumber utama "Terjadi kesalahan tak terduga"
 *   setelah bot sempat offline / HP tidur lalu update lama diproses belakangan
 * - editMessageText dengan isi yang sama ("message is not modified")
 * - download file dari Telegram yang putus di tengah jalan (ECONNABORTED/ECONNRESET/timeout)
 * - dua operasi berat (push) jalan bersamaan untuk chat yang sama -> "not a fast forward"
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error Telegram yang aman diabaikan (bukan bug, hanya kondisi usang/duplikat). */
function isIgnorableTelegramError(err) {
  const desc = String(err?.response?.description || err?.description || err?.message || "");
  return (
    /query is too old|query ID is invalid|response timeout expired/i.test(desc) ||
    /message is not modified/i.test(desc) ||
    /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(desc)
  );
}

/**
 * Middleware: bungkus ctx.answerCbQuery & ctx.editMessageText supaya error "usang/duplikat"
 * ditelan diam-diam. Semua handler lama otomatis ikut aman tanpa diubah satu-satu.
 */
function safeTelegramMiddleware() {
  return async (ctx, next) => {
    const origAnswer = ctx.answerCbQuery?.bind(ctx);
    if (origAnswer) {
      ctx.answerCbQuery = async (...args) => {
        try {
          return await origAnswer(...args);
        } catch (err) {
          if (isIgnorableTelegramError(err)) return false;
          throw err;
        }
      };
    }

    const origEdit = ctx.editMessageText?.bind(ctx);
    if (origEdit) {
      ctx.editMessageText = async (...args) => {
        try {
          return await origEdit(...args);
        } catch (err) {
          if (isIgnorableTelegramError(err)) return false;
          throw err;
        }
      };
    }

    return next();
  };
}

/** Versi aman dari ctx.telegram.editMessageText (dipakai handler yang edit pesan status). */
async function safeEditById(ctx, chatId, messageId, text, extra) {
  try {
    return await ctx.telegram.editMessageText(chatId, messageId, null, text, extra);
  } catch (err) {
    if (isIgnorableTelegramError(err)) return false;
    throw err;
  }
}

class DownloadError extends Error {}

/**
 * Download file Telegram jadi Buffer, dengan timeout + retry + cek status HTTP.
 * Sebelumnya fetch() polos: kalau koneksi putus -> unhandled error; kalau Telegram balas
 * 4xx/5xx -> isi error page ikut dianggap "file" lalu zip gagal dibaca.
 */
async function downloadTelegramFile(ctx, fileId, { retries = 4, timeoutMs = 120000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const link = await ctx.telegram.getFileLink(fileId);
      const res = await fetch(link.href, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  }
  throw new DownloadError(
    `Gagal mengunduh file dari Telegram (${lastErr?.message || "koneksi terputus"}). Coba kirim ulang file-nya.`
  );
}

// ---------- Lock per chat: cegah dua operasi berat bersamaan ----------
const busyChats = new Set();

/** Return true kalau berhasil ambil lock; false kalau chat ini masih sibuk. */
function tryLock(chatId) {
  if (busyChats.has(chatId)) return false;
  busyChats.add(chatId);
  return true;
}
function unlock(chatId) {
  busyChats.delete(chatId);
}

/** Bungkus handler action: kalau chat yang sama masih memproses, tolak dengan sopan. */
function withChatLock(handler) {
  return async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!tryLock(chatId)) {
      try { await ctx.answerCbQuery("⏳ Masih diproses, tunggu sampai selesai ya."); } catch (_) {}
      return;
    }
    try {
      return await handler(ctx);
    } finally {
      unlock(chatId);
    }
  };
}

module.exports = {
  withChatLock,
  isIgnorableTelegramError,
  safeTelegramMiddleware,
  safeEditById,
  downloadTelegramFile,
  DownloadError,
  tryLock,
  unlock,
};

/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Entry point bot. Jalankan dengan: node index.js
 */
const { Telegraf } = require("telegraf");
const { config, validateConfig } = require("./config");
const { registerStartHandlers, WELCOME_TEXT } = require("./handlers/startHandler");
const { registerAuthHandlers } = require("./handlers/authHandler");
const { registerUploadHandlers, pendingFiles } = require("./handlers/uploadHandler");
const { registerDeleteHandlers } = require("./handlers/deleteHandler");
const { registerReplaceHandlers, pendingReplaceFiles } = require("./handlers/replaceHandler");
const { registerRenameHandlers } = require("./handlers/renameHandler");
const { registerMyReposHandler } = require("./handlers/myReposHandler");
const { registerDownloadHandlers } = require("./handlers/downloadHandler");
const { registerVercelAuthHandlers } = require("./handlers/vercelAuthHandler");
const { registerDeployHandlers } = require("./handlers/deployHandler");
const { registerStatusHandler } = require("./handlers/statusHandler");
const { registerUpdateSiteHandlers, pendingUpdateZip } = require("./handlers/updateSiteHandler");
const { registerActionsHandlers, pendingActionInput } = require("./handlers/actionsHandler");
const dbService = require("./services/dbService");
const { safeTelegramMiddleware, isIgnorableTelegramError } = require("./utils/telegramUtils");

async function main() {
  validateConfig();

  // Default Telegraf membatasi tiap handler (command/action) maksimal 90 detik (handlerTimeout).
  // Operasi berat seperti /updatesite atau /upload untuk repo besar (banyak file -> banyak
  // request ke GitHub API) bisa melebihi itu meski sudah dioptimalkan (paralel dengan batas
  // concurrency, lihat githubService.js). Dinaikkan ke 5 menit sebagai jaring pengaman kedua,
  // bukan solusi utama — solusi utama tetap di sisi kecepatan request itu sendiri.
  const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN, { handlerTimeout: 10 * 60 * 1000 });

  // ===== ANTI "BOT DIAM SAAT SIBUK" =====
  // Telegraf (long polling) baru mengambil batch update berikutnya SETELAH semua handler batch
  // sebelumnya selesai. Jadi selama upload/deploy/monitor berjalan lama, semua pesan & tombol
  // lain (/status, /cancel, dll) menunggu di antrean. Solusinya: tiap update dijalankan
  // "terlepas" dari loop polling, sehingga polling terus jalan dan update lain langsung diproses.
  // Error dari update yang terlepas diteruskan ke bot.catch di bawah.
  bot.use((ctx, next) => {
    Promise.resolve()
      .then(() => next())
      .catch(async (err) => {
        try {
          await bot.handleError(err, ctx);
        } catch (e) {
          console.error("Error tak tertangani di update:", e?.message || e);
        }
      });
    // return langsung -> polling tidak menunggu handler ini selesai
  });

  // Karena update sekarang diproses bersamaan, urutan dokumen yang dikirim beruntun dijaga:
  // dokumen dari chat yang sama diproses satu-per-satu sesuai urutan kirim, dan /done menunggu
  // semua dokumen yang masih diunduh selesai dulu (supaya tidak push file yang belum lengkap).
  const docChains = new Map();
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return next();
    const msg = ctx.message;

    if (msg?.document) {
      const prev = docChains.get(chatId) || Promise.resolve();
      const run = prev.then(() => next());
      const tail = run.catch(() => {});
      docChains.set(chatId, tail);
      tail.then(() => { if (docChains.get(chatId) === tail) docChains.delete(chatId); });
      return run;
    }

    if (msg?.text && /^\/done(@\w+)?(\s|$)/i.test(msg.text)) {
      const pending = docChains.get(chatId);
      if (pending) await pending;
    }
    return next();
  });

  // Harus paling awal: menelan error Telegram yang tidak berbahaya ("query is too old",
  // "message is not modified") supaya tidak berubah jadi pesan "kesalahan tak terduga".
  bot.use(safeTelegramMiddleware());

  // Allowlist (opsional, lewat ALLOWED_USER_IDS di .env). User di luar daftar diabaikan.
  if (config.ALLOWED_USER_IDS.length > 0) {
    bot.use(async (ctx, next) => {
      const uid = String(ctx.from?.id || "");
      if (config.ALLOWED_USER_IDS.includes(uid)) return next();
      if (ctx.message) {
        try { await ctx.reply("⛔ Bot ini bersifat pribadi. Kamu tidak punya akses."); } catch (_) {}
      } else if (ctx.callbackQuery) {
        try { await ctx.answerCbQuery("⛔ Tidak ada akses.", { show_alert: true }); } catch (_) {}
      }
    });
    console.log(`Allowlist aktif: ${config.ALLOWED_USER_IDS.length} user.`);
  }

  registerStartHandlers(bot);
  registerAuthHandlers(bot);
  registerMyReposHandler(bot);
  registerUploadHandlers(bot);
  registerDeleteHandlers(bot);
  registerReplaceHandlers(bot);
  registerRenameHandlers(bot);
  registerDownloadHandlers(bot);
  registerVercelAuthHandlers(bot);
  registerDeployHandlers(bot);
  registerStatusHandler(bot);
  registerUpdateSiteHandlers(bot);
  registerActionsHandlers(bot);

  // Tombol "⬅️ Menu" yang muncul di beberapa layar mengarah ke sini -> tampilkan
  // ulang pesan panduan awal (edit pesan yang sama, bukan kirim baru).
  bot.action("menu:home", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(WELCOME_TEXT, { parse_mode: "HTML", disable_web_page_preview: true });
  });

  // /cancel generik: bersihkan session DB + semua state in-memory (upload, replace, updatesite),
  // apapun flow yang sedang berjalan.
  bot.command("cancel", async (ctx) => {
    const chatId = String(ctx.chat.id);
    await dbService.clearSession(chatId);
    pendingFiles.delete(chatId);
    pendingReplaceFiles.delete(chatId);
    pendingUpdateZip.delete(chatId);
    pendingActionInput.delete(chatId);
    await ctx.reply("❎ Sesi dibatalkan. (Pemantauan Actions yang sedang jalan tidak ikut berhenti — pakai tombol 🛑 Stop di pesannya.)");
  });

  // Fallback paling akhir: kalau /done atau kiriman file tidak ditangani sesi manapun di atas
  // (upload/replace/updatesite), kasih pesan yang jelas alih-alih diam saja.
  bot.command("done", async (ctx) => {
    await ctx.reply("Tidak ada sesi upload/replace yang aktif. Ketik /upload atau /replace dulu.");
  });
  bot.on("document", async (ctx) => {
    await ctx.reply("Kamu belum mulai sesi upload/replace/updatesite. Ketik /upload, /replace, atau /updatesite dulu ya.");
  });

  // Fallback error handler global supaya bot tidak crash total kalau ada error tak terduga
  bot.catch(async (err, ctx) => {
    if (isIgnorableTelegramError(err)) return; // update usang/duplikat, tidak perlu ganggu user
    // Log ringkas & informatif (status HTTP + pesan), stack hanya untuk error non-HTTP.
    const httpInfo = typeof err?.status === "number" ? ` [HTTP ${err.status}]` : "";
    console.error(`Error saat menangani update ${ctx.updateType}${httpInfo}:`, typeof err?.status === "number" ? err.message : err);

    const msg = String(err?.message || "");
    let text = "⚠️ Terjadi kesalahan tak terduga. Coba lagi atau ketik /cancel untuk reset sesi.";
    if (err?.name === "TimeoutError" || /timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|fetch failed|EAI_AGAIN/i.test(msg)) {
      text = "⚠️ Koneksi bermasalah / proses terlalu lama. Cek internet lalu coba lagi. Sesi kamu masih tersimpan (ketik /cancel untuk reset).";
    }
    try { await ctx.reply(text); } catch (_) { /* abaikan */ }
  });

  // Jaring pengaman: jangan sampai satu promise yang lupa di-catch mematikan seluruh bot.
  process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
  process.on("uncaughtException", (error) => console.error("uncaughtException:", error));

  // dropPendingUpdates: buang update lama yang menumpuk saat bot mati/HP tidur. Update lama
  // inilah yang memicu "query is too old" dan memproses perintah/file yang sudah basi.
  // CATATAN: launch() baru selesai saat bot berhenti, jadi pesan "berjalan" lewat callback.
  bot.launch({ dropPendingUpdates: true }, () => console.log("Bot mulai berjalan...")).catch((err) => {
    console.error("Bot berhenti karena error:", err.message);
    process.exit(1);
  });

  // Graceful shutdown
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error("Gagal menjalankan bot:", err.message);
  process.exit(1);
});
/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /upload:
 * 1. User pilih: repo existing atau bikin baru
 * 2. (existing) tampilkan inline keyboard daftar repo -> user pilih
 *    (baru) tanya nama repo -> tanya private/public -> buat repo
 * 3. User kirim file (bisa beberapa file berturut-turut: zip / file biasa)
 * 4. User ketik /done untuk konfirmasi push, atau /cancel untuk batal
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  createRepo,
  pushFiles,
  GitHubServiceError,
} = require("../services/githubService");
const {
  extractZipToObject,
  singleFileToObject,
  summarizeFiles,
  FileProcessingError,
} = require("../utils/fileUtils");
const { config } = require("../config");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { downloadTelegramFile, DownloadError, safeEditById, withChatLock } = require("../utils/telegramUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");
const { coloredButton } = require("../utils/buttonUtils");

// Simpan file yang sudah diterima per chatId selama sesi upload (in-memory, sementara).
// Kalau bot restart, sesi upload yang sedang jalan otomatis hilang (file harus dikirim ulang) —
// ini trade-off wajar untuk bot simple berbasis JSON.
const pendingFiles = new Map();

function uploadIntroText(repoName) {
  return (
    quote(
      `✅ Repo tujuan: ${bold(esc(repoName))}\n\n` +
      `Kirim file kamu:\n` +
      `• Kirim file <code>.zip</code> → otomatis di-extract\n` +
      `• Atau kirim file satu-satu (bisa berkali-kali)`
    ) +
    `\n\nKalau sudah selesai kirim semua file, ketik /done untuk push ke GitHub.\n` +
    `⚠️ Maks ${config.MAX_FILE_SIZE_MB}MB per file.`
  );
}

function registerUploadHandlers(bot) {
  async function handleUploadStart(ctx, respond) {
    const chatId = String(ctx.chat.id);

    if (!dbService.isUserRegistered(chatId)) {
      await respond(
        "Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.\nKetik /help untuk panduan lengkap.",
        backToMenuButton()
      );
      return;
    }

    await respond(
      "Mau upload ke repo mana?",
      withBackToMenu([
        [Markup.button.callback("📂 Pilih repo yang sudah ada", "upload:existing")],
        [Markup.button.callback("✨ Buat repo baru", "upload:new")],
      ])
    );
  }

  bot.command("upload", async (ctx) => {
    await handleUploadStart(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:upload", async (ctx) => {
    await ctx.answerCbQuery();
    await handleUploadStart(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  bot.action("upload:existing", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const token = decryptToken(dbService.getUserToken(chatId));

    let repos;
    try {
      repos = await listUserRepos(token);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await ctx.editMessageText("Kamu belum punya repo sama sekali. Pilih 'Buat repo baru' saja ya.", backToMenuButton());
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `repo:${r.fullName}`),
    ]);
    await ctx.editMessageText("Pilih repo tujuan:", withBackToMenu(buttons));
  });

  bot.action("upload:new", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.setSession(chatId, { status: "awaiting_new_repo_name", repoMode: "new" });
    await ctx.editMessageText(`Ketik nama repo baru yang mau dibuat (contoh: ${code("project-saya")}):`, {
      parse_mode: "HTML",
    });
  });

  bot.action(/^repo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];

    await dbService.setSession(chatId, {
      repoName: fullName,
      repoMode: "existing",
      status: "awaiting_files",
    });
    pendingFiles.set(chatId, {});

    await ctx.editMessageText(uploadIntroText(fullName), { parse_mode: "HTML" });
  });

  // Menangani input teks biasa saat menunggu nama repo baru
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_new_repo_name") {
      return next();
    }

    const repoName = ctx.message.text.trim();
    if (!repoName || /\s/.test(repoName)) {
      await ctx.reply("Nama repo tidak valid (tidak boleh kosong atau mengandung spasi). Coba lagi:");
      return;
    }

    await dbService.setSession(chatId, { repoName });

    await ctx.replyWithHTML(
      `Repo ${bold(esc(repoName))} mau dibuat public atau private?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🌐 Public", "visibility:public")],
        [Markup.button.callback("🔒 Private", "visibility:private")],
      ])
    );
  });

  bot.action(/^visibility:(public|private)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const isPrivate = ctx.match[1] === "private";

    const session = dbService.getSession(chatId);
    const repoName = session.repoName;
    const token = decryptToken(dbService.getUserToken(chatId));

    await ctx.editMessageText(`🔄 Membuat repo ${bold(esc(repoName))}...`, { parse_mode: "HTML" });

    let repo;
    try {
      repo = await createRepo(token, repoName, isPrivate);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        await dbService.clearSession(chatId);
        return;
      }
      throw err;
    }

    await dbService.setSession(chatId, {
      repoName: repo.fullName,
      isPrivate,
      status: "awaiting_files",
    });
    pendingFiles.set(chatId, {});

    await ctx.editMessageText(`✅ Repo ${bold(esc(repo.fullName))} berhasil dibuat!\n\n` + uploadIntroText(repo.fullName), {
      parse_mode: "HTML",
    });
  });

  // Menerima file (dokumen) yang dikirim user selama sesi upload aktif
  bot.on("document", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_files") {
      return next ? next() : undefined; // biar /replace bisa menangani dokumennya sendiri
    }

    const doc = ctx.message.document;
    if (doc.file_size > config.MAX_FILE_SIZE_BYTES) {
      await ctx.replyWithHTML(
        `❌ File ${code(doc.file_name)} terlalu besar (${Math.round(doc.file_size / 1024 / 1024)}MB). ` +
          `Maks ${config.MAX_FILE_SIZE_MB}MB.`
      );
      return;
    }

    const statusMsg = await ctx.replyWithHTML(`⬇️ Mengunduh ${code(doc.file_name)}...`);

    let fileBuffer;
    try {
      fileBuffer = await downloadTelegramFile(ctx, doc.file_id);
    } catch (err) {
      if (err instanceof DownloadError) {
        await safeEditById(ctx, ctx.chat.id, statusMsg.message_id, `❌ ${esc(err.message)}`, { parse_mode: "HTML" });
        return;
      }
      throw err;
    }

    if (!pendingFiles.has(chatId)) pendingFiles.set(chatId, {});
    const currentFiles = pendingFiles.get(chatId);

    try {
      if (doc.file_name.toLowerCase().endsWith(".zip")) {
        const extracted = extractZipToObject(fileBuffer);
        Object.assign(currentFiles, extracted);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `✅ ${code(doc.file_name)} di-extract: ${Object.keys(extracted).length} file ditambahkan.\n` +
            `Total sejauh ini: ${Object.keys(currentFiles).length} file.\n\n` +
            `Kirim file lagi, atau ketik /done untuk push.`,
          { parse_mode: "HTML" }
        );
      } else {
        const single = singleFileToObject(doc.file_name, fileBuffer);
        Object.assign(currentFiles, single);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `✅ ${code(doc.file_name)} ditambahkan.\n` +
            `Total sejauh ini: ${Object.keys(currentFiles).length} file.\n\n` +
            `Kirim file lagi, atau ketik /done untuk push.`,
          { parse_mode: "HTML" }
        );
      }
    } catch (err) {
      if (err instanceof FileProcessingError) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, statusMsg.message_id, null,
          `❌ ${esc(err.message)}`, { parse_mode: "HTML" }
        );
        return;
      }
      throw err;
    }
  });

  bot.command("done", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_files") {
      return next ? next() : undefined; // biar /done untuk /replace tetap jalan (handler lain)
    }

    const files = pendingFiles.get(chatId) || {};
    if (Object.keys(files).length === 0) {
      await ctx.reply("Belum ada file yang dikirim. Kirim file dulu sebelum /done.");
      return;
    }

    const repoName = session.repoName;
    const totalBytes = Object.values(files).reduce((sum, buf) => sum + buf.length, 0);
    const totalKB = (totalBytes / 1024).toFixed(1);
    const summary = esc(summarizeFiles(files));

    await dbService.setSession(chatId, { status: "confirming_upload" });

    await ctx.replyWithHTML(
      quote(
        `📋 ${bold("Konfirmasi upload")}\n\n` +
        `📦 Repo tujuan: ${bold(esc(repoName))}\n` +
        `📊 Total ukuran: ~${totalKB} KB\n\n` +
        `${summary}`
      ) + `\n\nYakin mau push semua file ini?`,
      Markup.inlineKeyboard([
        [
          coloredButton("✅ Ya, push sekarang", "confirmupload", "success"),
          Markup.button.callback("❎ Batal", "cancelupload"),
        ],
      ])
    );
  });

  bot.action("confirmupload", withChatLock(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "confirming_upload") {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /upload untuk mulai lagi.", backToMenuButton());
      return;
    }

    const files = pendingFiles.get(chatId) || {};
    if (Object.keys(files).length === 0) {
      await ctx.editMessageText(
        "File yang dikumpulkan sudah tidak ada (mungkin bot sempat restart). Ketik /upload untuk mulai lagi.",
        backToMenuButton()
      );
      await dbService.clearSession(chatId);
      return;
    }

    const repoName = session.repoName;

    await ctx.editMessageText(`🔄 Push ${Object.keys(files).length} file ke ${bold(esc(repoName))}...`, {
      parse_mode: "HTML",
    });

    const token = decryptToken(dbService.getUserToken(chatId));

    // Progres push: edit pesan status paling cepat tiap 2,5 detik (hindari rate limit Telegram).
    const total = Object.keys(files).length;
    let lastEdit = 0;
    const onProgress = (done) => {
      const now = Date.now();
      if (done < total && now - lastEdit < 2500) return;
      lastEdit = now;
      ctx.editMessageText(`🔄 Push ke ${bold(esc(repoName))}...\n⏳ Mengunggah ${done}/${total} file`, {
        parse_mode: "HTML",
      }).catch(() => {});
    };

    let commitUrl;
    try {
      commitUrl = await pushFiles(token, repoName, files, "Upload via Telegram GitHub Upload Bot", onProgress);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        // File yang sudah dikirim tetap disimpan; kembalikan sesi supaya /done bisa dicoba lagi
        // tanpa harus kirim ulang semua file.
        await dbService.setSession(chatId, { status: "awaiting_files" });
        await ctx.editMessageText(
          `❌ Gagal push: ${esc(err.message)}\n\nFile kamu masih tersimpan. Ketik /done untuk coba lagi, atau /cancel untuk batal.`,
          { parse_mode: "HTML" }
        );
        return;
      }
      throw err;
    }

    await ctx.editMessageText(
      quote(`🎉 Berhasil! ${Object.keys(files).length} file sudah di-push ke ${bold(esc(repoName))}.`) +
        `\n\n🔗 ${esc(commitUrl)}`,
      { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
    );

    await dbService.clearSession(chatId);
    pendingFiles.delete(chatId);
  }));

  bot.action("cancelupload", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    // Kembalikan status ke awaiting_files supaya user bisa kirim/tambah file lagi tanpa mulai dari /upload
    await dbService.setSession(chatId, { status: "awaiting_files" });
    await ctx.editMessageText(
      "❎ Push dibatalkan. File yang sudah dikirim masih tersimpan — kirim file lagi atau ketik /done untuk coba lagi, atau /cancel untuk membatalkan semuanya."
    );
  });

}

module.exports = { registerUploadHandlers, pendingFiles };

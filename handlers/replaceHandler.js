/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /replace:
 * 1. Bot tampilkan daftar repo user -> user pilih
 * 2. User ketik path lama yang mau diganti (folder/file) -> bot cek ada, tampilkan preview
 * 3. Bot tanya: taruh hasil baru di path yang SAMA, atau path BARU?
 *    - Sama -> newPath = oldPath, langsung lanjut ke terima file
 *    - Baru -> user ketik path baru dulu
 * 4. User kirim file/zip baru (bisa berkali-kali, seperti /upload)
 * 5. /done -> hapus path lama + taruh file baru, SATU commit gabungan
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  getPathContents,
  replacePath,
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
const { coloredButton } = require("../utils/buttonUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");

// File baru yang sedang dikumpulkan untuk replace, per chatId (in-memory, sama seperti pendingFiles di uploadHandler)
const pendingReplaceFiles = new Map();

function replaceIntroText(basePath) {
  return (
    quote(
      `✅ File baru akan ditaruh di: ${bold(esc(basePath))}\n\n` +
      `Kirim file/zip pengganti:\n` +
      `• Kirim file <code>.zip</code> → otomatis di-extract ke path ini\n` +
      `• Atau kirim file satu-satu`
    ) +
    `\n\nKalau sudah selesai, ketik /done untuk menerapkan perubahan (1 commit).\n` +
    `⚠️ Maks ${config.MAX_FILE_SIZE_MB}MB per file.`
  );
}

function registerReplaceHandlers(bot) {
  async function handleReplaceStart(ctx, respond) {
    const chatId = String(ctx.chat.id);

    if (!dbService.isUserRegistered(chatId)) {
      await respond("Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.", backToMenuButton());
      return;
    }

    const token = decryptToken(dbService.getUserToken(chatId));
    let repos;
    try {
      repos = await listUserRepos(token);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await respond(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await respond("Kamu belum punya repo sama sekali.", backToMenuButton());
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `replrepo:${r.fullName}`),
    ]);
    await respond("Pilih repo tempat folder/file yang mau di-replace:", withBackToMenu(buttons));
  }

  bot.command("replace", async (ctx) => {
    await handleReplaceStart(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:replace", async (ctx) => {
    await ctx.answerCbQuery();
    await handleReplaceStart(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  bot.action(/^replrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];

    await dbService.setSession(chatId, { status: "awaiting_replace_old_path", replaceRepoName: fullName });

    await ctx.editMessageText(
      quote(`✅ Repo: ${bold(esc(fullName))}`) +
        `\n\nKetik nama folder atau file LAMA yang mau diganti (path relatif dari root repo).\n` +
        `Contoh: ${code("src/config.js")} atau ${code("assets/images")}`,
      { parse_mode: "HTML" }
    );
  });

  // Menangani input teks: path lama, path baru
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session) return next();

    // --- Step: user ketik path lama ---
    if (session.status === "awaiting_replace_old_path") {
      const oldPath = ctx.message.text.trim().replace(/^\/+|\/+$/g, "");
      if (!oldPath) {
        await ctx.reply("Path tidak boleh kosong. Coba lagi:");
        return;
      }

      const fullName = session.replaceRepoName;
      const token = decryptToken(dbService.getUserToken(chatId));

      const statusMsg = await ctx.replyWithHTML(`🔍 Mengecek ${code(oldPath)} di ${esc(fullName)}...`);

      let contents;
      try {
        contents = await getPathContents(token, fullName, oldPath);
      } catch (err) {
        if (err instanceof GitHubServiceError) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, null,
            `❌ ${esc(err.message)}`, { parse_mode: "HTML" }
          );
          return;
        }
        throw err;
      }

      if (contents === null) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `❌ Path ${code(oldPath)} tidak ditemukan di repo ${bold(esc(fullName))}. Coba cek nama/lokasinya lagi:`,
          { parse_mode: "HTML" }
        );
        return; // tetap di status awaiting_replace_old_path supaya bisa coba lagi
      }

      await dbService.setSession(chatId, { replaceOldPath: oldPath, status: "awaiting_replace_path_choice" });

      const preview = contents.slice(0, 10).map((n) => `  • ${esc(n)}`).join("\n");
      const more = contents.length > 10 ? `\n  … dan ${contents.length - 10} item lainnya` : "";

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        quote(`📁 Ditemukan ${code(oldPath)}:\n${preview}${more}`) +
          `\n\nFile/folder baru mau ditaruh di path yang SAMA, atau path BARU?`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback("📍 Path sama", "replpath:same"),
              Markup.button.callback("🆕 Path baru", "replpath:new"),
            ],
          ]),
        }
      );
      return;
    }

    // --- Step: user ketik path baru (kalau pilih "path baru") ---
    if (session.status === "awaiting_replace_new_path") {
      const newBasePath = ctx.message.text.trim().replace(/^\/+|\/+$/g, "");
      if (!newBasePath) {
        await ctx.reply("Path tidak boleh kosong. Coba lagi:");
        return;
      }

      await dbService.setSession(chatId, { replaceNewBasePath: newBasePath, status: "awaiting_replace_files" });
      pendingReplaceFiles.set(chatId, {});

      await ctx.replyWithHTML(replaceIntroText(newBasePath));
      return;
    }

    return next();
  });

  bot.action("replpath:same", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    await dbService.setSession(chatId, {
      replaceNewBasePath: session.replaceOldPath,
      status: "awaiting_replace_files",
    });
    pendingReplaceFiles.set(chatId, {});

    await ctx.editMessageText(replaceIntroText(session.replaceOldPath), { parse_mode: "HTML" });
  });

  bot.action("replpath:new", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.setSession(chatId, { status: "awaiting_replace_new_path" });

    await ctx.editMessageText(
      `Ketik path baru tujuan (folder atau nama file). Contoh: ${code("src/config-v2.js")} atau ${code("assets/images-new")}`,
      { parse_mode: "HTML" }
    );
  });

  // Menerima file (dokumen) selama sesi replace aktif
  bot.on("document", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_replace_files") {
      return next ? next() : undefined;
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

    if (!pendingReplaceFiles.has(chatId)) pendingReplaceFiles.set(chatId, {});
    const currentFiles = pendingReplaceFiles.get(chatId);
    const basePath = session.replaceNewBasePath;

    try {
      if (doc.file_name.toLowerCase().endsWith(".zip")) {
        const extracted = extractZipToObject(fileBuffer, basePath);
        Object.assign(currentFiles, extracted);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `✅ ${code(doc.file_name)} di-extract: ${Object.keys(extracted).length} file ditambahkan.\n` +
            `Total sejauh ini: ${Object.keys(currentFiles).length} file.\n\n` +
            `Kirim file lagi, atau ketik /done untuk menerapkan.`,
          { parse_mode: "HTML" }
        );
      } else {
        const single = singleFileToObject(doc.file_name, fileBuffer, basePath);
        Object.assign(currentFiles, single);
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `✅ ${code(doc.file_name)} ditambahkan.\n` +
            `Total sejauh ini: ${Object.keys(currentFiles).length} file.\n\n` +
            `Kirim file lagi, atau ketik /done untuk menerapkan.`,
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

    if (!session || session.status !== "awaiting_replace_files") {
      return next ? next() : undefined; // biar /done untuk /upload tetap jalan (handler lain)
    }

    const files = pendingReplaceFiles.get(chatId) || {};
    if (Object.keys(files).length === 0) {
      await ctx.reply("Belum ada file pengganti yang dikirim. Kirim file dulu sebelum /done.");
      return;
    }

    const fullName = session.replaceRepoName;
    const oldPath = session.replaceOldPath;
    const totalBytes = Object.values(files).reduce((sum, buf) => sum + buf.length, 0);
    const totalKB = (totalBytes / 1024).toFixed(1);
    const summary = esc(summarizeFiles(files));

    await dbService.setSession(chatId, { status: "confirming_replace" });

    await ctx.replyWithHTML(
      quote(
        `📋 ${bold("Konfirmasi replace")}\n\n` +
        `📦 Repo: ${bold(esc(fullName))}\n` +
        `🗑️ Path lama yang akan dihapus: ${code(oldPath)}\n` +
        `📊 Total file baru: ~${totalKB} KB\n\n` +
        `${summary}`
      ) + `\n\nIni jadi satu commit (hapus lama + tambah baru). Yakin lanjut?`,
      Markup.inlineKeyboard([
        [
          coloredButton("✅ Ya, terapkan", "confirmreplace", "danger"),
          Markup.button.callback("❎ Batal", "cancelreplace"),
        ],
      ])
    );
  });

  bot.action("confirmreplace", withChatLock(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "confirming_replace") {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /replace untuk mulai lagi.", backToMenuButton());
      return;
    }

    const files = pendingReplaceFiles.get(chatId) || {};
    if (Object.keys(files).length === 0) {
      await ctx.editMessageText(
        "File yang dikumpulkan sudah tidak ada (mungkin bot sempat restart). Ketik /replace untuk mulai lagi.",
        backToMenuButton()
      );
      await dbService.clearSession(chatId);
      return;
    }

    const fullName = session.replaceRepoName;
    const oldPath = session.replaceOldPath;

    await ctx.editMessageText(`🔄 Mengganti ${code(oldPath)} di ${bold(esc(fullName))}...`, { parse_mode: "HTML" });

    const token = decryptToken(dbService.getUserToken(chatId));

    let commitUrl;
    try {
      commitUrl = await replacePath(token, fullName, oldPath, files, `Replace ${oldPath} via Telegram bot`);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        // File tetap tersimpan; kembalikan sesi supaya /done bisa diulang tanpa kirim ulang file.
        await dbService.setSession(chatId, { status: "awaiting_replace_files" });
        await ctx.editMessageText(
          `❌ Gagal replace: ${esc(err.message)}\n\nFile kamu masih tersimpan. Ketik /done untuk coba lagi, atau /cancel untuk batal.`,
          { parse_mode: "HTML" }
        );
        return;
      }
      throw err;
    }

    await ctx.editMessageText(
      quote(`🎉 Berhasil! ${code(oldPath)} sudah diganti di ${bold(esc(fullName))}.`) + `\n\n🔗 ${esc(commitUrl)}`,
      { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
    );

    await dbService.clearSession(chatId);
    pendingReplaceFiles.delete(chatId);
  }));

  bot.action("cancelreplace", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.setSession(chatId, { status: "awaiting_replace_files" });
    await ctx.editMessageText(
      "❎ Dibatalkan. File yang sudah dikirim masih tersimpan — kirim file lagi atau ketik /done untuk coba lagi, atau /cancel untuk membatalkan semuanya."
    );
  });
}

module.exports = { registerReplaceHandlers, pendingReplaceFiles };

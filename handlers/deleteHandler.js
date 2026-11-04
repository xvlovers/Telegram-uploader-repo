/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /deleterepo:
 * 1. Bot tampilkan daftar repo user -> user pilih
 * 2. Bot minta konfirmasi (tombol Ya/Batal)
 * 3. Kalau Ya -> repo dihapus permanen
 *
 * Flow /deletepath:
 * 1. Bot tampilkan daftar repo user -> user pilih
 * 2. User ketik nama folder/file yang mau dihapus (path relatif dari root repo)
 * 3. Bot cek path itu ada, tampilkan isi singkatnya, minta konfirmasi
 * 4. Kalau Ya -> folder/file dihapus (repo tetap ada)
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  deleteRepo,
  getPathContents,
  deletePath,
  GitHubServiceError,
} = require("../services/githubService");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { coloredButton } = require("../utils/buttonUtils");

function registerDeleteHandlers(bot) {
  // ---------- DELETE REPO ----------

  bot.command("deleterepo", async (ctx) => {
    const chatId = String(ctx.chat.id);

    if (!dbService.isUserRegistered(chatId)) {
      await ctx.reply("Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.");
      return;
    }

    const token = decryptToken(dbService.getUserToken(chatId));
    let repos;
    try {
      repos = await listUserRepos(token);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.replyWithHTML(`❌ ${esc(err.message)}`);
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await ctx.reply("Kamu belum punya repo sama sekali.");
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `delrepo:${r.fullName}`),
    ]);
    await ctx.replyWithHTML("⚠️ Pilih repo yang mau <b>dihapus permanen</b>:", Markup.inlineKeyboard(buttons));
  });

  bot.action(/^delrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const fullName = ctx.match[1];

    await ctx.editMessageText(
      quote(
        `⚠️ ${bold("Yakin mau hapus repo ini secara PERMANEN?")}\n\n` +
        `📦 ${code(fullName)}\n\n` +
        `Semua isi repo (kode, commit, issue) akan hilang dan ${bold("tidak bisa dikembalikan")}.`
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            coloredButton("🗑️ Ya, hapus", `confirmdelrepo:${fullName}`, "danger"),
            Markup.button.callback("❎ Batal", "canceldelrepo"),
          ],
        ]),
      }
    );
  });

  bot.action(/^confirmdelrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];
    const token = decryptToken(dbService.getUserToken(chatId));

    await ctx.editMessageText(`🔄 Menghapus ${code(fullName)}...`, { parse_mode: "HTML" });

    try {
      await deleteRepo(token, fullName);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML" });
        return;
      }
      throw err;
    }

    await ctx.editMessageText(`✅ Repo ${code(fullName)} sudah dihapus permanen.`, { parse_mode: "HTML" });
  });

  bot.action("canceldelrepo", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("❎ Dibatalkan. Repo tidak jadi dihapus.");
  });

  // ---------- DELETE FOLDER/FILE DALAM REPO ----------

  bot.command("deletepath", async (ctx) => {
    const chatId = String(ctx.chat.id);

    if (!dbService.isUserRegistered(chatId)) {
      await ctx.reply("Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.");
      return;
    }

    const token = decryptToken(dbService.getUserToken(chatId));
    let repos;
    try {
      repos = await listUserRepos(token);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.replyWithHTML(`❌ ${esc(err.message)}`);
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await ctx.reply("Kamu belum punya repo sama sekali.");
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `delpathrepo:${r.fullName}`),
    ]);
    await ctx.reply("Pilih repo tempat folder/file yang mau dihapus:", Markup.inlineKeyboard(buttons));
  });

  bot.action(/^delpathrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];

    await dbService.setSession(chatId, { status: "awaiting_delete_path", deleteRepoName: fullName });

    await ctx.editMessageText(
      quote(`✅ Repo: ${bold(esc(fullName))}`) +
        `\n\nKetik nama folder atau file yang mau dihapus (path relatif dari root repo).\n` +
        `Contoh: ${code("src/oldfolder")} atau ${code("README_lama.md")}`,
      { parse_mode: "HTML" }
    );
  });

  // Menangani input teks nama path yang mau dihapus
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_delete_path") {
      return next();
    }

    const targetPath = ctx.message.text.trim().replace(/^\/+|\/+$/g, "");
    if (!targetPath) {
      await ctx.reply("Path tidak boleh kosong. Coba lagi:");
      return;
    }

    const fullName = session.deleteRepoName;
    const token = decryptToken(dbService.getUserToken(chatId));

    const statusMsg = await ctx.replyWithHTML(`🔍 Mengecek ${code(targetPath)} di ${esc(fullName)}...`);

    let contents;
    try {
      contents = await getPathContents(token, fullName, targetPath);
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
        `❌ Path ${code(targetPath)} tidak ditemukan di repo ${bold(esc(fullName))}. Coba cek nama/lokasinya lagi:`,
        { parse_mode: "HTML" }
      );
      return; // biarkan session tetap awaiting_delete_path supaya user bisa coba lagi
    }

    await dbService.setSession(chatId, { deleteTargetPath: targetPath, status: "confirming_delete_path" });

    const preview = contents.slice(0, 10).map((n) => `  • ${esc(n)}`).join("\n");
    const more = contents.length > 10 ? `\n  … dan ${contents.length - 10} item lainnya` : "";

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      quote(
        `⚠️ ${bold("Yakin mau hapus ini?")}\n\n` +
        `📦 Repo: ${code(fullName)}\n` +
        `📁 Path: ${code(targetPath)}\n\n` +
        `Isi yang akan terhapus:\n${preview}${more}\n\n` +
        `Ini akan jadi satu commit baru dan ${bold("tidak bisa di-undo")} dari bot.`
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            coloredButton("🗑️ Ya, hapus", "confirmdelpath", "danger"),
            Markup.button.callback("❎ Batal", "canceldelpath"),
          ],
        ]),
      }
    );
  });

  bot.action("confirmdelpath", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "confirming_delete_path") {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /deletepath untuk mulai lagi.");
      return;
    }

    const { deleteRepoName: fullName, deleteTargetPath: targetPath } = session;
    const token = decryptToken(dbService.getUserToken(chatId));

    await ctx.editMessageText(`🔄 Menghapus ${code(targetPath)}...`, { parse_mode: "HTML" });

    let commitUrl;
    try {
      commitUrl = await deletePath(token, fullName, targetPath, `Delete ${targetPath} via Telegram bot`);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML" });
        await dbService.clearSession(chatId);
        return;
      }
      throw err;
    }

    await ctx.editMessageText(
      quote(`✅ ${code(targetPath)} berhasil dihapus dari ${bold(esc(fullName))}.`) + `\n\n🔗 ${esc(commitUrl)}`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

    await dbService.clearSession(chatId);
  });

  bot.action("canceldelpath", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.clearSession(chatId);
    await ctx.editMessageText("❎ Dibatalkan. Tidak ada yang dihapus.");
  });
}

module.exports = { registerDeleteHandlers };

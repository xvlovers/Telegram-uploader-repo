/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /rename:
 * 1. Bot tampilkan daftar repo user -> user pilih
 * 2. User ketik path lama (folder/file) -> bot cek ada, tampilkan preview
 * 3. User ketik path/nama baru
 * 4. Bot tampilkan konfirmasi -> user Ya/Batal
 * 5. Kalau Ya -> path dipindahkan (1 commit), TANPA perlu user upload ulang isinya
 *
 * Setiap langkah (kecuali langkah pertama) punya tombol "⬅️ Kembali" yang
 * MENGEDIT pesan yang sama untuk mundur satu langkah dalam alur ini, supaya
 * user tidak perlu ulang dari /rename kalau salah pilih repo/path.
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  getPathContents,
  renamePath,
  GitHubServiceError,
} = require("../services/githubService");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { coloredButton } = require("../utils/buttonUtils");

function registerRenameHandlers(bot) {
  /** Langkah 1: tampilkan daftar repo. Dipakai di awal dan sebagai tujuan tombol Back. */
  async function showRepoList(ctx, respond) {
    const chatId = String(ctx.chat.id);

    if (!dbService.isUserRegistered(chatId)) {
      await respond("Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.", {});
      return;
    }

    const token = decryptToken(dbService.getUserToken(chatId));
    let repos;
    try {
      repos = await listUserRepos(token);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await respond(`❌ ${esc(err.message)}`, { parse_mode: "HTML" });
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await respond("Kamu belum punya repo sama sekali.", {});
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `renrepo:${r.fullName}`),
    ]);
    await respond("Pilih repo tempat folder/file yang mau di-rename:", Markup.inlineKeyboard(buttons));
  }

  bot.command("rename", async (ctx) => {
    await showRepoList(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  /** Langkah 2: minta path lama. Dipakai setelah pilih repo, dan sebagai tujuan tombol Back dari langkah 3. */
  async function askOldPath(ctx, fullName) {
    await dbService.setSession(String(ctx.chat.id), { status: "awaiting_rename_old_path", renameRepoName: fullName });

    await ctx.editMessageText(
      quote(`✅ Repo: ${bold(esc(fullName))}`) +
        `\n\nKetik nama folder atau file LAMA yang mau di-rename (path relatif dari root repo).\n` +
        `Contoh: ${code("src/oldname.js")} atau ${code("assets/old-folder")}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali (pilih repo lain)", "renback:repolist")]]),
      }
    );
  }

  bot.action(/^renrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await askOldPath(ctx, ctx.match[1]);
  });

  // Tombol Back: dari layar "ketik path lama" -> kembali ke daftar repo
  bot.action("renback:repolist", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.clearSession(chatId);
    await showRepoList(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  // Menangani input teks: path lama, path baru
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session) return next();

    // --- Step: user ketik path lama ---
    if (session.status === "awaiting_rename_old_path") {
      const oldPath = ctx.message.text.trim().replace(/^\/+|\/+$/g, "");
      if (!oldPath) {
        await ctx.reply("Path tidak boleh kosong. Coba lagi:");
        return;
      }

      const fullName = session.renameRepoName;
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
        return;
      }

      await dbService.setSession(chatId, { renameOldPath: oldPath, status: "awaiting_rename_new_path" });

      const preview = contents.slice(0, 10).map((n) => `  • ${esc(n)}`).join("\n");
      const more = contents.length > 10 ? `\n  … dan ${contents.length - 10} item lainnya` : "";

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        quote(`📁 Ditemukan ${code(oldPath)}:\n${preview}${more}`) + `\n\nKetik nama/path baru untuk ini:`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali (ganti path lama)", "renback:oldpath")]]),
        }
      );
      return;
    }

    // --- Step: user ketik path baru ---
    if (session.status === "awaiting_rename_new_path") {
      const newPath = ctx.message.text.trim().replace(/^\/+|\/+$/g, "");
      if (!newPath) {
        await ctx.reply("Path tidak boleh kosong. Coba lagi:");
        return;
      }

      if (newPath === session.renameOldPath) {
        await ctx.reply("Path baru sama dengan path lama. Ketik path yang berbeda, atau /cancel untuk batal.");
        return;
      }

      await dbService.setSession(chatId, { renameNewPath: newPath, status: "confirming_rename" });

      await ctx.replyWithHTML(
        quote(
          `📋 ${bold("Konfirmasi rename")}\n\n` +
          `📦 Repo: ${bold(esc(session.renameRepoName))}\n` +
          `📁 Dari: ${code(session.renameOldPath)}\n` +
          `📁 Ke: ${code(newPath)}`
        ) + `\n\nYakin mau lanjut?`,
        Markup.inlineKeyboard([
          [
            coloredButton("✅ Ya, rename", "confirmrename", "success"),
            Markup.button.callback("❎ Batal", "cancelrename"),
          ],
          [Markup.button.callback("⬅️ Kembali (ganti path baru)", "renback:newpath")],
        ])
      );
      return;
    }

    return next();
  });

  // Tombol Back: dari layar "ketik path baru" -> kembali ke minta path lama lagi (repo tetap sama)
  bot.action("renback:oldpath", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);
    if (!session || !session.renameRepoName) {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /rename untuk mulai lagi.");
      return;
    }
    await askOldPath(ctx, session.renameRepoName);
  });

  // Tombol Back: dari layar konfirmasi -> kembali ke "ketik path baru" (path lama & repo tetap)
  bot.action("renback:newpath", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);
    if (!session || !session.renameOldPath) {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /rename untuk mulai lagi.");
      return;
    }

    await dbService.setSession(chatId, { status: "awaiting_rename_new_path" });

    await ctx.editMessageText(
      quote(`📁 Path lama: ${code(session.renameOldPath)}`) + `\n\nKetik nama/path baru untuk ini:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali (ganti path lama)", "renback:oldpath")]]),
      }
    );
  });

  bot.action("confirmrename", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "confirming_rename") {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /rename untuk mulai lagi.");
      return;
    }

    const { renameRepoName: fullName, renameOldPath: oldPath, renameNewPath: newPath } = session;
    const token = decryptToken(dbService.getUserToken(chatId));

    await ctx.editMessageText(`🔄 Mengganti nama ${code(oldPath)} menjadi ${code(newPath)}...`, {
      parse_mode: "HTML",
    });

    let commitUrl;
    try {
      commitUrl = await renamePath(token, fullName, oldPath, newPath, `Rename ${oldPath} to ${newPath} via Telegram bot`);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML" });
        await dbService.clearSession(chatId);
        return;
      }
      throw err;
    }

    await ctx.editMessageText(
      quote(`🎉 Berhasil! ${code(oldPath)} sekarang jadi ${code(newPath)} di ${bold(esc(fullName))}.`) +
        `\n\n🔗 ${esc(commitUrl)}`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

    await dbService.clearSession(chatId);
  });

  bot.action("cancelrename", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.clearSession(chatId);
    await ctx.editMessageText("❎ Dibatalkan. Tidak ada yang diubah.");
  });
}

module.exports = { registerRenameHandlers };

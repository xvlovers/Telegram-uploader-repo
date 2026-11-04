/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

const dbService = require("../services/dbService");
const { encryptToken } = require("../services/cryptoService");
const { validateToken, GitHubServiceError } = require("../services/githubService");
const { esc, bold, quote } = require("../utils/formatUtils");
const { backToMenuButton } = require("../utils/menuUtils");

async function handleLogout(ctx, respond) {
  const chatId = String(ctx.chat.id);
  await dbService.deleteUserToken(chatId);
  await dbService.clearSession(chatId);
  await respond("🔒 Token GitHub kamu sudah dihapus dari bot.", { ...backToMenuButton() });
}

function registerAuthHandlers(bot) {
  bot.command("settoken", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = ctx.message.text.split(" ").slice(1);

    if (args.length === 0) {
      await ctx.replyWithHTML(`Format salah. Gunakan:\n${quote("/settoken TOKEN_KAMU")}`);
      return;
    }

    const token = args[0].trim();

    // Hapus pesan asli yang berisi token demi keamanan (kalau bot punya izin)
    try {
      await ctx.deleteMessage();
    } catch (err) {
      // abaikan kalau bot tidak punya izin hapus pesan (misal di chat privat kadang tidak perlu)
    }

    const statusMsg = await ctx.reply("🔄 Memvalidasi token...");

    let username;
    try {
      username = await validateToken(token);
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

    const encrypted = encryptToken(token);
    await dbService.saveUserToken(chatId, encrypted, username);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `${quote(`✅ Token valid! Terhubung sebagai ${bold(esc(username))}.`)}\n\nSekarang kamu bisa pakai /upload untuk mulai upload file ke repo.`,
      { parse_mode: "HTML", ...backToMenuButton() }
    );
  });

  bot.command("logout", async (ctx) => {
    await handleLogout(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:logout", async (ctx) => {
    await ctx.answerCbQuery();
    await handleLogout(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });
}

module.exports = { registerAuthHandlers, handleLogout };

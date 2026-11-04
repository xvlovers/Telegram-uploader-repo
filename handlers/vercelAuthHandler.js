/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

const dbService = require("../services/dbService");
const { encryptToken } = require("../services/cryptoService");
const { validateToken, VercelServiceError } = require("../services/vercelService");
const { esc, bold, quote } = require("../utils/formatUtils");
const { backToMenuButton } = require("../utils/menuUtils");

async function handleLogoutVercel(ctx, respond) {
  const chatId = String(ctx.chat.id);
  await dbService.deleteVercelToken(chatId);
  await respond("🔒 Token Vercel kamu sudah dihapus dari bot.", { ...backToMenuButton() });
}

function registerVercelAuthHandlers(bot) {
  bot.command("setvercel", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = ctx.message.text.split(" ").slice(1);

    if (args.length === 0) {
      await ctx.replyWithHTML(
        `Format salah. Gunakan:\n${quote("/setvercel TOKEN_KAMU")}\n\n` +
          `Buat token di: https://vercel.com/account/tokens`
      );
      return;
    }

    const token = args[0].trim();

    try {
      await ctx.deleteMessage();
    } catch (err) {
      // abaikan kalau bot tidak punya izin hapus pesan
    }

    const statusMsg = await ctx.reply("🔄 Memvalidasi token Vercel...");

    let username;
    try {
      username = await validateToken(token);
    } catch (err) {
      if (err instanceof VercelServiceError) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, statusMsg.message_id, null,
          `❌ ${esc(err.message)}`, { parse_mode: "HTML" }
        );
        return;
      }
      throw err;
    }

    const encrypted = encryptToken(token);
    await dbService.saveVercelToken(chatId, encrypted, username);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      `${quote(`✅ Token Vercel valid! Terhubung sebagai ${bold(esc(username))}.`)}\n\n` +
        `Sekarang kamu bisa pakai /deploy untuk deploy repo ke Vercel.\n\n` +
        `⚠️ Catatan: repo GitHub yang mau di-deploy sebaiknya sudah pernah di-<b>import</b> ke akun Vercel kamu ` +
        `(lewat dashboard Vercel, "Add New Project"), supaya Vercel punya akses baca repo tersebut.`,
      { parse_mode: "HTML", ...backToMenuButton() }
    );
  });

  bot.command("logoutvercel", async (ctx) => {
    await handleLogoutVercel(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:logoutvercel", async (ctx) => {
    await ctx.answerCbQuery();
    await handleLogoutVercel(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });
}

module.exports = { registerVercelAuthHandlers, handleLogoutVercel };

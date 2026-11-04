/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * /myrepos: tampilkan daftar semua repo milik user beserta info singkat
 * (public/private, terakhir diupdate). Read-only, tidak memicu flow apa pun.
 *
 * handleMyRepos diekspor terpisah supaya bisa dipanggil dari command ("/myrepos")
 * maupun dari tombol menu utama (callback "menu:myrepos") tanpa duplikasi logic.
 */
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const { listUserRepos, GitHubServiceError } = require("../services/githubService");
const { esc, bold, quote } = require("../utils/formatUtils");
const { backToMenuButton } = require("../utils/menuUtils");

function formatRelativeTime(isoString) {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 60) return diffMin <= 1 ? "baru saja" : `${diffMin} menit lalu`;
  if (diffHour < 24) return `${diffHour} jam lalu`;
  if (diffDay < 30) return `${diffDay} hari lalu`;
  return new Date(isoString).toLocaleDateString("id-ID", { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Logic inti /myrepos. `respond` adalah fungsi (text, extra) => Promise yang
 * dipanggil untuk mengirim/mengedit pesan hasil akhir — beda antara dipanggil
 * dari command baru (kirim pesan baru) vs dari tombol menu (edit pesan menu).
 */
async function handleMyRepos(ctx, respond) {
  const chatId = String(ctx.chat.id);

  if (!dbService.isUserRegistered(chatId)) {
    await respond("Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.", {
      ...backToMenuButton(),
    });
    return;
  }

  const token = decryptToken(dbService.getUserToken(chatId));
  await respond("🔄 Mengambil daftar repo...", {});

  let repos;
  try {
    repos = await listUserRepos(token, 30);
  } catch (err) {
    if (err instanceof GitHubServiceError) {
      await respond(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
      return;
    }
    throw err;
  }

  if (repos.length === 0) {
    await respond("Kamu belum punya repo sama sekali. Coba /upload untuk bikin repo baru.", {
      ...backToMenuButton(),
    });
    return;
  }

  const lines = repos.map((r) => {
    const icon = r.private ? "🔒" : "🌐";
    const updated = r.updatedAt ? ` · diupdate ${esc(formatRelativeTime(r.updatedAt))}` : "";
    return `${icon} ${bold(esc(r.name))}${updated}`;
  });

  const username = dbService.getGithubUsername(chatId);
  const header = `📦 Repo milik ${bold(esc(username || "kamu"))} (${repos.length}):`;

  await respond(`${header}\n\n${quote(lines.join("\n"))}`, {
    parse_mode: "HTML",
    ...backToMenuButton(),
  });
}

function registerMyReposHandler(bot) {
  bot.command("myrepos", async (ctx) => {
    let sentMsg = null;
    await handleMyRepos(ctx, async (text, extra) => {
      if (!sentMsg) {
        sentMsg = await ctx.reply(text, extra);
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, text, extra);
      }
    });
  });

  bot.action("menu:myrepos", async (ctx) => {
    await ctx.answerCbQuery();
    await handleMyRepos(ctx, async (text, extra) => {
      await ctx.editMessageText(text, extra);
    });
  });
}

module.exports = { registerMyReposHandler, handleMyRepos };

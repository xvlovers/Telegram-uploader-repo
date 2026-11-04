/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /deploy:
 * 1. Cek user sudah /settoken (GitHub) DAN /setvercel (Vercel)
 * 2. Pilih repo GitHub (seperti fitur lain)
 * 3. Konfirmasi (tombol Ya/Batal) sebelum benar-benar deploy
 * 4. Bot panggil Vercel API buat deployment dari repo itu
 * 5. Bot kasih link hasil deploy + simpan catatan ke riwayat (buat /deployments dkk)
 *
 * /deployments: list riwayat deployment yang pernah dibuat lewat bot ini, dengan status terkini
 * /deploystatus <nomor>: cek detail 1 deployment
 * /deletedeployment: pilih dari riwayat -> konfirmasi -> hapus di Vercel + hapus dari riwayat
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const { listUserRepos, getRepoDefaultBranch, GitHubServiceError } = require("../services/githubService");
const {
  createDeployment,
  getDeploymentStatus,
  deleteDeployment,
  VercelServiceError,
} = require("../services/vercelService");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");
const { mapWithConcurrencyLimit } = require("../utils/concurrencyUtils");
const { coloredButton } = require("../utils/buttonUtils");

const DEPLOYMENT_STATUS_CONCURRENCY = 5;

const READY_STATE_ICON = {
  READY: "✅",
  BUILDING: "🔄",
  QUEUED: "⏳",
  INITIALIZING: "⏳",
  ERROR: "❌",
  CANCELED: "🚫",
};

function formatReadyState(state) {
  const icon = READY_STATE_ICON[state] || "❔";
  return `${icon} ${esc(state || "UNKNOWN")}`;
}

function requireBothTokens(chatId) {
  const hasGithub = dbService.isUserRegistered(chatId);
  const hasVercel = dbService.isVercelRegistered(chatId);
  if (!hasGithub && !hasVercel) {
    return "Kamu belum menghubungkan GitHub maupun Vercel. Gunakan /settoken lalu /setvercel dulu ya.";
  }
  if (!hasGithub) {
    return "Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.";
  }
  if (!hasVercel) {
    return "Kamu belum menghubungkan akun Vercel. Gunakan /setvercel TOKEN_KAMU dulu ya.";
  }
  return null;
}

function registerDeployHandlers(bot) {
  bot.command("deploy", async (ctx) => {
    const chatId = String(ctx.chat.id);

    const errMsg = requireBothTokens(chatId);
    if (errMsg) {
      await ctx.reply(errMsg, backToMenuButton());
      return;
    }

    const githubToken = decryptToken(dbService.getUserToken(chatId));
    let repos;
    try {
      repos = await listUserRepos(githubToken);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.replyWithHTML(`❌ ${esc(err.message)}`, backToMenuButton());
        return;
      }
      throw err;
    }

    if (repos.length === 0) {
      await ctx.reply("Kamu belum punya repo GitHub sama sekali.", backToMenuButton());
      return;
    }

    const buttons = repos.map((r) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `deployrepo:${r.fullName}`),
    ]);
    await ctx.reply("Pilih repo yang mau di-deploy ke Vercel:", withBackToMenu(buttons));
  });

  // Step 1: user pilih repo -> tampilkan konfirmasi, BELUM deploy
  bot.action(/^deployrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const fullName = ctx.match[1];

    await ctx.editMessageText(
      `${quote(`📦 Repo: ${bold(esc(fullName))}`)}\n\nYakin mau deploy repo ini ke Vercel?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            coloredButton("🚀 Ya, deploy", `confirmdeploy:${fullName}`, "primary"),
            Markup.button.callback("❎ Batal", "canceldeploy"),
          ],
        ]),
      }
    );
  });

  // Step 2: konfirmasi -> benar-benar deploy
  bot.action(/^confirmdeploy:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];
    const repoShortName = fullName.split("/")[1];

    await ctx.editMessageText(`🔄 Membuat deployment untuk ${bold(esc(fullName))} di Vercel...`, {
      parse_mode: "HTML",
    });

    const vercelToken = decryptToken(dbService.getVercelToken(chatId));
    const githubToken = decryptToken(dbService.getUserToken(chatId));

    let defaultBranch;
    try {
      defaultBranch = await getRepoDefaultBranch(githubToken, fullName);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    let deployment;
    try {
      deployment = await createDeployment(vercelToken, fullName, repoShortName, defaultBranch);
    } catch (err) {
      if (err instanceof VercelServiceError) {
        await ctx.editMessageText(
          `❌ Gagal membuat deployment: ${esc(err.message)}\n\n` +
            `💡 Kalau errornya soal repo tidak ditemukan/tidak ada akses, kemungkinan repo ini belum pernah ` +
            `di-<b>import</b> ke akun Vercel kamu. Import dulu sekali lewat dashboard Vercel ("Add New Project"), ` +
            `setelah itu /deploy lewat bot akan bisa jalan untuk update berikutnya.`,
          { parse_mode: "HTML", ...backToMenuButton() }
        );
        return;
      }
      throw err;
    }

    await dbService.addDeploymentRecord(chatId, {
      id: deployment.id,
      name: repoShortName,
      repoFullName: fullName,
      createdAt: Date.now(),
    });

    const urlLine = deployment.url ? `\n🔗 ${esc(deployment.url)}` : "";
    await ctx.editMessageText(
      `${quote(`🎉 Deployment dibuat untuk ${bold(esc(fullName))}!\n📊 Status: ${formatReadyState(deployment.readyState)}${urlLine}`)}\n\n` +
        `Deployment biasanya butuh waktu untuk build. Cek statusnya lagi dengan /deployments.`,
      { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
    );
  });

  bot.action("canceldeploy", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("❎ Dibatalkan. Tidak ada deployment yang dibuat.", backToMenuButton());
  });

  async function handleDeployments(ctx, respond) {
    const chatId = String(ctx.chat.id);

    if (!dbService.isVercelRegistered(chatId)) {
      await respond("Kamu belum menghubungkan akun Vercel. Gunakan /setvercel TOKEN_KAMU dulu ya.", backToMenuButton());
      return;
    }

    const records = dbService.listDeploymentRecords(chatId);
    if (records.length === 0) {
      await respond("Belum ada deployment yang dibuat lewat bot ini. Coba /deploy dulu.", backToMenuButton());
      return;
    }

    await respond("🔄 Mengambil status deployment...", {});
    const vercelToken = decryptToken(dbService.getVercelToken(chatId));

    // Ambil status semua deployment secara paralel (bukan satu-per-satu) supaya /deployments
    // tidak lambat kalau riwayatnya sudah banyak. Urutan hasil tetap sesuai `records` asli.
    const lines = await mapWithConcurrencyLimit(records, DEPLOYMENT_STATUS_CONCURRENCY, async (rec, i) => {
      try {
        const status = await getDeploymentStatus(vercelToken, rec.id);
        return `${i + 1}. ${bold(esc(rec.name))} — ${formatReadyState(status.readyState)}\n   ${esc(status.url || "(url belum tersedia)")}`;
      } catch (err) {
        return `${i + 1}. ${bold(esc(rec.name))} — ❔ gagal ambil status (${esc(err.message)})`;
      }
    });

    await respond(
      `${quote(`📦 Riwayat deployment kamu:\n\n${lines.join("\n\n")}`)}\n\n` +
        `Pakai /deploystatus &lt;nomor&gt; untuk detail, atau /deletedeployment untuk hapus.`,
      { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
    );
  }

  bot.command("deployments", async (ctx) => {
    let sentMsg = null;
    await handleDeployments(ctx, async (text, extra) => {
      if (!sentMsg) {
        sentMsg = await ctx.reply(text, extra);
      } else {
        await ctx.telegram.editMessageText(ctx.chat.id, sentMsg.message_id, null, text, extra);
      }
    });
  });

  bot.action("menu:deployments", async (ctx) => {
    await ctx.answerCbQuery();
    await handleDeployments(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  bot.command("deploystatus", async (ctx) => {
    const chatId = String(ctx.chat.id);

    if (!dbService.isVercelRegistered(chatId)) {
      await ctx.reply("Kamu belum menghubungkan akun Vercel. Gunakan /setvercel TOKEN_KAMU dulu ya.", backToMenuButton());
      return;
    }

    const args = ctx.message.text.split(" ").slice(1);
    const records = dbService.listDeploymentRecords(chatId);

    if (records.length === 0) {
      await ctx.reply("Belum ada deployment yang dibuat lewat bot ini. Coba /deploy dulu.", backToMenuButton());
      return;
    }

    if (args.length === 0) {
      await ctx.replyWithHTML(
        `Format: ${code("/deploystatus <nomor>")}\n\nLihat nomornya lewat /deployments dulu.`
      );
      return;
    }

    const idx = parseInt(args[0], 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= records.length) {
      await ctx.reply(`Nomor tidak valid. Kamu punya ${records.length} deployment (1-${records.length}).`);
      return;
    }

    const rec = records[idx];
    const statusMsg = await ctx.replyWithHTML(`🔍 Mengecek status ${bold(esc(rec.name))}...`);
    await renderDeployStatus(ctx, statusMsg.message_id, rec, idx);
  });

  /** Render/refresh tampilan status 1 deployment (dipakai command awal & tombol Refresh). */
  async function renderDeployStatus(ctx, messageId, rec, idx) {
    const chatId = String(ctx.chat.id);
    const vercelToken = decryptToken(dbService.getVercelToken(chatId));

    let status;
    try {
      status = await getDeploymentStatus(vercelToken, rec.id);
    } catch (err) {
      if (err instanceof VercelServiceError) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, messageId, null,
          `❌ ${esc(err.message)}`, { parse_mode: "HTML" }
        );
        return;
      }
      throw err;
    }

    const createdDate = status.createdAt ? new Date(status.createdAt).toLocaleString("id-ID") : "tidak diketahui";
    const isFinal = status.readyState === "READY" || status.readyState === "ERROR" || status.readyState === "CANCELED";

    // Bangun tombol secara eksplisit (bukan mengakses struktur internal object Markup lain)
    // supaya tidak tergantung detail implementasi Markup.inlineKeyboard().
    const rows = [];
    if (!isFinal) {
      rows.push([Markup.button.callback("🔄 Refresh", `refreshdeploy:${idx}`)]);
    }
    rows.push([Markup.button.callback("⬅️ Menu", "menu:home")]);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      messageId,
      null,
      quote(
        `📦 ${bold(esc(rec.name))}\n` +
          `📁 Repo: ${esc(rec.repoFullName)}\n` +
          `🎯 Environment: ${bold("Production")}\n` +
          `📊 Status: ${formatReadyState(status.readyState)}\n` +
          `🕐 Dibuat: ${esc(createdDate)}\n` +
          `🔗 ${esc(status.url || "(url belum tersedia)")}`
      ),
      { parse_mode: "HTML", disable_web_page_preview: true, ...Markup.inlineKeyboard(rows) }
    );
  }

  bot.action(/^refreshdeploy:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery("Memuat ulang...");
    const chatId = String(ctx.chat.id);
    const idx = parseInt(ctx.match[1], 10);
    const records = dbService.listDeploymentRecords(chatId);

    if (idx < 0 || idx >= records.length) {
      await ctx.editMessageText("Riwayat deployment sudah berubah. Ketik /deployments untuk lihat daftar terbaru.", backToMenuButton());
      return;
    }

    await renderDeployStatus(ctx, ctx.callbackQuery.message.message_id, records[idx], idx);
  });

  async function handleDeleteDeploymentList(ctx, respond) {
    const chatId = String(ctx.chat.id);

    if (!dbService.isVercelRegistered(chatId)) {
      await respond("Kamu belum menghubungkan akun Vercel. Gunakan /setvercel TOKEN_KAMU dulu ya.", backToMenuButton());
      return;
    }

    const records = dbService.listDeploymentRecords(chatId);
    if (records.length === 0) {
      await respond("Belum ada deployment yang dibuat lewat bot ini.", backToMenuButton());
      return;
    }

    const buttons = records.map((rec) => [Markup.button.callback(`${rec.name}`, `deldeploy:${rec.id}`)]);
    await respond("Pilih deployment yang mau dihapus:", withBackToMenu(buttons));
  }

  bot.command("deletedeployment", async (ctx) => {
    await handleDeleteDeploymentList(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:deletedeployment", async (ctx) => {
    await ctx.answerCbQuery();
    await handleDeleteDeploymentList(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  bot.action(/^deldeploy:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const deploymentId = ctx.match[1];

    await ctx.editMessageText(
      `${quote(`⚠️ Yakin mau hapus deployment ini secara permanen dari Vercel?\n\nID: ${esc(deploymentId)}`)}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            coloredButton("🗑️ Ya, hapus", `confirmdeldeploy:${deploymentId}`, "danger"),
            Markup.button.callback("❎ Batal", "canceldeldeploy"),
          ],
        ]),
      }
    );
  });

  bot.action(/^confirmdeldeploy:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const deploymentId = ctx.match[1];
    const vercelToken = decryptToken(dbService.getVercelToken(chatId));

    await ctx.editMessageText(`🔄 Menghapus deployment...`);

    try {
      await deleteDeployment(vercelToken, deploymentId);
    } catch (err) {
      if (err instanceof VercelServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    await dbService.removeDeploymentRecord(chatId, deploymentId);
    await ctx.editMessageText(`✅ Deployment sudah dihapus.`, backToMenuButton());
  });

  bot.action("canceldeldeploy", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("❎ Dibatalkan. Deployment tidak jadi dihapus.", backToMenuButton());
  });
}

module.exports = { registerDeployHandlers };

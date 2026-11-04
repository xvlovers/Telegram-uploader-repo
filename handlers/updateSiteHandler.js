/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /updatesite: ganti SELURUH isi repo dengan isi zip baru, lalu otomatis
 * trigger redeploy ke Vercel — tanpa bikin repo atau project Vercel baru.
 * Cocok untuk kasus "situs full-stack sudah live di Vercel, mau ganti total source code-nya".
 *
 * 1. Cek user sudah /settoken (GitHub) DAN /setvercel (Vercel)
 * 2. Pilih repo GitHub yang mau di-update
 * 3. Kirim SATU file .zip berisi source code baru
 * 4. Konfirmasi TEGAS (repo lama akan dihapus total, diganti isi zip)
 * 5. Kalau Ya:
 *    a. replaceEntireRepo() -> semua file lama dihapus, diganti isi zip, 1 commit
 *    b. createDeployment() -> otomatis trigger deploy baru di Vercel, project SAMA (tidak bikin baru)
 *    c. simpan riwayat deployment baru, kasih link commit + link deploy
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  getRepoDefaultBranch,
  replaceEntireRepo,
  GitHubServiceError,
} = require("../services/githubService");
const { createDeployment, VercelServiceError } = require("../services/vercelService");
const { extractZipToObject, FileProcessingError } = require("../utils/fileUtils");
const { config } = require("../config");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { downloadTelegramFile, DownloadError, safeEditById, withChatLock } = require("../utils/telegramUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");
const { coloredButton } = require("../utils/buttonUtils");

const READY_STATE_ICON = {
  READY: "✅", BUILDING: "🔄", QUEUED: "⏳", INITIALIZING: "⏳", ERROR: "❌", CANCELED: "🚫",
};
function formatReadyState(state) {
  const icon = READY_STATE_ICON[state] || "❔";
  return `${icon} ${esc(state || "UNKNOWN")}`;
}

// File zip yang sedang menunggu konfirmasi, per chatId (in-memory, sama pola dengan upload/replace)
const pendingUpdateZip = new Map();

function requireBothTokens(chatId) {
  const hasGithub = dbService.isUserRegistered(chatId);
  const hasVercel = dbService.isVercelRegistered(chatId);
  if (!hasGithub && !hasVercel) {
    return "Kamu belum menghubungkan GitHub maupun Vercel. Gunakan /settoken lalu /setvercel dulu ya.";
  }
  if (!hasGithub) return "Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.";
  if (!hasVercel) return "Kamu belum menghubungkan akun Vercel. Gunakan /setvercel TOKEN_KAMU dulu ya.";
  return null;
}

function registerUpdateSiteHandlers(bot) {
  bot.command("updatesite", async (ctx) => {
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
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `updatesiterepo:${r.fullName}`),
    ]);
    await ctx.replyWithHTML(
      quote(
        "⚠️ <b>Perhatian:</b> fitur ini akan MENGHAPUS TOTAL semua file lama di repo yang kamu pilih, " +
          "lalu menggantinya dengan isi zip baru yang kamu kirim. Cocok untuk update source code situs " +
          "yang sudah live tanpa bikin repo/project baru."
      ) + "\n\nPilih repo yang mau di-update:",
      withBackToMenu(buttons)
    );
  });

  bot.action(/^updatesiterepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = ctx.match[1];

    // Cek apakah repo ini punya riwayat deployment Vercel lewat bot, buat konteks tambahan ke user
    const deployRecords = dbService.listDeploymentRecords(chatId).filter((d) => d.repoFullName === fullName);
    const deployInfo =
      deployRecords.length > 0
        ? `\n\n📈 Repo ini sudah pernah di-deploy lewat bot (${deployRecords.length}x). Deploy baru akan dibuat ke project Vercel yang sama.`
        : `\n\n⚠️ Bot belum punya riwayat deploy untuk repo ini. Pastikan repo ini <b>sudah pernah di-import</b> ke Vercel (lewat dashboard, "Add New Project") sebelum lanjut, kalau belum langkah deploy di akhir akan gagal.`;

    await dbService.setSession(chatId, { status: "awaiting_updatesite_zip", updateSiteRepoName: fullName });

    await ctx.editMessageText(
      quote(`✅ Repo: ${bold(esc(fullName))}`) +
        deployInfo +
        `\n\nSekarang kirim SATU file <code>.zip</code> berisi source code baru (seluruh project).\n` +
        `⚠️ Maks ${config.MAX_FILE_SIZE_MB}MB.`,
      { parse_mode: "HTML" }
    );
  });

  bot.on("document", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "awaiting_updatesite_zip") {
      return next ? next() : undefined;
    }

    const doc = ctx.message.document;

    if (!doc.file_name.toLowerCase().endsWith(".zip")) {
      await ctx.replyWithHTML(
        `❌ ${code(doc.file_name)} bukan file .zip. /updatesite cuma menerima satu file zip berisi seluruh project.`
      );
      return;
    }

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

    let files;
    try {
      files = extractZipToObject(fileBuffer);
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

    pendingUpdateZip.set(chatId, files);
    await dbService.setSession(chatId, { status: "confirming_updatesite" });

    const fullName = session.updateSiteRepoName;
    const fileCount = Object.keys(files).length;
    const totalBytes = Object.values(files).reduce((sum, buf) => sum + buf.length, 0);
    const totalKB = (totalBytes / 1024).toFixed(1);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      null,
      quote(
        `⚠️ ${bold("KONFIRMASI TERAKHIR")}\n\n` +
        `📦 Repo: ${bold(esc(fullName))}\n` +
        `📊 Zip baru: ${fileCount} file, ~${totalKB} KB\n\n` +
        `${bold("SEMUA file lama di repo ini akan DIHAPUS TOTAL")} dan diganti isi zip ini. ` +
        `Setelah itu bot otomatis trigger deploy baru ke Vercel.\n\n` +
        `Aksi ini ${bold("tidak bisa di-undo")} dari bot. Yakin lanjut?`
      ),
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            coloredButton("🔥 Ya, ganti total & deploy", "confirmupdatesite", "danger"),
            Markup.button.callback("❎ Batal", "cancelupdatesite"),
          ],
        ]),
      }
    );
  });

  bot.action("confirmupdatesite", withChatLock(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    if (!session || session.status !== "confirming_updatesite") {
      await ctx.editMessageText("Sesi sudah tidak berlaku. Ketik /updatesite untuk mulai lagi.", backToMenuButton());
      return;
    }

    const files = pendingUpdateZip.get(chatId);
    if (!files) {
      await ctx.editMessageText(
        "File zip yang dikumpulkan sudah tidak ada (mungkin bot sempat restart). Ketik /updatesite untuk mulai lagi.",
        backToMenuButton()
      );
      await dbService.clearSession(chatId);
      return;
    }

    const fullName = session.updateSiteRepoName;
    const githubToken = decryptToken(dbService.getUserToken(chatId));

    // --- Tahap 1: ganti seluruh isi repo ---
    await ctx.editMessageText(`🔄 Mengganti seluruh isi ${bold(esc(fullName))}...`, { parse_mode: "HTML" });

    let replaceResult;
    try {
      replaceResult = await replaceEntireRepo(
        githubToken, fullName, files,
        "Update site (full replace) via Telegram bot"
      );
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ Gagal update repo: ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        await dbService.clearSession(chatId);
        pendingUpdateZip.delete(chatId);
        return;
      }
      throw err;
    }

    // --- Tahap 2: trigger deploy baru ke Vercel, pakai branch yang benar dari repo ---
    await ctx.editMessageText(
      quote(`✅ Repo sudah diganti.\n🔗 ${esc(replaceResult.commitUrl)}`) + `\n\n🔄 Trigger deploy ke Vercel...`,
      { parse_mode: "HTML", disable_web_page_preview: true }
    );

    const vercelToken = decryptToken(dbService.getVercelToken(chatId));
    const repoShortName = fullName.split("/")[1];

    let deployment;
    try {
      deployment = await createDeployment(vercelToken, fullName, repoShortName, replaceResult.defaultBranch);
    } catch (err) {
      if (err instanceof VercelServiceError) {
        await ctx.editMessageText(
          quote(`✅ Repo sudah diganti (source code sudah update).\n🔗 ${esc(replaceResult.commitUrl)}`) +
            `\n\n❌ Tapi gagal trigger deploy: ${esc(err.message)}\n\n` +
            `💡 Repo ini kemungkinan belum pernah di-import ke akun Vercel kamu. ` +
            `Import dulu sekali lewat dashboard Vercel, baru coba /deploy manual.`,
          { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
        );
        await dbService.clearSession(chatId);
        pendingUpdateZip.delete(chatId);
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

    const deployUrlLine = deployment.url ? `\n🔗 ${esc(deployment.url)}` : "";
    await ctx.editMessageText(
      quote(
        `🎉 ${bold("Situs berhasil diupdate!")}\n\n` +
        `📦 Repo: ${bold(esc(fullName))}\n` +
        `📝 Commit: ${esc(replaceResult.commitUrl)}\n` +
        `📊 Status deploy: ${formatReadyState(deployment.readyState)}${deployUrlLine}`
      ) + `\n\nDeploy biasanya butuh waktu build. Cek statusnya lagi dengan /deployments.`,
      { parse_mode: "HTML", disable_web_page_preview: true, ...backToMenuButton() }
    );

    await dbService.clearSession(chatId);
    pendingUpdateZip.delete(chatId);
  }));

  bot.action("cancelupdatesite", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await dbService.clearSession(chatId);
    pendingUpdateZip.delete(chatId);
    await ctx.editMessageText("❎ Dibatalkan. Tidak ada yang diubah di repo maupun Vercel.");
  });
}

module.exports = { registerUpdateSiteHandlers, pendingUpdateZip };

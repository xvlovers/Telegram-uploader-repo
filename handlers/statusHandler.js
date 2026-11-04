/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * /status: tampilkan sesi/flow yang sedang aktif buat user saat ini (kalau ada),
 * supaya user yang lupa lagi di tengah proses apa bisa cek tanpa mulai ulang.
 * Read-only, tidak mengubah state apa pun.
 */
const dbService = require("../services/dbService");
const { esc, bold, quote } = require("../utils/formatUtils");
const { backToMenuButton } = require("../utils/menuUtils");

// Mapping status internal -> deskripsi ramah + command terkait, dipakai untuk /status.
const STATUS_DESCRIPTIONS = {
  awaiting_new_repo_name: { flow: "Upload", desc: "Menunggu kamu ketik nama repo baru." },
  awaiting_files: { flow: "Upload", desc: "Menunggu file dikirim. Ketik /done kalau sudah selesai." },
  confirming_upload: { flow: "Upload", desc: "Menunggu konfirmasi push (tombol Ya/Batal)." },
  awaiting_delete_path: { flow: "Delete Path", desc: "Menunggu kamu ketik path yang mau dihapus." },
  confirming_delete_path: { flow: "Delete Path", desc: "Menunggu konfirmasi hapus (tombol Ya/Batal)." },
  awaiting_replace_old_path: { flow: "Replace", desc: "Menunggu kamu ketik path lama yang mau diganti." },
  awaiting_replace_path_choice: { flow: "Replace", desc: "Menunggu pilihan path sama/baru." },
  awaiting_replace_new_path: { flow: "Replace", desc: "Menunggu kamu ketik path baru." },
  awaiting_replace_files: { flow: "Replace", desc: "Menunggu file pengganti dikirim. Ketik /done kalau sudah selesai." },
  confirming_replace: { flow: "Replace", desc: "Menunggu konfirmasi terapkan (tombol Ya/Batal)." },
  awaiting_rename_old_path: { flow: "Rename", desc: "Menunggu kamu ketik path lama yang mau di-rename." },
  awaiting_rename_new_path: { flow: "Rename", desc: "Menunggu kamu ketik path/nama baru." },
  confirming_rename: { flow: "Rename", desc: "Menunggu konfirmasi rename (tombol Ya/Batal)." },
  awaiting_updatesite_zip: { flow: "Update Site", desc: "Menunggu kamu kirim satu file .zip berisi source code baru." },
  confirming_updatesite: { flow: "Update Site", desc: "Menunggu konfirmasi ganti total isi repo + deploy (tombol Ya/Batal)." },
};

function registerStatusHandler(bot) {
  async function handleStatus(ctx, respond) {
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);

    const githubStatus = dbService.isUserRegistered(chatId)
      ? `✅ terhubung sebagai ${bold(esc(dbService.getGithubUsername(chatId) || "?"))}`
      : "❌ belum terhubung (pakai /settoken)";
    const vercelStatus = dbService.isVercelRegistered(chatId)
      ? `✅ terhubung sebagai ${bold(esc(dbService.getVercelUsername(chatId) || "?"))}`
      : "❌ belum terhubung (opsional, pakai /setvercel)";

    let flowLines;
    if (!session || !session.status || !STATUS_DESCRIPTIONS[session.status]) {
      flowLines = "Tidak ada proses yang sedang berjalan.";
    } else {
      const info = STATUS_DESCRIPTIONS[session.status];
      const repoLine = session.repoName || session.replaceRepoName || session.renameRepoName || session.downloadRepoName || session.updateSiteRepoName;
      flowLines =
        `🔄 Proses aktif: ${bold(esc(info.flow))}\n` +
        (repoLine ? `📦 Repo: ${esc(repoLine)}\n` : "") +
        `📝 ${esc(info.desc)}\n\n` +
        `Ketik /cancel untuk membatalkan proses ini.`;
    }

    const text =
      `${quote(`🐙 GitHub: ${githubStatus}\n🚀 Vercel: ${vercelStatus}`)}\n\n${flowLines}`;

    await respond(text, { parse_mode: "HTML", ...backToMenuButton() });
  }

  bot.command("status", async (ctx) => {
    await handleStatus(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:status", async (ctx) => {
    await ctx.answerCbQuery();
    await handleStatus(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });
}

module.exports = { registerStatusHandler };

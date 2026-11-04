/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * /start & /help: pesan panduan awal bot, format HTML dengan blockquote
 * supaya terasa seperti "kartu info" yang rapi.
 */
const { quote, bold, code } = require("../utils/formatUtils");

const WELCOME_TEXT =
  "👋 " + bold("Selamat datang di GitHub Upload Bot!") + "\n\n" +
  "Bot ini bantu kamu upload, download, dan kelola file/folder repo GitHub " +
  "langsung dari Telegram — tanpa perlu buka terminal. Bisa juga deploy ke Vercel.\n\n" +
  quote(
    "🔑 <b>Mulai dari sini (GitHub):</b>\n" +
    "1️⃣ Buka https://github.com/settings/tokens/new\n" +
    "2️⃣ Centang scope <b>repo</b> (dan <b>delete_repo</b> kalau mau pakai /deleterepo)\n" +
    "3️⃣ Kirim ke bot: <code>/settoken TOKEN_KAMU</code>"
  ) +
  "\n\n" +
  quote(
    "🚀 <b>Opsional (Vercel):</b>\n" +
    "1️⃣ Buka https://vercel.com/account/tokens\n" +
    "2️⃣ Generate token, lalu kirim: <code>/setvercel TOKEN_KAMU</code>"
  ) +
  "\n\n" +
  bold("📂 Kelola Repo & File") + "\n" +
  "/myrepos — lihat daftar repo kamu\n" +
  "/upload — upload file/folder/zip ke repo\n" +
  "/download — download seluruh repo (zip) atau file tertentu\n" +
  "/replace — ganti folder/file lama dengan yang baru (1 commit)\n" +
  "/rename — ganti nama/pindahkan folder/file (tanpa upload ulang)\n" +
  "/deletepath — hapus folder/file tertentu dalam repo\n" +
  "/deleterepo — hapus repo secara permanen\n\n" +
  bold("⚙️ GitHub Actions") + "\n" +
  "/actions — jalankan workflow, pantau build real-time (status job/step + console), cancel, re-run, ambil log\n\n" +
  bold("🚀 Deploy ke Vercel") + "\n" +
  "/deploy — deploy repo GitHub ke Vercel\n" +
  "/updatesite — ganti TOTAL isi repo dari zip baru + auto redeploy (untuk update situs full-stack tanpa bikin repo baru)\n" +
  "/deployments — lihat riwayat & status deployment kamu\n" +
  "/deploystatus " + code("<nomor>") + " — cek detail 1 deployment\n" +
  "/deletedeployment — hapus deployment\n\n" +
  bold("⚙️ Lainnya") + "\n" +
  "/status — cek sesi yang sedang berjalan\n" +
  "/logout — hapus token GitHub dari bot\n" +
  "/logoutvercel — hapus token Vercel dari bot\n" +
  "/cancel — batalkan proses yang sedang berjalan\n" +
  "/help — tampilkan pesan ini lagi\n\n" +
  "⚠️ Token kamu disimpan terenkripsi dan hanya dipakai untuk aksi atas nama kamu.";

function registerStartHandlers(bot) {
  bot.start((ctx) => ctx.replyWithHTML(WELCOME_TEXT, { disable_web_page_preview: true }));
  bot.help((ctx) => ctx.replyWithHTML(WELCOME_TEXT, { disable_web_page_preview: true }));
}

module.exports = { registerStartHandlers, WELCOME_TEXT };

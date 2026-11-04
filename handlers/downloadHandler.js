/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Flow /download:
 * 1. Bot tampilkan daftar repo user -> user pilih
 * 2. Bot tanya: download seluruh repo (zip) atau pilih file/folder tertentu?
 * 3a. (zip) -> bot ambil zip archive dari GitHub, kirim sebagai dokumen
 * 3b. (pilih file) -> file browser:
 *     - Tampilkan isi folder saat ini sebagai grid tombol (folder & file beda ikon)
 *     - Kalau item banyak -> tombol Prev/Next (pagination)
 *     - Klik folder -> masuk ke dalamnya
 *     - Klik file -> download & kirim file itu
 *     - Tombol "⬆️ Kembali" untuk naik ke folder induk
 */
const { Markup, Input } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const {
  listUserRepos,
  listDirectory,
  downloadFile,
  downloadRepoZip,
  GitHubServiceError,
} = require("../services/githubService");
const { buildPaginatedKeyboard } = require("../utils/paginationUtils");
const { config } = require("../config");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parentPath(dirPath) {
  if (!dirPath) return "";
  const parts = dirPath.split("/");
  parts.pop();
  return parts.join("/");
}

function registerDownloadHandlers(bot) {
  async function handleDownloadStart(ctx, respond) {
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
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `dlrepo:${r.fullName}`),
    ]);
    await respond("Pilih repo yang mau di-download:", withBackToMenu(buttons));
  }

  bot.command("download", async (ctx) => {
    await handleDownloadStart(ctx, async (text, extra) => ctx.reply(text, extra));
  });

  bot.action("menu:download", async (ctx) => {
    await ctx.answerCbQuery();
    await handleDownloadStart(ctx, async (text, extra) => ctx.editMessageText(text, extra));
  });

  bot.action(/^dlrepo:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const fullName = ctx.match[1];
    const chatId = String(ctx.chat.id);

    await dbService.setSession(chatId, { downloadRepoName: fullName });

    await ctx.editMessageText(
      `${quote(`📦 Repo: ${bold(esc(fullName))}`)}\n\nMau download seluruh repo sebagai zip, atau pilih file/folder tertentu?`,
      {
        parse_mode: "HTML",
        ...withBackToMenu([
          [Markup.button.callback("📦 Seluruh repo (zip)", "dlmode:zip")],
          [Markup.button.callback("📁 Pilih file/folder", "dlmode:browse")],
        ]),
      }
    );
  });

  bot.action("dlmode:zip", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const session = dbService.getSession(chatId);
    const fullName = session.downloadRepoName;

    await ctx.editMessageText(`🔄 Menyiapkan zip untuk ${bold(esc(fullName))}...`, { parse_mode: "HTML" });

    const token = decryptToken(dbService.getUserToken(chatId));
    let zipBuffer;
    try {
      zipBuffer = await downloadRepoZip(token, fullName);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    if (zipBuffer.length > config.MAX_FILE_SIZE_BYTES) {
      await ctx.editMessageText(
        `❌ Zip repo ini berukuran ${formatSize(zipBuffer.length)}, melebihi batas ${config.MAX_FILE_SIZE_MB}MB ` +
          `yang bisa dikirim bot Telegram. Coba pakai "Pilih file/folder" untuk download sebagian saja.`,
        backToMenuButton()
      );
      return;
    }

    const repoShortName = fullName.split("/")[1];
    await ctx.replyWithDocument(Input.fromBuffer(zipBuffer, `${repoShortName}.zip`), {
      caption: `✅ ${fullName}`,
    });
    await dbService.clearSession(chatId);
  });

  bot.action("dlmode:browse", async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    await showDirectory(ctx, chatId, "", 0);
  });

  /** Tampilkan isi folder dirPath sebagai grid tombol dengan pagination. */
  async function showDirectory(ctx, chatId, dirPath, page) {
    const session = dbService.getSession(chatId);
    const fullName = session.downloadRepoName;
    const token = decryptToken(dbService.getUserToken(chatId));

    let items;
    try {
      items = await listDirectory(token, fullName, dirPath);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.editMessageText(`❌ ${esc(err.message)}`, { parse_mode: "HTML", ...backToMenuButton() });
        return;
      }
      throw err;
    }

    if (items === null) {
      await ctx.editMessageText(`❌ Folder tidak ditemukan atau path tidak valid.`, backToMenuButton());
      return;
    }

    // Path folder/file bisa panjang dan melebihi batas 64 byte callback_data Telegram
    // kalau ditulis langsung. Jadi kita simpan semua path di sebuah "kamus" per-request
    // (pathMap) dan callback cukup kirim index pendek yang merujuk ke situ.
    const pathMap = { "": "" }; // index "" selalu berarti root/parent saat ini
    let pathCounter = 0;
    function registerPath(p) {
      const idx = String(pathCounter++);
      pathMap[idx] = p;
      return idx;
    }

    const parentIdx = dirPath === "" ? null : registerPath(parentPath(dirPath));

    await dbService.setSession(chatId, {
      downloadCurrentPath: dirPath,
      downloadCurrentPage: page,
      downloadPathMap: pathMap,
    });

    const headerPath = esc(dirPath || "(root)");

    if (items.length === 0) {
      const backBtn = parentIdx === null ? [] : [{ label: "⬆️ Kembali", callbackData: `dlnav:${parentIdx}:0` }];
      const { keyboard } = buildPaginatedKeyboard([], 0, { extraButtons: backBtn });
      await dbService.setSession(chatId, { downloadPathMap: pathMap });
      await ctx.editMessageText(`📂 ${code(dirPath || "(root)")}\n\n(kosong)`, {
        parse_mode: "HTML",
        ...keyboard,
      });
      return;
    }

    const buttonItems = items.map((item) => {
      const icon = item.type === "dir" ? "📁" : "📄";
      const label = item.type === "dir" ? `${icon} ${item.name}` : `${icon} ${item.name} (${formatSize(item.size)})`;
      const idx = registerPath(item.path);
      const action = item.type === "dir" ? `dlnav:${idx}:0` : `dlfile:${idx}`;
      return { label, callbackData: action };
    });

    const extraButtons = [];
    if (parentIdx !== null) {
      extraButtons.push({ label: "⬆️ Kembali", callbackData: `dlnav:${parentIdx}:0` });
    }
    extraButtons.push({ label: "⬅️ Menu", callbackData: "menu:home" });

    const { keyboard } = buildPaginatedKeyboard(buttonItems, page, {
      extraButtons,
      pageCallbackPrefix: `dlpage`,
    });

    // Simpan ulang pathMap final (sudah lengkap dengan semua index item halaman ini)
    await dbService.setSession(chatId, { downloadPathMap: pathMap });

    await ctx.editMessageText(`📂 ${code(dirPath || "(root)")}\n\nPilih folder untuk masuk, atau file untuk download:`, {
      parse_mode: "HTML",
      ...keyboard,
    });
  }

  // Navigasi ke folder (idx merujuk ke downloadPathMap di session, page angka)
  bot.action(/^dlnav:(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const idx = ctx.match[1];
    const page = parseInt(ctx.match[2], 10);
    const session = dbService.getSession(chatId);
    const pathMap = session?.downloadPathMap || {};
    const dirPath = pathMap[idx];

    if (dirPath === undefined) {
      await ctx.editMessageText("Sesi navigasi sudah kedaluwarsa. Ketik /download untuk mulai lagi.", backToMenuButton());
      return;
    }

    await showDirectory(ctx, chatId, dirPath, page);
  });

  // Ganti halaman di folder yang sama (path folder aktif diambil dari session, bukan dari callback_data)
  bot.action(/^dlpage:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const page = parseInt(ctx.match[1], 10);
    const session = dbService.getSession(chatId);
    const dirPath = session?.downloadCurrentPath || "";
    await showDirectory(ctx, chatId, dirPath, page);
  });

  // Tombol nomor halaman (mis. "2/3") yang tidak melakukan apa-apa
  bot.action("noop", async (ctx) => {
    await ctx.answerCbQuery();
  });

  // Klik file -> download & kirim (idx merujuk ke downloadPathMap di session)
  bot.action(/^dlfile:(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const idx = ctx.match[1];
    const session = dbService.getSession(chatId);
    const pathMap = session?.downloadPathMap || {};
    const filePath = pathMap[idx];

    if (filePath === undefined) {
      await ctx.reply("Sesi navigasi sudah kedaluwarsa. Ketik /download untuk mulai lagi.", backToMenuButton());
      return;
    }

    const fullName = session.downloadRepoName;
    const token = decryptToken(dbService.getUserToken(chatId));
    const fileName = filePath.split("/").pop();

    await ctx.replyWithHTML(`⬇️ Mengunduh ${code(fileName)}...`);

    let result;
    try {
      result = await downloadFile(token, fullName, filePath);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await ctx.replyWithHTML(`❌ ${esc(err.message)}`, backToMenuButton());
        return;
      }
      throw err;
    }

    if (result.size > config.MAX_FILE_SIZE_BYTES) {
      await ctx.replyWithHTML(
        `❌ File ${code(fileName)} berukuran ${formatSize(result.size)}, melebihi batas ${config.MAX_FILE_SIZE_MB}MB ` +
          `yang bisa dikirim bot Telegram.`
      );
      return;
    }

    await ctx.replyWithDocument(Input.fromBuffer(result.content, fileName), { caption: `✅ ${filePath}` });
  });
}

module.exports = { registerDownloadHandlers };

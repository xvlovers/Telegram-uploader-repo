/**
 * /actions — kelola & pantau GitHub Actions langsung dari Telegram.
 *
 * Fitur:
 * - Pilih repo -> lihat daftar workflow -> jalankan (workflow_dispatch), dengan/tanpa input
 * - Pantau run secara REAL-TIME: pesan status di-update otomatis (job, step, durasi),
 *   plus potongan console (log) job yang sedang berjalan bila GitHub menyediakannya
 * - Job gagal -> otomatis kirim ringkasan error + log terakhir
 * - Cancel run, re-run (semua / hanya yang gagal), log per job (.txt), log lengkap (.zip)
 * - Aktifkan / nonaktifkan workflow
 *
 * Semua handler di sini non-blocking: pemantauan berjalan di background, jadi bot tetap
 * merespon perintah lain selama run dipantau.
 */
const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const { decryptToken } = require("../services/cryptoService");
const { listUserRepos, getRepoDefaultBranch, GitHubServiceError } = require("../services/githubService");
const actions = require("../services/actionsService");
const { esc, bold, code, quote } = require("../utils/formatUtils");
const { safeEditById } = require("../utils/telegramUtils");
const { backToMenuButton, withBackToMenu } = require("../utils/menuUtils");
const { coloredButton } = require("../utils/buttonUtils");
const { cleanLog, tailLines, extractErrors, fitTail } = require("../utils/logUtils");
const { renderRunMessage, runLabel, statusIcon, statusLabel, span } = require("../utils/actionsFormat");

const POLL_MS = 4000;          // jeda polling saat run berjalan
const QUEUED_POLL_MS = 6000;   // jeda polling saat masih antre
const MAX_WATCH_MS = 45 * 60 * 1000; // batas satu sesi pantau (tekan "Pantau" untuk lanjut)
const LIVE_LOG_EVERY = 2;      // ambil log live tiap N kali polling (hemat kuota API)
const MAX_FAILED_POLLS = 5;
const MAX_WATCHERS_PER_CHAT = 3;
const TG_DOC_LIMIT = 49 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----- State in-memory (hilang saat bot restart; user tinggal /actions lagi) -----
const chatState = new Map();          // chatId -> { repos: [fullName], repo }
const pendingActionInput = new Map(); // chatId -> { repo, workflowId, name } (menunggu input workflow)
const watchers = new Map();           // `${chatId}:${runId}` -> state watcher
const runRepo = new Map();            // `${chatId}:${runId}` -> fullName
const jobInfo = new Map();            // `${chatId}:${jobId}` -> { repo, name }
const dispatching = new Set();        // cegah double-klik "Jalankan"

function k(chatId, id) { return `${chatId}:${id}`; }

function getToken(chatId) {
  return decryptToken(dbService.getUserToken(chatId));
}

function kb(rows) { return Markup.inlineKeyboard(rows); }

const HTML = { parse_mode: "HTML", disable_web_page_preview: true };

// ---------- Keyboard ----------

function runningKeyboard(run) {
  return kb([
    [
      coloredButton("🛑 Cancel run", `act:cancel:${run.id}`, "danger"),
      Markup.button.callback("⏹ Stop pantau", `act:stop:${run.id}`),
    ],
    [Markup.button.url("🔗 Buka di GitHub", run.url)],
  ]);
}

function finishedKeyboard(run, jobs) {
  const rows = [];
  const first = [Markup.button.callback("🔄 Re-run semua", `act:rerun:${run.id}`)];
  if (run.conclusion === "failure" || run.conclusion === "timed_out") {
    first.push(Markup.button.callback("🔁 Re-run yang gagal", `act:rerunf:${run.id}`));
  }
  rows.push(first);

  // Tombol log per job (maks 6, 2 per baris)
  const jobButtons = (jobs || []).slice(0, 6).map((j) =>
    Markup.button.callback(`📄 ${j.name}`.slice(0, 28), `act:jlog:${j.id}`)
  );
  for (let i = 0; i < jobButtons.length; i += 2) rows.push(jobButtons.slice(i, i + 2));

  rows.push([
    Markup.button.callback("📥 Semua log (.zip)", `act:zip:${run.id}`),
    Markup.button.url("🔗 GitHub", run.url),
  ]);
  rows.push([Markup.button.callback("⬅️ Kembali", "act:refresh")]);
  return kb(rows);
}

function watchAgainKeyboard(run) {
  return kb([
    [Markup.button.callback("👁 Pantau lagi", `act:watch:${run.id}`)],
    [Markup.button.url("🔗 Buka di GitHub", run.url)],
  ]);
}

// ---------- Pemantauan real-time ----------

/**
 * Pantau satu run sampai selesai: edit pesan `messageId` berkala dengan status terbaru.
 * Berjalan "di background" (dipanggil tanpa await dari handler yang ingin langsung selesai,
 * atau di-await — keduanya aman karena update Telegram diproses terpisah).
 */
async function watchRun(ctx, fullName, runId, messageId) {
  const chatId = ctx.chat.id;
  const key = k(chatId, runId);

  // Batasi jumlah pemantau aktif per chat (hemat kuota API GitHub)
  const activeForChat = [...watchers.keys()].filter((x) => x.startsWith(`${chatId}:`)).length;
  if (!watchers.has(key) && activeForChat >= MAX_WATCHERS_PER_CHAT) {
    await safeEditById(
      ctx, chatId, messageId,
      `⚠️ Sudah ada ${MAX_WATCHERS_PER_CHAT} run yang sedang dipantau. Tekan ⏹ Stop pantau di salah satunya dulu.`,
      { ...HTML, ...backToMenuButton() }
    );
    return;
  }

  // Watcher baru menggantikan yang lama untuk run yang sama (mis. setelah re-run)
  const state = { stopped: false };
  watchers.set(key, state);
  runRepo.set(key, fullName);

  const token = getToken(String(chatId));
  const isCurrent = () => watchers.get(key) === state && !state.stopped;

  const startedAt = Date.now();
  let lastText = "";
  let failedPolls = 0;
  let polls = 0;
  let liveTail = null;
  let logHits = 0;
  let logMisses = 0;
  let sawUnfinished = false;
  let firstPoll = true;
  const skipAutoReport = new Set(); // job yang sudah selesai saat pemantauan dimulai
  const reported = new Set();
  let finalRun = null;
  let finalJobs = null;
  let timedOut = false;

  try {
    while (isCurrent()) {
      if (Date.now() - startedAt > MAX_WATCH_MS) { timedOut = true; break; }

      let run, jobs;
      try {
        [run, jobs] = await Promise.all([
          actions.getRun(token, fullName, runId),
          actions.getJobs(token, fullName, runId),
        ]);
        failedPolls = 0;
      } catch (err) {
        failedPolls++;
        if (failedPolls >= MAX_FAILED_POLLS) {
          const msg = err instanceof GitHubServiceError ? err.message : "koneksi bermasalah";
          await safeEditById(ctx, chatId, messageId, `❌ Pemantauan berhenti: ${esc(msg)}`, { ...HTML, ...backToMenuButton() });
          return;
        }
        await sleep(5000);
        continue;
      }
      if (!isCurrent()) break; // dihentikan / digantikan watcher baru saat menunggu API
      polls++;
      finalRun = run;
      finalJobs = jobs;
      jobs.forEach((j) => jobInfo.set(k(chatId, j.id), { repo: fullName, name: j.name }));

      if (firstPoll) {
        jobs.filter((j) => j.status === "completed").forEach((j) => skipAutoReport.add(j.id));
        firstPoll = false;
      }
      if (run.status !== "completed") sawUnfinished = true;

      // Job yang gagal SELAMA dipantau -> kirim ringkasan error otomatis
      for (const job of jobs) {
        if (job.status === "completed" && job.conclusion === "failure" && !reported.has(job.id) && !skipAutoReport.has(job.id)) {
          reported.add(job.id);
          sendFailureExcerpt(ctx, token, fullName, job).catch((e) => console.error("excerpt:", e?.message || e));
        }
      }

      // Console live (best effort): GitHub tidak selalu menyediakan log job yang masih berjalan
      const running = jobs.find((j) => j.status === "in_progress");
      let note;
      if (running && run.status !== "completed") {
        if (polls % LIVE_LOG_EVERY === 0 && !(logHits === 0 && logMisses >= 3)) {
          try {
            const raw = await actions.getJobLog(token, fullName, running.id);
            if (raw) { logHits++; liveTail = tailLines(cleanLog(raw), 12, 80); }
            else { logMisses++; }
          } catch (_) { logMisses++; }
        }
        if (!liveTail && logHits === 0 && logMisses >= 3) {
          note = "ℹ️ GitHub baru menyediakan log tiap job setelah job itu selesai. Progres step tetap tampil real-time di atas.";
        }
      } else {
        liveTail = null;
      }

      const done = run.status === "completed";
      const text = renderRunMessage({ fullName, run, jobs, logTail: done ? null : liveTail, note });
      if (text !== lastText) {
        lastText = text;
        await safeEditById(ctx, chatId, messageId, text, {
          ...HTML,
          ...(done ? finishedKeyboard(run, jobs) : runningKeyboard(run)),
        });
      }

      if (done) break;
      await sleep(run.status === "in_progress" ? POLL_MS : QUEUED_POLL_MS);
    }

    if (timedOut && finalRun && isCurrent()) {
      await safeEditById(
        ctx, chatId, messageId,
        renderRunMessage({
          fullName, run: finalRun, jobs: finalJobs,
          note: "⏱ Pemantauan otomatis berhenti (batas 45 menit). Tekan 👁 Pantau lagi untuk lanjut.",
        }),
        { ...HTML, ...watchAgainKeyboard(finalRun) }
      );
      return;
    }

    // Notifikasi selesai sebagai pesan BARU (edit pesan tidak memunculkan notifikasi di HP)
    if (isCurrent() && finalRun && finalRun.status === "completed" && sawUnfinished) {
      const dur = span(finalRun.startedAt, finalRun.updatedAt);
      await ctx.telegram.sendMessage(
        chatId,
        `${statusIcon("completed", finalRun.conclusion)} ${bold(esc(finalRun.name))} ${code("#" + finalRun.number)} selesai: ` +
          `${bold(esc(statusLabel("completed", finalRun.conclusion)))}${dur ? ` (⏱ ${dur})` : ""}`,
        HTML
      ).catch(() => {});
    }
  } finally {
    if (watchers.get(key) === state) watchers.delete(key);
  }
}

/** Kirim ringkasan error + log terakhir untuk job yang gagal. */
async function sendFailureExcerpt(ctx, token, fullName, job) {
  const chatId = ctx.chat.id;
  const raw = await actions.getJobLog(token, fullName, job.id);
  if (!raw) return;
  const lines = cleanLog(raw);
  const errs = extractErrors(lines);
  const tail = tailLines(lines, 20, 90);
  const failedStep = job.steps.find((s) => s.conclusion === "failure");

  let text = `❌ ${bold("Job gagal:")} ${esc(job.name)}`;
  if (failedStep) text += `\nStep: ${esc(failedStep.name)}`;
  if (errs.length) text += `\n\n${bold("Error:")}\n<pre>${esc(errs.join("\n"))}</pre>`;
  text += `\n\n${bold("Log terakhir:")}\n<pre>${esc(fitTail(tail.join("\n"), 2000))}</pre>`;

  await ctx.telegram.sendMessage(chatId, text, {
    ...HTML,
    ...kb([[Markup.button.callback("📄 Log lengkap job ini", `act:jlog:${job.id}`)]]),
  });
}

// ---------- Register ----------

function registerActionsHandlers(bot) {
  const NOT_REGISTERED = "Kamu belum menghubungkan akun GitHub. Gunakan /settoken TOKEN_KAMU dulu ya.";

  /**
   * Bungkus handler navigasi: tangani GitHubServiceError dengan pesan ramah (menggantikan
   * isi pesan menu, lengkap dengan tombol kembali).
   */
  function safe(handler, { replyOnError = false } = {}) {
    return async (ctx, ...rest) => {
      if (!dbService.isUserRegistered(String(ctx.chat.id))) {
        if (ctx.callbackQuery) { try { await ctx.answerCbQuery(); } catch (_) {} }
        await ctx.reply(NOT_REGISTERED);
        return;
      }
      try {
        return await handler(ctx, ...rest);
      } catch (err) {
        if (err instanceof GitHubServiceError) {
          const text = `❌ ${esc(err.message)}`;
          // replyOnError: untuk aksi di pesan monitor (cancel/re-run/log) -> kirim pesan BARU
          // supaya tampilan monitor tidak tertimpa pesan error.
          if (ctx.callbackQuery && !replyOnError) {
            await ctx.editMessageText(text, { ...HTML, ...kb([[Markup.button.callback("⬅️ Kembali", "act:refresh")], [Markup.button.callback("⬅️ Menu", "menu:home")]]) }).catch(() => {});
          } else {
            await ctx.reply(text, HTML).catch(() => {});
          }
          return;
        }
        throw err;
      }
    };
  }

  function requireRegistered(ctx) {
    return dbService.isUserRegistered(String(ctx.chat.id));
  }

  function repoOf(ctx, id, map = runRepo) {
    const chatId = ctx.chat.id;
    return (id != null && map.get(k(chatId, id))) || chatState.get(String(chatId))?.repo || null;
  }

  async function sessionExpired(ctx) {
    await ctx.editMessageText("Sesi Actions sudah habis (bot sempat restart). Ketik /actions untuk mulai lagi.", backToMenuButton());
  }

  // ----- Daftar repo -----
  async function showRepoList(ctx, respond) {
    const chatId = String(ctx.chat.id);
    if (!requireRegistered(ctx)) {
      await respond(NOT_REGISTERED, backToMenuButton());
      return;
    }
    const token = getToken(chatId);
    const repos = await listUserRepos(token, 30);
    if (repos.length === 0) {
      await respond("Kamu belum punya repo.", backToMenuButton());
      return;
    }
    chatState.set(chatId, { ...(chatState.get(chatId) || {}), repos: repos.map((r) => r.fullName) });
    const buttons = repos.map((r, i) => [
      Markup.button.callback(`${r.private ? "🔒" : "🌐"} ${r.name}`, `act:repo:${i}`),
    ]);
    await respond("⚙️ Pilih repo untuk kelola GitHub Actions:", withBackToMenu(buttons));
  }

  bot.command("actions", safe(async (ctx) => {
    await showRepoList(ctx, (text, extra) => ctx.reply(text, extra));
  }));

  bot.action("menu:actions", safe(async (ctx) => {
    await ctx.answerCbQuery();
    await showRepoList(ctx, (text, extra) => ctx.editMessageText(text, extra));
  }));

  bot.action("act:list", safe(async (ctx) => {
    await ctx.answerCbQuery();
    await showRepoList(ctx, (text, extra) => ctx.editMessageText(text, extra));
  }));

  // ----- Daftar workflow -----
  async function showWorkflows(ctx, fullName) {
    const chatId = String(ctx.chat.id);
    const token = getToken(chatId);
    const workflows = await actions.listWorkflows(token, fullName);

    const rows = workflows.slice(0, 20).map((w) => [
      Markup.button.callback(`${w.state === "active" ? "▶️" : "⏸"} ${w.name}`.slice(0, 40), `act:wf:${w.id}`),
    ]);
    rows.push([
      Markup.button.callback("📜 Run terbaru", "act:runs:0"),
      Markup.button.callback("🔄 Refresh", "act:refresh"),
    ]);
    rows.push([Markup.button.callback("⬅️ Ganti repo", "act:list")]);

    const head = workflows.length
      ? `⚙️ ${bold("GitHub Actions")} — ${bold(esc(fullName))}\n\nPilih workflow untuk dijalankan:`
      : `⚙️ ${bold(esc(fullName))}\n\nRepo ini belum punya workflow (file <code>.github/workflows/*.yml</code>). Kamu tetap bisa lihat run terbaru.`;
    await ctx.editMessageText(head, { ...HTML, ...withBackToMenu(rows) });
  }

  bot.action(/^act:repo:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const st = chatState.get(chatId);
    const fullName = st?.repos?.[Number(ctx.match[1])];
    if (!fullName) return sessionExpired(ctx);
    chatState.set(chatId, { ...st, repo: fullName });
    await showWorkflows(ctx, fullName);
  }));

  bot.action("act:refresh", safe(async (ctx) => {
    await ctx.answerCbQuery();
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    await showWorkflows(ctx, fullName);
  }));

  // ----- Layar 1 workflow -----
  async function showWorkflowScreen(ctx, workflowId) {
    const chatId = String(ctx.chat.id);
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    const wf = await actions.getWorkflow(getToken(chatId), fullName, workflowId);
    const active = wf.state === "active";
    const text =
      quote(`⚙️ ${bold(esc(wf.name))}\n📄 ${code(wf.path)}\nStatus: ${active ? "✅ aktif" : "⏸ nonaktif"}`) +
      `\n\nPilih aksi:`;
    const rows = [];
    if (active) {
      rows.push([coloredButton("▶️ Jalankan", `act:go:${wf.id}`, "success")]);
      rows.push([Markup.button.callback("⚙️ Jalankan dengan input/branch", `act:goin:${wf.id}`)]);
    }
    rows.push([Markup.button.callback("📜 Run workflow ini", `act:runs:${wf.id}`)]);
    rows.push([Markup.button.callback(active ? "⏸ Nonaktifkan" : "✅ Aktifkan", `act:tog:${wf.id}`)]);
    rows.push([Markup.button.callback("⬅️ Kembali", "act:refresh")]);
    await ctx.editMessageText(text, { ...HTML, ...kb(rows) });
  }

  bot.action(/^act:wf:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    await showWorkflowScreen(ctx, Number(ctx.match[1]));
  }));

  bot.action(/^act:tog:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    const id = Number(ctx.match[1]);
    const token = getToken(chatId);
    const wf = await actions.getWorkflow(token, fullName, id);
    await actions.setWorkflowEnabled(token, fullName, id, wf.state !== "active");
    await showWorkflowScreen(ctx, id);
  }));

  // ----- Daftar run -----
  bot.action(/^act:runs:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    const workflowId = Number(ctx.match[1]) || undefined;
    const runs = await actions.listRuns(getToken(chatId), fullName, { workflowId, perPage: 8 });

    if (runs.length === 0) {
      await ctx.editMessageText("Belum ada run.", { ...kb([[Markup.button.callback("⬅️ Kembali", "act:refresh")]]) });
      return;
    }
    runs.forEach((r) => runRepo.set(k(chatId, r.id), fullName));
    const rows = runs.map((r) => [Markup.button.callback(runLabel(r), `act:run:${r.id}`)]);
    rows.push([Markup.button.callback("⬅️ Kembali", "act:refresh")]);
    await ctx.editMessageText(
      `📜 ${bold("Run terbaru")} — ${bold(esc(fullName))}\nPilih run untuk melihat status / memantau:`,
      { ...HTML, ...kb(rows) }
    );
  }));

  bot.action(/^act:run:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    const fullName = repoOf(ctx, ctx.match[1]);
    if (!fullName) return sessionExpired(ctx);
    await watchRun(ctx, fullName, Number(ctx.match[1]), ctx.callbackQuery.message.message_id);
  }));

  bot.action(/^act:watch:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery("👁 Memantau...");
    const fullName = repoOf(ctx, ctx.match[1]);
    if (!fullName) return sessionExpired(ctx);
    await watchRun(ctx, fullName, Number(ctx.match[1]), ctx.callbackQuery.message.message_id);
  }, { replyOnError: true }));

  bot.action(/^act:stop:(\d+)$/, safe(async (ctx) => {
    const runId = Number(ctx.match[1]);
    const key = k(ctx.chat.id, runId);
    watchers.delete(key); // loop watcher melihat ia sudah tidak "current" dan berhenti
    await ctx.answerCbQuery("Pemantauan dihentikan.");
    const fullName = repoOf(ctx, runId);
    if (!fullName) return;
    const token = getToken(String(ctx.chat.id));
    const [run, jobs] = await Promise.all([actions.getRun(token, fullName, runId), actions.getJobs(token, fullName, runId)]);
    await ctx.editMessageText(
      renderRunMessage({ fullName, run, jobs, note: "⏹ Pemantauan dihentikan." }),
      { ...HTML, ...(run.status === "completed" ? finishedKeyboard(run, jobs) : watchAgainKeyboard(run)) }
    );
  }, { replyOnError: true }));

  // ----- Jalankan workflow -----
  async function doDispatch(ctx, messageId, { repo, workflowId, name }, ref, inputs) {
    const chatId = ctx.chat.id;
    const lockKey = k(chatId, workflowId);
    if (dispatching.has(lockKey)) return;
    dispatching.add(lockKey);
    try {
      const token = getToken(String(chatId));
      const branch = ref || (await getRepoDefaultBranch(token, repo));
      const inputInfo = Object.keys(inputs).length
        ? `\n${Object.entries(inputs).map(([a, b]) => `• ${esc(a)} = ${esc(b)}`).join("\n")}`
        : "";
      await safeEditById(ctx, chatId, messageId,
        `🚀 Menjalankan ${bold(esc(name))} di branch ${code(branch)}...${inputInfo}`, HTML);

      let run;
      try {
        run = await actions.dispatchAndFindRun(token, repo, workflowId, branch, inputs);
        dispatching.delete(lockKey); // run sudah ketemu: boleh dispatch lagi sambil memantau
      } catch (err) {
        if (err instanceof GitHubServiceError) {
          await safeEditById(ctx, chatId, messageId, `❌ ${esc(err.message)}`, {
            ...HTML, ...kb([[Markup.button.callback("⬅️ Kembali", "act:refresh")]]),
          });
          return;
        }
        throw err;
      }

      if (!run) {
        await safeEditById(ctx, chatId, messageId,
          "✅ Permintaan dikirim ke GitHub, tapi run-nya belum muncul. Cek lewat 📜 Run terbaru.", {
            ...HTML, ...kb([[Markup.button.callback("📜 Run terbaru", `act:runs:${workflowId}`)]]),
          });
        return;
      }
      runRepo.set(k(chatId, run.id), repo);
      await watchRun(ctx, repo, run.id, messageId);
    } finally {
      dispatching.delete(lockKey);
    }
  }

  async function workflowNameOf(ctx, fullName, workflowId) {
    const wf = await actions.getWorkflow(getToken(String(ctx.chat.id)), fullName, workflowId);
    return wf.name;
  }

  bot.action(/^act:go:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery("🚀");
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    const workflowId = Number(ctx.match[1]);
    const name = await workflowNameOf(ctx, fullName, workflowId);
    await doDispatch(ctx, ctx.callbackQuery.message.message_id, { repo: fullName, workflowId, name }, null, {});
  }));

  bot.action(/^act:goin:(\d+)$/, safe(async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = String(ctx.chat.id);
    const fullName = repoOf(ctx);
    if (!fullName) return sessionExpired(ctx);
    const workflowId = Number(ctx.match[1]);
    const name = await workflowNameOf(ctx, fullName, workflowId);
    pendingActionInput.set(chatId, { repo: fullName, workflowId, name, at: Date.now() });
    await ctx.editMessageText(
      `⚙️ ${bold(esc(name))}\n\n` +
        quote(
          "Kirim input dalam format <code>nama=nilai</code>, satu per baris.\n" +
          "Untuk pilih branch: <code>ref=nama-branch</code>\n\n" +
          "Contoh:\n<code>ref=dev\nenvironment=staging\ndebug=true</code>\n\n" +
          "Ketik <code>-</code> kalau tanpa input. /cancel untuk batal."
        ),
      HTML
    );
  }));

  // Input teks untuk "Jalankan dengan input"
  bot.on("text", async (ctx, next) => {
    const chatId = String(ctx.chat.id);
    const pending = pendingActionInput.get(chatId);
    if (!pending) return next();
    if (Date.now() - pending.at > 10 * 60 * 1000) { // kedaluwarsa 10 menit
      pendingActionInput.delete(chatId);
      return next();
    }
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next(); // biarkan command (mis. /cancel) diproses normal

    const inputs = {};
    let ref = null;
    if (text !== "-") {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const idx = line.indexOf("=");
        if (idx < 1) {
          await ctx.replyWithHTML(`Format salah di baris: ${code(line)}\nGunakan <code>nama=nilai</code>, atau <code>-</code> untuk tanpa input.`);
          return; // tetap menunggu input yang benar
        }
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === "ref") ref = value;
        else inputs[key] = value;
      }
    }

    pendingActionInput.delete(chatId);
    const status = await ctx.reply("🚀 Memulai...");
    try {
      await doDispatch(ctx, status.message_id, pending, ref, inputs);
    } catch (err) {
      if (err instanceof GitHubServiceError) {
        await safeEditById(ctx, ctx.chat.id, status.message_id, `❌ ${esc(err.message)}`, HTML);
        return;
      }
      throw err;
    }
  });

  // ----- Cancel / re-run -----
  bot.action(/^act:cancel:(\d+)$/, safe(async (ctx) => {
    const runId = Number(ctx.match[1]);
    const fullName = repoOf(ctx, runId);
    if (!fullName) { await ctx.answerCbQuery(); return sessionExpired(ctx); }
    await actions.cancelRun(getToken(String(ctx.chat.id)), fullName, runId);
    await ctx.answerCbQuery("🛑 Permintaan cancel dikirim.");
    // Watcher yang masih jalan akan menampilkan status "Dibatalkan" pada polling berikutnya.
  }, { replyOnError: true }));

  async function handleRerun(ctx, failedOnly) {
    const runId = Number(ctx.match[1]);
    const fullName = repoOf(ctx, runId);
    if (!fullName) { await ctx.answerCbQuery(); return sessionExpired(ctx); }
    await actions.rerun(getToken(String(ctx.chat.id)), fullName, runId, { failedOnly });
    await ctx.answerCbQuery("🔄 Run diulang.");
    await sleep(2500); // beri waktu GitHub mereset status run
    await watchRun(ctx, fullName, runId, ctx.callbackQuery.message.message_id);
  }
  bot.action(/^act:rerun:(\d+)$/, safe((ctx) => handleRerun(ctx, false), { replyOnError: true }));
  bot.action(/^act:rerunf:(\d+)$/, safe((ctx) => handleRerun(ctx, true), { replyOnError: true }));

  // ----- Log -----
  bot.action(/^act:jlog:(\d+)$/, safe(async (ctx) => {
    const jobId = Number(ctx.match[1]);
    const info = jobInfo.get(k(ctx.chat.id, jobId));
    const fullName = info?.repo || repoOf(ctx);
    if (!fullName) { await ctx.answerCbQuery(); return sessionExpired(ctx); }
    await ctx.answerCbQuery("📄 Mengambil log...");
    const raw = await actions.getJobLog(getToken(String(ctx.chat.id)), fullName, jobId);
    if (!raw) {
      await ctx.reply("Log job ini belum tersedia (job belum selesai). Coba lagi nanti.");
      return;
    }
    const buf = Buffer.from(cleanLog(raw).join("\n"), "utf8");
    if (buf.length > TG_DOC_LIMIT) {
      await ctx.reply("Log terlalu besar untuk dikirim lewat Telegram. Buka langsung di GitHub.");
      return;
    }
    const safeName = (info?.name || `job-${jobId}`).replace(/[^\w.-]+/g, "_");
    await ctx.replyWithDocument({ source: buf, filename: `${safeName}.log.txt` }, { caption: `📄 Log: ${info?.name || jobId}` });
  }, { replyOnError: true }));

  bot.action(/^act:zip:(\d+)$/, safe(async (ctx) => {
    const runId = Number(ctx.match[1]);
    const fullName = repoOf(ctx, runId);
    if (!fullName) { await ctx.answerCbQuery(); return sessionExpired(ctx); }
    await ctx.answerCbQuery("📥 Mengunduh log...");
    const zip = await actions.downloadRunLogsZip(getToken(String(ctx.chat.id)), fullName, runId);
    if (zip.length > TG_DOC_LIMIT) {
      await ctx.reply("Zip log terlalu besar untuk Telegram (>49MB). Unduh langsung dari GitHub.");
      return;
    }
    await ctx.replyWithDocument({ source: zip, filename: `run-${runId}-logs.zip` }, { caption: `📥 Semua log run #${runId}` });
  }, { replyOnError: true }));
}

module.exports = { registerActionsHandlers, pendingActionInput };

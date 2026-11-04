/**
 * Render tampilan GitHub Actions untuk pesan Telegram (HTML). Fungsi murni (tanpa I/O)
 * supaya mudah dites. Pesan dijaga ringkas agar muat di layar HP dan batas 4096 karakter.
 */
const { esc, bold, code } = require("./formatUtils");

const TELEGRAM_LIMIT = 3900; // sisakan ruang dari batas 4096

function statusIcon(status, conclusion) {
  if (status === "completed") {
    switch (conclusion) {
      case "success": return "✅";
      case "failure": return "❌";
      case "cancelled": return "🚫";
      case "skipped": return "⏭";
      case "timed_out": return "⌛";
      case "action_required": return "🔐";
      case "neutral": return "➖";
      case "startup_failure": return "💥";
      default: return "❔";
    }
  }
  if (status === "in_progress") return "⏳";
  if (status === "queued" || status === "waiting" || status === "pending" || status === "requested") return "🕓";
  return "❔";
}

function statusLabel(status, conclusion) {
  if (status === "completed") {
    const map = {
      success: "Berhasil", failure: "Gagal", cancelled: "Dibatalkan", skipped: "Dilewati",
      timed_out: "Timeout", action_required: "Butuh aksi", neutral: "Netral", startup_failure: "Gagal start",
    };
    return map[conclusion] || conclusion || "Selesai";
  }
  const map = { in_progress: "Berjalan", queued: "Antre", waiting: "Menunggu", pending: "Pending", requested: "Diminta" };
  return map[status] || status;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0d";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}j ${m}m`;
  if (m > 0) return `${m}m ${sec}d`;
  return `${sec}d`;
}

function span(startedAt, completedAt, now = Date.now()) {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  return formatDuration(end - start);
}

/**
 * Pesan status run: header + daftar job (+ step untuk job yang sedang berjalan/gagal)
 * + potongan log terbaru (kalau ada).
 * @param {object} p { fullName, run, jobs, logTail?: string[], now?: number, note?: string }
 */
function renderRunMessage({ fullName, run, jobs, logTail, now = Date.now(), note }) {
  const icon = statusIcon(run.status, run.conclusion);
  const elapsed = span(run.startedAt, run.status === "completed" ? run.updatedAt : null, now);

  const lines = [];
  lines.push(`${icon} ${bold(esc(run.name))} ${code("#" + run.number)}${run.attempt > 1 ? ` (percobaan ${run.attempt})` : ""}`);
  if (run.title && run.title !== run.name) lines.push(esc(run.title));
  lines.push(`📦 ${esc(fullName)} • 🌿 ${esc(run.branch || "-")} • ${esc(run.event)}${run.sha ? " • " + code(run.sha) : ""}`);
  lines.push(`Status: ${bold(esc(statusLabel(run.status, run.conclusion)))}${elapsed ? ` • ⏱ ${elapsed}` : ""}`);

  if (jobs && jobs.length) {
    lines.push("");
    for (const job of jobs) {
      const jIcon = statusIcon(job.status, job.conclusion);
      const jDur = span(job.startedAt, job.completedAt, now);
      lines.push(`${jIcon} ${bold(esc(job.name))}${jDur ? ` (${jDur})` : ""}`);

      // Detail step hanya untuk job yang sedang jalan atau gagal (hemat ruang)
      const showSteps = job.status === "in_progress" || (job.status === "completed" && job.conclusion === "failure");
      if (showSteps && job.steps.length) {
        for (const st of job.steps) {
          // Tampilkan step: yang berjalan, gagal, atau 2 step selesai terakhir sebelum yang berjalan
          const sIcon = statusIcon(st.status, st.conclusion);
          const sDur = span(st.startedAt, st.completedAt, now);
          lines.push(`   ${sIcon} ${esc(st.name)}${sDur && st.status !== "queued" && st.status !== "pending" ? ` (${sDur})` : ""}`);
        }
      }
    }
  } else if (run.status !== "completed") {
    lines.push("");
    lines.push("🕓 Menunggu runner...");
  }

  if (note) {
    lines.push("");
    lines.push(note);
  }

  let msg = lines.join("\n");

  if (logTail && logTail.length) {
    const pre = `\n\n📟 <b>Console</b>\n<pre>${esc(logTail.join("\n"))}</pre>`;
    if (msg.length + pre.length <= TELEGRAM_LIMIT) {
      msg += pre;
    } else {
      // Pangkas log dari atas agar tetap muat
      const room = TELEGRAM_LIMIT - msg.length - 40;
      if (room > 200) {
        let text = logTail.join("\n");
        text = text.slice(Math.max(0, text.length - room));
        msg += `\n\n📟 <b>Console</b>\n<pre>${esc(text)}</pre>`;
      }
    }
  }

  // Jaring pengaman terakhir: kalau daftar step terlalu panjang, pangkas daftar (bukan HTML tengah-tengah)
  if (msg.length > 4000) {
    const cut = lines.slice(0, 40).join("\n");
    msg = cut.length > 4000 ? cut.slice(0, 3990) + "…" : cut + "\n…";
  }
  return msg;
}

/** Satu baris ringkas untuk daftar run. */
function runLabel(run) {
  return `${statusIcon(run.status, run.conclusion)} #${run.number} ${run.name} · ${run.branch || "-"}`.slice(0, 60);
}

module.exports = { statusIcon, statusLabel, formatDuration, span, renderRunMessage, runLabel };

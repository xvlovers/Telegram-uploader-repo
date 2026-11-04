/**
 * Operasi GitHub Actions (workflow): list, jalankan (workflow_dispatch), pantau run & job,
 * ambil log, cancel, re-run. Semua lewat Octokit yang sama dengan githubService
 * (sudah ada retry jaringan + throttling).
 *
 * Catatan scope token:
 * - Classic token: scope "repo" cukup untuk list/jalankan/cancel/re-run/log.
 *   Scope "workflow" hanya perlu kalau mau PUSH file di .github/workflows/.
 * - Fine-grained token: butuh permission "Actions: Read and write".
 */
const {
  getClient,
  GitHubServiceError,
  isRateLimitError,
  describeRateLimitError,
} = require("./githubService");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function split(fullName) {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

/** Ubah error Octokit jadi GitHubServiceError dengan pesan yang membantu. */
function toActionsError(err, label) {
  if (err instanceof GitHubServiceError) return err;
  if (isRateLimitError(err)) return new GitHubServiceError(describeRateLimitError(err));
  if (err.status === 401) {
    return new GitHubServiceError("Token GitHub ditolak (tidak valid / expired). Pasang ulang dengan /settoken.");
  }
  if (err.status === 403) {
    return new GitHubServiceError(
      `Akses ditolak saat ${label}. Pastikan token punya scope "repo" (fine-grained: "Actions: Read and write").`
    );
  }
  if (err.status === 404) {
    return new GitHubServiceError(`Tidak ditemukan saat ${label} (repo/workflow/run tidak ada, atau token tidak punya akses).`);
  }
  if (err.status === 409) {
    return new GitHubServiceError(`Konflik saat ${label}: ${err.message}`);
  }
  if (err.status === 422) {
    return new GitHubServiceError(`Permintaan ditolak GitHub saat ${label}: ${err.message}`);
  }
  return new GitHubServiceError(`Gagal ${label}: ${err.message}`);
}

async function guard(label, fn) {
  try {
    return await fn();
  } catch (err) {
    throw toActionsError(err, label);
  }
}

// ---------- Workflow ----------

async function listWorkflows(token, fullName) {
  return guard("mengambil daftar workflow", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const { data } = await octokit.actions.listRepoWorkflows({ owner, repo, per_page: 50 });
    return data.workflows.map((w) => ({
      id: w.id, name: w.name, path: w.path, state: w.state,
    }));
  });
}

async function getWorkflow(token, fullName, workflowId) {
  return guard("membaca workflow", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const { data } = await octokit.actions.getWorkflow({ owner, repo, workflow_id: workflowId });
    return { id: data.id, name: data.name, path: data.path, state: data.state };
  });
}

async function setWorkflowEnabled(token, fullName, workflowId, enabled) {
  return guard(enabled ? "mengaktifkan workflow" : "menonaktifkan workflow", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    if (enabled) await octokit.actions.enableWorkflow({ owner, repo, workflow_id: workflowId });
    else await octokit.actions.disableWorkflow({ owner, repo, workflow_id: workflowId });
  });
}

// ---------- Runs ----------

function mapRun(r) {
  return {
    id: r.id,
    name: r.name || r.display_title || "workflow",
    title: r.display_title || r.name || "",
    number: r.run_number,
    attempt: r.run_attempt || 1,
    status: r.status,           // queued | in_progress | completed | waiting | requested | pending
    conclusion: r.conclusion,   // success | failure | cancelled | skipped | timed_out | ... | null
    branch: r.head_branch,
    event: r.event,
    sha: (r.head_sha || "").slice(0, 7),
    actor: r.actor?.login || r.triggering_actor?.login || "",
    url: r.html_url,
    createdAt: r.created_at,
    startedAt: r.run_started_at || r.created_at,
    updatedAt: r.updated_at,
    workflowId: r.workflow_id,
  };
}

async function listRuns(token, fullName, { workflowId, perPage = 8 } = {}) {
  return guard("mengambil daftar run", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const { data } = workflowId
      ? await octokit.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, per_page: perPage })
      : await octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: perPage });
    return data.workflow_runs.map(mapRun);
  });
}

async function getRun(token, fullName, runId) {
  return guard("membaca status run", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const { data } = await octokit.actions.getWorkflowRun({ owner, repo, run_id: runId });
    return mapRun(data);
  });
}

async function getJobs(token, fullName, runId) {
  return guard("membaca job", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const { data } = await octokit.actions.listJobsForWorkflowRun({
      owner, repo, run_id: runId, filter: "latest", per_page: 100,
    });
    return data.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      runnerName: j.runner_name,
      steps: (j.steps || []).map((s) => ({
        number: s.number, name: s.name, status: s.status, conclusion: s.conclusion,
        startedAt: s.started_at, completedAt: s.completed_at,
      })),
    }));
  });
}

/**
 * Jalankan workflow lewat workflow_dispatch, lalu cari run barunya.
 * GitHub tidak mengembalikan id run saat dispatch, jadi: catat id run yang sudah ada,
 * dispatch, lalu polling sampai muncul run workflow_dispatch baru yang id-nya belum ada.
 * Return: run (mapRun) atau null kalau belum muncul dalam batas waktu.
 */
async function dispatchAndFindRun(token, fullName, workflowId, ref, inputs = {}, { timeoutMs = 60000 } = {}) {
  const octokit = getClient(token);
  const { owner, repo } = split(fullName);

  const known = new Set();
  try {
    const before = await listRuns(token, fullName, { workflowId, perPage: 10 });
    before.forEach((r) => known.add(r.id));
  } catch (_) { /* tidak fatal */ }

  await guard("menjalankan workflow", async () => {
    try {
      await octokit.actions.createWorkflowDispatch({
        owner, repo, workflow_id: workflowId, ref,
        ...(Object.keys(inputs).length ? { inputs } : {}),
      });
    } catch (err) {
      if (err.status === 422 && /workflow_dispatch/i.test(String(err.message))) {
        throw new GitHubServiceError(
          'Workflow ini tidak punya trigger "workflow_dispatch", jadi tidak bisa dijalankan manual. ' +
          "Tambahkan `on: workflow_dispatch:` di file workflow-nya."
        );
      }
      if (err.status === 404) {
        throw new GitHubServiceError(
          `Workflow tidak ditemukan di branch "${ref}" (file workflow harus ada di branch itu).`
        );
      }
      throw err;
    }
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    let runs;
    try {
      runs = await listRuns(token, fullName, { workflowId, perPage: 10 });
    } catch (_) { continue; }
    const fresh = runs.find((r) => !known.has(r.id) && r.event === "workflow_dispatch");
    if (fresh) return fresh;
  }
  return null;
}

async function cancelRun(token, fullName, runId) {
  return guard("membatalkan run", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    await octokit.actions.cancelWorkflowRun({ owner, repo, run_id: runId });
  });
}

async function rerun(token, fullName, runId, { failedOnly = false } = {}) {
  return guard("menjalankan ulang run", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    if (failedOnly) await octokit.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
    else await octokit.actions.reRunWorkflow({ owner, repo, run_id: runId });
  });
}

// ---------- Log ----------

function toText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return Buffer.from(data).toString("utf8");
  return String(data ?? "");
}

/** Log mentah 1 job. Return string, atau null kalau belum tersedia (job masih jalan/antre). */
async function getJobLog(token, fullName, jobId) {
  const octokit = getClient(token);
  const { owner, repo } = split(fullName);
  try {
    const res = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
      owner, repo, job_id: jobId,
    });
    return toText(res.data);
  } catch (err) {
    if (err.status === 404 || err.status === 410 || err.status === 409) return null;
    throw toActionsError(err, "mengambil log job");
  }
}

/** Seluruh log 1 run sebagai zip (Buffer). Hanya tersedia setelah run selesai. */
async function downloadRunLogsZip(token, fullName, runId) {
  return guard("mengunduh log run", async () => {
    const octokit = getClient(token);
    const { owner, repo } = split(fullName);
    const res = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs", {
      owner, repo, run_id: runId,
    });
    return Buffer.from(res.data);
  });
}

module.exports = {
  listWorkflows,
  getWorkflow,
  setWorkflowEnabled,
  listRuns,
  getRun,
  getJobs,
  dispatchAndFindRun,
  cancelRun,
  rerun,
  getJobLog,
  downloadRunLogsZip,
};

/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Semua operasi ke GitHub API dibungkus di sini memakai Octokit,
 * supaya handler Telegram tidak perlu tahu detail API GitHub.
 */
const { Octokit: OctokitCore } = require("@octokit/rest");
const { throttling } = require("@octokit/plugin-throttling");
const { mapWithConcurrencyLimit } = require("../utils/concurrencyUtils");

const Octokit = OctokitCore.plugin(throttling);

// Jumlah createBlob() yang boleh jalan bersamaan saat push banyak file.
// Terlalu tinggi bisa memicu secondary rate limit GitHub; terlalu rendah
// membuat push banyak file lambat (sequential). 6 adalah titik aman yang
// dipraktikkan banyak tool GitHub API lain untuk operasi blob paralel.
const BLOB_UPLOAD_CONCURRENCY = 6;

// Retry otomatis hanya untuk delay pendek (bot chat perlu tetap responsif; kalau GitHub
// minta tunggu lama, lebih baik gagal dengan pesan jelas daripada bikin command Telegram
// terasa "hang" menunggu tanpa kepastian).
const MAX_AUTO_RETRY_SECONDS = 10;
const MAX_RETRY_ATTEMPTS = 2;

// Retry untuk error jaringan sementara (ECONNABORTED, ECONNRESET, timeout, 5xx dari GitHub).
// Ini penyebab error "read ECONNABORTED" saat push ratusan file: satu request putus -> seluruh
// push gagal. Sekarang tiap request di-retry otomatis dengan backoff sebelum dianggap gagal.
const MAX_NETWORK_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 120 * 1000;
// Berapa kali commit diulang kalau updateRef ditolak "not a fast forward" (ref sudah bergeser).
const MAX_REF_ATTEMPTS = 4;

const TRANSIENT_CODES = new Set([
  "ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE",
  "ECONNREFUSED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientError(err) {
  // Error HTTP dari Octokit (RequestError) selalu punya `status` numerik. JANGAN baca `err.code`
  // pada error ini: getter-nya deprecated dan mencetak warning "`error.code` is deprecated"
  // + stack trace panjang di log. Untuk error HTTP cukup lihat status-nya saja.
  if (typeof err?.status === "number") {
    return err.status >= 500 && err.status < 600;
  }

  // Error jaringan murni (tanpa status HTTP): cek kode error di err / cause bertingkat.
  const code = err?.code || err?.cause?.code || err?.cause?.cause?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  const msg = String(err?.message || "");
  return /ECONNABORTED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|terminated|timed out|TimeoutError|AbortError/i.test(msg);
}

class GitHubServiceError extends Error {}

function getClient(token) {
  const octokit = new Octokit({
    auth: token,
    // Sertakan versi API GitHub secara eksplisit di setiap request. Tanpa ini, beberapa
    // endpoint (mis. POST /user/repos) tampil sebagai "deprecated" di log walau sebenarnya
    // masih berfungsi normal — itu cuma peringatan GitHub supaya client selalu versi-aware.
    request: {
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // Timeout per request supaya koneksi yang "menggantung" tidak bikin push macet selamanya.
      fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    },
    throttle: {
      onRateLimit: (retryAfter, options, octokit, retryCount) => {
        if (retryAfter <= MAX_AUTO_RETRY_SECONDS && retryCount < MAX_RETRY_ATTEMPTS) {
          return true; // izinkan retry otomatis untuk delay pendek
        }
        return false; // delay lama -> biarkan gagal, tangani pesannya di layer bawah
      },
      onSecondaryRateLimit: (retryAfter, options, octokit, retryCount) => {
        if (retryAfter <= MAX_AUTO_RETRY_SECONDS && retryCount < MAX_RETRY_ATTEMPTS) {
          return true;
        }
        return false;
      },
    },
  });

  // Retry otomatis (exponential backoff) untuk error jaringan sementara pada SEMUA request.
  octokit.hook.wrap("request", async (request, options) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(options);
      } catch (err) {
        if (attempt >= MAX_NETWORK_RETRIES || !isTransientError(err)) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 10000) + Math.floor(Math.random() * 400));
      }
    }
  });

  return octokit;
}

/** Ubah error rate-limit GitHub jadi pesan yang jelas kapan user boleh coba lagi. */
function describeRateLimitError(err) {
  const headers = err.response?.headers || {};
  const resetHeader = headers["x-ratelimit-reset"];
  const retryAfterHeader = headers["retry-after"];

  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    return `GitHub sedang membatasi request (rate limit). Coba lagi dalam ${seconds} detik.`;
  }
  if (resetHeader) {
    const resetTime = new Date(parseInt(resetHeader, 10) * 1000);
    const waitMinutes = Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 60000));
    return `GitHub sedang membatasi request (rate limit). Coba lagi dalam ~${waitMinutes} menit.`;
  }
  return "GitHub sedang membatasi request (rate limit). Coba lagi beberapa saat lagi.";
}

/** Deteksi apakah sebuah error dari Octokit adalah rate limit (primary atau secondary). */
function isRateLimitError(err) {
  if (err.status !== 403 && err.status !== 429) return false;
  const remaining = err.response?.headers?.["x-ratelimit-remaining"];
  const message = String(err.message || "").toLowerCase();
  return remaining === "0" || message.includes("rate limit") || message.includes("abuse");
}

/** Validasi token, return username kalau valid. */
async function validateToken(token) {
  try {
    const octokit = getClient(token);
    const { data } = await octokit.users.getAuthenticated();
    return data.login;
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 401) {
      throw new GitHubServiceError("Token tidak valid atau sudah expired.");
    }
    throw new GitHubServiceError(`Gagal validasi token: ${err.message}`);
  }
}

/** List repo milik user, terbaru dulu. */
async function listUserRepos(token, limit = 30) {
  try {
    const octokit = getClient(token);
    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: "updated",
      direction: "desc",
      per_page: limit,
    });
    return data.map((r) => ({
      fullName: r.full_name,
      name: r.name,
      private: r.private,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    throw new GitHubServiceError(`Gagal ambil daftar repo: ${err.message}`);
  }
}

/** Buat repo baru milik user. */
async function createRepo(token, repoName, isPrivate = false) {
  try {
    const octokit = getClient(token);
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: repoName,
      private: isPrivate,
      auto_init: true, // supaya ada branch default & bisa langsung commit
      description: "Uploaded via Telegram GitHub Upload Bot",
    });
    return { fullName: data.full_name, defaultBranch: data.default_branch };
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 422) {
      throw new GitHubServiceError(`Nama repo "${repoName}" sudah dipakai atau tidak valid.`);
    }
    throw new GitHubServiceError(`Gagal membuat repo: ${err.message}`);
  }
}

/** Ambil nama branch default sebuah repo (mis. "main" atau "master"). */
async function getRepoDefaultBranch(token, fullName) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return data.default_branch;
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 404) {
      throw new GitHubServiceError(`Repo "${fullName}" tidak ditemukan atau kamu tidak punya akses.`);
    }
    throw new GitHubServiceError(`Gagal ambil info repo: ${err.message}`);
  }
}

/**
 * Buat blob untuk semua file (paralel terbatas). Return array item tree siap pakai.
 * - File dengan isi identik hanya di-upload SEKALI (sha dipakai ulang) -> hemat request.
 * - `onProgress(done, total)` opsional untuk update progres ke user.
 * - Kalau gagal, error diberi `filePath` supaya pesan ke user menyebut file mana yang bermasalah.
 */
async function createBlobsForFiles(octokit, owner, repo, files, onProgress) {
  const crypto = require("crypto");
  const inflight = new Map(); // hash isi -> Promise<sha>

  const entries = Object.entries(files);
  return mapWithConcurrencyLimit(entries, BLOB_UPLOAD_CONCURRENCY, async ([filePath, content]) => {
    const hash = crypto.createHash("sha1").update(content).digest("hex");
    if (!inflight.has(hash)) {
      inflight.set(hash, (async () => {
        const { data: blob } = await octokit.git.createBlob({
          owner,
          repo,
          content: content.toString("base64"),
          encoding: "base64",
        });
        return blob.sha;
      })());
    }
    try {
      const sha = await inflight.get(hash);
      return { path: filePath, mode: "100644", type: "blob", sha };
    } catch (err) {
      err.filePath = filePath;
      throw err;
    }
  }, onProgress);
}

/**
 * Pastikan repo punya minimal satu commit. Repo kosong (dibuat tanpa README) menolak semua
 * operasi Git Data API dengan 409 "Git Repository is empty", jadi kita buat commit awal
 * (README.md) lewat Contents API, yang memang boleh dipakai di repo kosong.
 */
async function ensureRepoInitialized(octokit, owner, repo, branch) {
  try {
    await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  } catch (err) {
    if (err.status === 409 || err.status === 404) {
      await octokit.repos.createOrUpdateFileContents({
        owner, repo,
        path: "README.md",
        message: "Initial commit",
        content: Buffer.from(`# ${repo}\n`).toString("base64"),
      });
      return;
    }
    throw err;
  }
}

/** Ambil seluruh tree secara rekursif; error jelas kalau repo terlalu besar (truncated). */
async function getFullTree(octokit, owner, repo, treeSha) {
  const { data } = await octokit.git.getTree({ owner, repo, tree_sha: treeSha, recursive: "true" });
  if (data.truncated) {
    throw new GitHubServiceError("Repo terlalu besar untuk diproses lewat bot (daftar file terpotong oleh GitHub).");
  }
  return data;
}

/**
 * Buat commit baru dari tree hasil `buildTree(baseCommit)` lalu geser branch ke commit itu.
 *
 * Anti "Update is not a fast forward": kalau updateRef ditolak (422) karena branch sudah
 * bergeser (mis. request sebelumnya yang timeout ternyata sempat sukses, atau ada push lain),
 * kita ambil ulang HEAD terbaru, bangun ulang tree/commit di atasnya, lalu coba lagi.
 * Kalau ternyata branch sudah menunjuk ke commit kita (response updateRef sebelumnya hilang
 * di jaringan), itu dianggap sukses.
 */
async function commitToBranch(octokit, { owner, repo, branch, message, buildTree }) {
  for (let attempt = 1; attempt <= MAX_REF_ATTEMPTS; attempt++) {
    const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: baseCommitSha });

    const treeSha = await buildTree(baseCommit);

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message,
      tree: treeSha,
      parents: [baseCommitSha],
    });

    try {
      await octokit.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });
      return newCommit.sha;
    } catch (err) {
      if (err.status === 422 || err.status === 409) {
        try {
          const { data: current } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
          if (current.object.sha === newCommit.sha) return newCommit.sha; // sebenarnya sudah sukses
        } catch (_) { /* abaikan, lanjut retry */ }
        if (attempt < MAX_REF_ATTEMPTS) {
          await sleep(600 * attempt);
          continue;
        }
      }
      throw err;
    }
  }
}

/** Ubah error umum operasi git jadi GitHubServiceError dengan pesan jelas. */
function toServiceError(err, fullName, actionLabel) {
  if (err instanceof GitHubServiceError) return err;
  if (isRateLimitError(err)) return new GitHubServiceError(describeRateLimitError(err));
  if (err.status === 404) {
    return new GitHubServiceError(`Repo "${fullName}" tidak ditemukan atau kamu tidak punya akses.`);
  }
  if (err.status === 409) {
    return new GitHubServiceError(
      `Repo "${fullName}" masih kosong atau sedang berubah. Kalau masih kosong, buat satu commit awal dulu (mis. tambah README di GitHub), lalu coba lagi.`
    );
  }
  if (err.status === 422 && /fast forward/i.test(String(err.message))) {
    return new GitHubServiceError("Repo sedang berubah di GitHub saat bot bekerja. Tunggu sebentar lalu coba lagi.");
  }
  if (isTransientError(err)) {
    return new GitHubServiceError(
      `Koneksi ke GitHub terputus berulang kali saat ${actionLabel}. Cek internet kamu lalu coba lagi (file yang sudah dikirim tetap tersimpan, tinggal /done lagi).`
    );
  }
  if (err.status === 401) {
    return new GitHubServiceError("Token GitHub ditolak (tidak valid / expired / dicabut). Pasang token baru dengan /settoken.");
  }
  if (err.status === 403) {
    return new GitHubServiceError(
      `Akses ditolak saat ${actionLabel}. Pastikan token punya scope "repo" (atau izin "Contents: write" untuk fine-grained token) dan kamu punya hak tulis ke repo ini.`
    );
  }
  const where = err.filePath ? ` (file: ${err.filePath})` : "";
  return new GitHubServiceError(`Gagal ${actionLabel}${where}: ${err.message}`);
}

/**
 * Push banyak file sekaligus dalam satu commit menggunakan Git Tree API.
 * `files` = { "path/dalam/repo.txt": Buffer }
 * Return: URL commit.
 */
async function pushFiles(token, fullName, files, commitMessage, onProgress) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    await ensureRepoInitialized(octokit, owner, repo, branch);

    // Blob dibuat SEKALI di luar loop retry commit (isinya tidak bergantung pada HEAD).
    const treeItems = await createBlobsForFiles(octokit, owner, repo, files, onProgress);

    const commitSha = await commitToBranch(octokit, {
      owner, repo, branch, message: commitMessage,
      buildTree: async (baseCommit) => {
        const { data: newTree } = await octokit.git.createTree({
          owner, repo, base_tree: baseCommit.tree.sha, tree: treeItems,
        });
        return newTree.sha;
      },
    });

    return `https://github.com/${fullName}/commit/${commitSha}`;
  } catch (err) {
    throw toServiceError(err, fullName, "push file");
  }
}

/** Hapus repo secara permanen. Butuh scope token "delete_repo". */
async function deleteRepo(token, fullName) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    await octokit.repos.delete({ owner, repo });
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 404) {
      throw new GitHubServiceError(`Repo "${fullName}" tidak ditemukan atau kamu tidak punya akses.`);
    }
    if (err.status === 403) {
      throw new GitHubServiceError(
        `Tidak punya izin hapus repo. Pastikan token kamu punya scope "delete_repo" ` +
          `(buat token baru di https://github.com/settings/tokens dengan scope tersebut dicentang).`
      );
    }
    throw new GitHubServiceError(`Gagal hapus repo: ${err.message}`);
  }
}

/**
 * Ambil daftar isi (tree) dari sebuah path di repo, untuk konfirmasi sebelum hapus.
 * Return: array nama item langsung di dalam path tsb (tidak rekursif), atau null kalau path tidak ada.
 */
async function getPathContents(token, fullName, targetPath) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: targetPath });
    return Array.isArray(data) ? data.map((item) => item.name) : [data.name];
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 404) return null;
    throw new GitHubServiceError(`Gagal membaca isi path: ${err.message}`);
  }
}

/**
 * Hapus folder ATAU file di path tertentu dalam repo, dalam satu commit,
 * menggunakan Git Tree API (recursive tree rewrite).
 * Return: URL commit.
 */
async function deletePath(token, fullName, targetPath, commitMessage) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");
  const normalizedPath = targetPath.replace(/^\/+|\/+$/g, "");

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    const commitSha = await commitToBranch(octokit, {
      owner, repo, branch, message: commitMessage,
      buildTree: async (baseCommit) => {
        const fullTree = await getFullTree(octokit, owner, repo, baseCommit.tree.sha);
        const blobs = fullTree.tree.filter((item) => item.type === "blob");
        const kept = blobs.filter(
          (item) => item.path !== normalizedPath && !item.path.startsWith(`${normalizedPath}/`)
        );
        if (kept.length === blobs.length) {
          throw new GitHubServiceError(`Path "${normalizedPath}" tidak ditemukan di repo.`);
        }
        const { data: newTree } = await octokit.git.createTree({
          owner, repo,
          tree: kept.map((i) => ({ path: i.path, mode: i.mode, type: i.type, sha: i.sha })),
        });
        return newTree.sha;
      },
    });

    return `https://github.com/${fullName}/commit/${commitSha}`;
  } catch (err) {
    throw toServiceError(err, fullName, "hapus path");
  }
}

/**
 * Ganti (replace) sebuah path: hapus path lama dari tree (kalau ada),
 * lalu tambahkan file-file baru, semua dalam SATU commit.
 *
 * `oldPath` boleh null/kosong kalau tidak ada yang perlu dihapus.
 * `newFiles` = { "path/dalam/repo.txt": Buffer } — path di sini sudah final.
 * Return: URL commit.
 */
async function replacePath(token, fullName, oldPath, newFiles, commitMessage) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");
  const normalizedOldPath = oldPath ? oldPath.replace(/^\/+|\/+$/g, "") : null;

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    await ensureRepoInitialized(octokit, owner, repo, branch);
    const uploadedItems = await createBlobsForFiles(octokit, owner, repo, newFiles);
    const newPathsSet = new Set(uploadedItems.map((i) => i.path));

    const commitSha = await commitToBranch(octokit, {
      owner, repo, branch, message: commitMessage,
      buildTree: async (baseCommit) => {
        const fullTree = await getFullTree(octokit, owner, repo, baseCommit.tree.sha);
        const surviving = fullTree.tree.filter((item) => {
          if (item.type !== "blob") return false;
          if (newPathsSet.has(item.path)) return false; // versi baru menang
          if (!normalizedOldPath) return true;
          return item.path !== normalizedOldPath && !item.path.startsWith(`${normalizedOldPath}/`);
        });
        const treeItems = [
          ...surviving.map((i) => ({ path: i.path, mode: i.mode, type: i.type, sha: i.sha })),
          ...uploadedItems,
        ];
        const { data: newTree } = await octokit.git.createTree({ owner, repo, tree: treeItems });
        return newTree.sha;
      },
    });

    return `https://github.com/${fullName}/commit/${commitSha}`;
  } catch (err) {
    throw toServiceError(err, fullName, "replace path");
  }
}

/**
 * Ganti nama/pindahkan folder atau file tanpa upload ulang isinya —
 * blob yang sudah ada ditulis ulang ke path baru memakai sha yang sama. Satu commit.
 * Return: URL commit.
 */
async function renamePath(token, fullName, oldPath, newPath, commitMessage) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");
  const normalizedOldPath = oldPath.replace(/^\/+|\/+$/g, "");
  const normalizedNewPath = newPath.replace(/^\/+|\/+$/g, "");

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const branch = repoData.default_branch;

    const commitSha = await commitToBranch(octokit, {
      owner, repo, branch, message: commitMessage,
      buildTree: async (baseCommit) => {
        const fullTree = await getFullTree(octokit, owner, repo, baseCommit.tree.sha);
        const blobEntries = fullTree.tree.filter((item) => item.type === "blob");

        const matched = blobEntries.filter(
          (item) => item.path === normalizedOldPath || item.path.startsWith(`${normalizedOldPath}/`)
        );
        if (matched.length === 0) {
          throw new GitHubServiceError(`Path "${normalizedOldPath}" tidak ditemukan di repo.`);
        }

        const renamed = matched.map((item) => ({
          path: item.path === normalizedOldPath
            ? normalizedNewPath
            : normalizedNewPath + item.path.slice(normalizedOldPath.length),
          mode: item.mode, type: item.type, sha: item.sha,
        }));

        const newPathsSet = new Set(renamed.map((i) => i.path));
        const untouched = blobEntries.filter(
          (item) =>
            item.path !== normalizedOldPath &&
            !item.path.startsWith(`${normalizedOldPath}/`) &&
            !newPathsSet.has(item.path)
        );

        const treeItems = [
          ...untouched.map((i) => ({ path: i.path, mode: i.mode, type: i.type, sha: i.sha })),
          ...renamed,
        ];
        const { data: newTree } = await octokit.git.createTree({ owner, repo, tree: treeItems });
        return newTree.sha;
      },
    });

    return `https://github.com/${fullName}/commit/${commitSha}`;
  } catch (err) {
    throw toServiceError(err, fullName, "rename path");
  }
}

/**
 * List isi sebuah folder (atau root kalau path="") dengan info lengkap tiap item
 * (nama, path, tipe file/dir, ukuran). Dipakai untuk file browser di /download.
 * Return: array of { name, path, type, size } atau null kalau path tidak ada / bukan folder.
 */
async function listDirectory(token, fullName, dirPath = "") {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: dirPath });

    if (!Array.isArray(data)) {
      // path yang diminta ternyata file, bukan folder
      return null;
    }

    // Folder dulu, lalu file, masing-masing diurutkan alfabetis — supaya navigasi enak dilihat
    const items = data.map((item) => ({
      name: item.name,
      path: item.path,
      type: item.type, // "dir" atau "file"
      size: item.size || 0,
    }));

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return items;
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 404) return null;
    throw new GitHubServiceError(`Gagal membaca isi folder: ${err.message}`);
  }
}

/**
 * Download isi satu file sebagai Buffer.
 * Return: { content: Buffer, size: number } atau throw kalau gagal/file terlalu besar.
 */
async function downloadFile(token, fullName, filePath) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });

    if (Array.isArray(data) || data.type !== "file") {
      throw new GitHubServiceError(`"${filePath}" bukan file (kemungkinan folder).`);
    }

    // File > 1MB tidak menyertakan field `content` langsung dari API contents,
    // perlu diambil lewat blob API memakai sha-nya.
    if (data.content) {
      return { content: Buffer.from(data.content, data.encoding || "base64"), size: data.size };
    }

    const { data: blob } = await octokit.git.getBlob({ owner, repo, file_sha: data.sha });
    return { content: Buffer.from(blob.content, blob.encoding || "base64"), size: data.size };
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err instanceof GitHubServiceError) throw err;
    if (err.status === 404) {
      throw new GitHubServiceError(`File "${filePath}" tidak ditemukan.`);
    }
    throw new GitHubServiceError(`Gagal download file: ${err.message}`);
  }
}

/**
 * Download seluruh repo (branch default) sebagai zip archive.
 * Return: Buffer isi zip.
 */
async function downloadRepoZip(token, fullName) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // Pakai octokit.request() dengan endpoint mentah (bukan alias octokit.rest.repos.download*)
    // supaya tidak tergantung nama method yang bisa berbeda antar versi Octokit.
    const response = await octokit.request("GET /repos/{owner}/{repo}/zipball/{ref}", {
      owner,
      repo,
      ref: defaultBranch,
    });

    // Response body berupa ArrayBuffer untuk endpoint binary seperti ini
    return Buffer.from(response.data);
  } catch (err) {
    if (isRateLimitError(err)) {
      throw new GitHubServiceError(describeRateLimitError(err));
    }
    if (err.status === 404) {
      throw new GitHubServiceError(`Repo "${fullName}" tidak ditemukan atau kamu tidak punya akses.`);
    }
    throw new GitHubServiceError(`Gagal download zip repo: ${err.message}`);
  }
}

/**
 * Ganti SELURUH isi repo: semua file lama dihapus total, diganti `newFiles`, dalam SATU commit.
 * Dipakai untuk /updatesite. Tree dibuat TANPA base_tree sehingga hanya berisi file baru.
 * Return: { commitUrl, defaultBranch }
 */
async function replaceEntireRepo(token, fullName, newFiles, commitMessage) {
  const octokit = getClient(token);
  const [owner, repo] = fullName.split("/");

  try {
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    await ensureRepoInitialized(octokit, owner, repo, defaultBranch);
    const treeItems = await createBlobsForFiles(octokit, owner, repo, newFiles);

    const commitSha = await commitToBranch(octokit, {
      owner, repo, branch: defaultBranch, message: commitMessage,
      buildTree: async () => {
        const { data: newTree } = await octokit.git.createTree({ owner, repo, tree: treeItems });
        return newTree.sha;
      },
    });

    return { commitUrl: `https://github.com/${fullName}/commit/${commitSha}`, defaultBranch };
  } catch (err) {
    throw toServiceError(err, fullName, "mengganti seluruh isi repo");
  }
}

module.exports = {
  GitHubServiceError,
  getClient,
  isRateLimitError,
  describeRateLimitError,
  isTransientError,
  validateToken,
  listUserRepos,
  createRepo,
  getRepoDefaultBranch,
  pushFiles,
  deleteRepo,
  getPathContents,
  deletePath,
  replacePath,
  renamePath,
  replaceEntireRepo,
  listDirectory,
  downloadFile,
  downloadRepoZip,
};
/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Semua operasi ke Vercel REST API dibungkus di sini memakai fetch bawaan Node.js,
 * supaya handler Telegram tidak perlu tahu detail API Vercel.
 *
 * Dokumentasi resmi: https://vercel.com/docs/rest-api
 */
const VERCEL_API_BASE = "https://api.vercel.com";

class VercelServiceError extends Error {}

async function vercelRequest(token, method, path, body) {
  let response;
  try {
    response = await fetch(`${VERCEL_API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new VercelServiceError(`Gagal menghubungi Vercel API: ${err.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new VercelServiceError(`Respons Vercel API tidak valid (status ${response.status}).`);
  }

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitText = retryAfter ? `${retryAfter} detik` : "beberapa saat";
      throw new VercelServiceError(`Vercel sedang membatasi request (rate limit). Coba lagi dalam ${waitText}.`);
    }
    const message = data?.error?.message || `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      throw new VercelServiceError(`Token Vercel tidak valid atau tidak punya akses: ${message}`);
    }
    throw new VercelServiceError(message);
  }

  return data;
}

/** Validasi token Vercel, return username/email kalau valid. */
async function validateToken(token) {
  const data = await vercelRequest(token, "GET", "/v2/user");
  return data.user?.username || data.user?.email || "vercel-user";
}

/**
 * Buat deployment baru dari repo GitHub.
 * `githubOwnerRepo` format "owner/repo" (fullName dari GitHub).
 * `projectName` dipakai sebagai nama project Vercel (jadi bagian dari URL deployment).
 * `branch` WAJIB diisi caller dengan default branch REPO YANG SEBENARNYA (bisa "main", "master", dst) —
 * tidak ada default hardcode di sini supaya tidak salah asumsi untuk repo yang branch defaultnya bukan "main".
 * Return: { id, url, readyState }
 */
async function createDeployment(token, githubOwnerRepo, projectName, branch) {
  const [org, repo] = githubOwnerRepo.split("/");

  const body = {
    name: projectName,
    target: "production",
    gitSource: {
      type: "github",
      repo,
      ref: branch,
      org,
    },
  };

  const data = await vercelRequest(token, "POST", "/v13/deployments", body);

  return {
    id: data.id || data.uid,
    url: data.url ? `https://${data.url}` : null,
    readyState: data.readyState || "QUEUED",
  };
}

/**
 * Cek status detail 1 deployment.
 * Return: { id, url, readyState, createdAt } atau throw kalau tidak ditemukan.
 */
async function getDeploymentStatus(token, deploymentId) {
  const data = await vercelRequest(token, "GET", `/v13/deployments/${deploymentId}`);
  return {
    id: data.id || data.uid,
    url: data.url ? `https://${data.url}` : null,
    readyState: data.readyState,
    createdAt: data.createdAt || data.created,
  };
}

/**
 * List deployment terbaru milik user (across semua project).
 * Return: array of { id, name, url, readyState, createdAt }
 */
async function listDeployments(token, limit = 20) {
  const data = await vercelRequest(token, "GET", `/v6/deployments?limit=${limit}`);
  const deployments = data.deployments || [];
  return deployments.map((d) => ({
    id: d.uid,
    name: d.name,
    url: d.url ? `https://${d.url}` : null,
    readyState: d.state || d.readyState,
    createdAt: d.created,
  }));
}

/** Hapus deployment berdasarkan ID. */
async function deleteDeployment(token, deploymentId) {
  await vercelRequest(token, "DELETE", `/v13/deployments/${deploymentId}`);
}

module.exports = {
  VercelServiceError,
  validateToken,
  createDeployment,
  getDeploymentStatus,
  listDeployments,
  deleteDeployment,
};

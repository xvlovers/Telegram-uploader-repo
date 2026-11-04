/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Layer database sederhana pakai file JSON.
 * Cocok untuk bot skala kecil-menengah (tidak untuk ribuan user bersamaan).
 *
 * Struktur data:
 * {
 *   "users": {
 *     "<chatId>": {
 *       "encryptedToken": "...", "githubUsername": "...",
 *       "encryptedVercelToken": "...", "vercelUsername": "..."
 *     }
 *   },
 *   "sessions": {
 *     "<chatId>": { "repoName": "...", "repoMode": "...", "status": "...", "isPrivate": false }
 *   },
 *   "deployments": {
 *     "<chatId>": [ { "id": "...", "name": "...", "repoFullName": "...", "createdAt": 1234567890 } ]
 *   }
 * }
 */
const fs = require("fs");
const path = require("path");
const { config } = require("../config");

const DB_PATH = config.DB_PATH;

// Database disimpan di MEMORI (cache) dan ditulis ke file di belakang layar.
// Kenapa: bot sekarang memproses banyak update bersamaan (supaya tetap responsif saat ada
// upload/deploy yang berjalan lama). Kalau tiap operasi membaca ulang file yang write-nya
// belum selesai, bisa terbaca data lama dan saling menimpa. Dengan cache, semua operasi
// melihat data yang sama dan selalu terbaru.
let cache = null;

// Queue supaya tidak ada dua write bersamaan yang saling menimpa
let writeQueue = Promise.resolve();

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, sessions: {}, deployments: {} }, null, 2));
  }
}

function readDb() {
  if (cache) return cache;
  ensureDbFile();
  const raw = fs.readFileSync(DB_PATH, "utf8");
  try {
    const data = JSON.parse(raw);
    if (!data.users) data.users = {};
    if (!data.sessions) data.sessions = {};
    if (!data.deployments) data.deployments = {}; // migrasi lembut untuk db.json lama
    cache = data;
    return cache;
  } catch (err) {
    throw new Error(`Database JSON rusak/corrupt di ${DB_PATH}: ${err.message}`);
  }
}

function writeDb() {
  // Snapshot dibuat SAAT giliran write (bukan saat dipanggil), jadi write terakhir selalu
  // berisi state terbaru. Async supaya tidak memblokir event loop bot.
  writeQueue = writeQueue
    .then(async () => {
      const tmpPath = `${DB_PATH}.tmp`;
      await fs.promises.writeFile(tmpPath, JSON.stringify(cache, null, 2));
      await fs.promises.rename(tmpPath, DB_PATH); // atomic replace
    })
    .catch((err) => console.error("Gagal menulis database:", err.message));
  return writeQueue;
}

// ---------- User token (GitHub) ----------

async function saveUserToken(chatId, encryptedToken, githubUsername) {
  const db = readDb();
  db.users[chatId] = { ...(db.users[chatId] || {}), encryptedToken, githubUsername };
  await writeDb(db);
}

function getUserToken(chatId) {
  const db = readDb();
  return db.users[chatId]?.encryptedToken || null;
}

function getGithubUsername(chatId) {
  const db = readDb();
  return db.users[chatId]?.githubUsername || null;
}

async function deleteUserToken(chatId) {
  const db = readDb();
  if (db.users[chatId]) {
    delete db.users[chatId].encryptedToken;
    delete db.users[chatId].githubUsername;
  }
  await writeDb(db);
}

function isUserRegistered(chatId) {
  return getUserToken(chatId) !== null;
}

// ---------- User token (Vercel) ----------

async function saveVercelToken(chatId, encryptedToken, vercelUsername) {
  const db = readDb();
  db.users[chatId] = { ...(db.users[chatId] || {}), encryptedVercelToken: encryptedToken, vercelUsername };
  await writeDb(db);
}

function getVercelToken(chatId) {
  const db = readDb();
  return db.users[chatId]?.encryptedVercelToken || null;
}

function getVercelUsername(chatId) {
  const db = readDb();
  return db.users[chatId]?.vercelUsername || null;
}

async function deleteVercelToken(chatId) {
  const db = readDb();
  if (db.users[chatId]) {
    delete db.users[chatId].encryptedVercelToken;
    delete db.users[chatId].vercelUsername;
  }
  await writeDb(db);
}

function isVercelRegistered(chatId) {
  return getVercelToken(chatId) !== null;
}

// ---------- Upload session (state sementara per user) ----------

async function setSession(chatId, fields) {
  const db = readDb();
  db.sessions[chatId] = { ...(db.sessions[chatId] || {}), ...fields };
  await writeDb(db);
}

function getSession(chatId) {
  const db = readDb();
  return db.sessions[chatId] ? { ...db.sessions[chatId] } : null;
}

async function clearSession(chatId) {
  const db = readDb();
  delete db.sessions[chatId];
  await writeDb(db);
}

// ---------- Riwayat deployment (dibuat lewat bot) ----------

/** Simpan catatan deployment baru ke riwayat user (dipakai /deployments, /deploystatus, /deletedeployment). */
async function addDeploymentRecord(chatId, record) {
  const db = readDb();
  if (!db.deployments[chatId]) db.deployments[chatId] = [];
  db.deployments[chatId].unshift(record); // terbaru duluan
  await writeDb(db);
}

function listDeploymentRecords(chatId) {
  const db = readDb();
  return [...(db.deployments[chatId] || [])];
}

async function removeDeploymentRecord(chatId, deploymentId) {
  const db = readDb();
  if (db.deployments[chatId]) {
    db.deployments[chatId] = db.deployments[chatId].filter((d) => d.id !== deploymentId);
  }
  await writeDb(db);
}

module.exports = {
  saveUserToken,
  getUserToken,
  getGithubUsername,
  deleteUserToken,
  isUserRegistered,
  saveVercelToken,
  getVercelToken,
  getVercelUsername,
  deleteVercelToken,
  isVercelRegistered,
  setSession,
  getSession,
  clearSession,
  addDeploymentRecord,
  listDeploymentRecords,
  removeDeploymentRecord,
};
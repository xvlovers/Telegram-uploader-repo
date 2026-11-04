/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Utility untuk memproses file yang dikirim user:
 * - Extract zip
 * - Susun jadi object { "path/dalam/repo": Buffer } siap push ke GitHub
 */
const AdmZip = require("adm-zip");

class FileProcessingError extends Error {}

// Batas aman hasil extract (proteksi "zip bomb": zip kecil yang mengembang jadi GB dan
// membuat bot kehabisan RAM di HP/Termux). Bisa diubah lewat .env.
const MAX_EXTRACTED_BYTES = (parseInt(process.env.MAX_EXTRACTED_MB, 10) || 150) * 1024 * 1024;
const MAX_ZIP_ENTRIES = parseInt(process.env.MAX_ZIP_ENTRIES, 10) || 5000;

// File/folder yang umum tidak perlu ikut ter-push (junk OS/editor)
const IGNORED_NAMES = new Set(["__MACOSX", ".DS_Store", "Thumbs.db", ".git", "node_modules"]);

function joinRepoPath(basePath, fileName) {
  const cleanName = fileName.replace(/^\/+/, "");
  if (basePath) {
    return `${basePath.replace(/\/+$/, "")}/${cleanName}`;
  }
  return cleanName;
}

/**
 * Extract isi zip (Buffer) jadi object { path: Buffer }.
 * basePath: prefix folder tujuan di dalam repo (opsional).
 */
function extractZipToObject(zipBuffer, basePath = "") {
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (err) {
    throw new FileProcessingError("File zip rusak atau bukan format zip yang valid.");
  }

  const result = {};
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new FileProcessingError(`Zip berisi terlalu banyak entri (${entries.length}). Maks ${MAX_ZIP_ENTRIES}.`);
  }
  let totalBytes = 0;

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const parts = entry.entryName.split("/");
    if (parts.some((p) => IGNORED_NAMES.has(p))) continue;
    if (parts.includes("..")) continue; // cegah path traversal

    // Cek ukuran dari header SEBELUM dekompres, supaya zip bomb tidak sempat memakan RAM.
    totalBytes += entry.header.size;
    if (totalBytes > MAX_EXTRACTED_BYTES) {
      throw new FileProcessingError(
        `Isi zip setelah di-extract terlalu besar (> ${Math.round(MAX_EXTRACTED_BYTES / 1024 / 1024)}MB).`
      );
    }

    // Normalisasi path Windows (backslash) dan buang "./" di depan
    const cleanName = entry.entryName.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const targetPath = joinRepoPath(basePath, cleanName);
    result[targetPath] = entry.getData();
  }

  if (Object.keys(result).length === 0) {
    throw new FileProcessingError("Zip kosong atau semua isinya ter-filter.");
  }

  return result;
}

/** Bungkus satu file biasa (bukan zip) jadi format object yang sama. */
function singleFileToObject(fileName, content, basePath = "") {
  const targetPath = joinRepoPath(basePath, fileName);
  return { [targetPath]: content };
}

/** Bikin ringkasan daftar file untuk ditampilkan ke user sebelum konfirmasi push. */
function summarizeFiles(files, maxLines = 15) {
  const paths = Object.keys(files);
  const total = paths.length;
  const shown = paths.slice(0, maxLines);
  let lines = shown.map((p) => `  • ${p}`).join("\n");
  if (total > maxLines) {
    lines += `\n  … dan ${total - maxLines} file lainnya`;
  }
  return `Total ${total} file:\n${lines}`;
}

module.exports = {
  FileProcessingError,
  extractZipToObject,
  singleFileToObject,
  summarizeFiles,
};
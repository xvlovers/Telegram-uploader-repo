/* credit by: xvlover | github: github.com/xvlover | wa channel: https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E | by xvlover official */

/**
 * Jalankan banyak task async secara PARALEL tapi dengan batas concurrency,
 * supaya operasi seperti "createBlob untuk tiap file" tidak sequential 1-per-1
 * (lambat untuk banyak file) tapi juga tidak all-at-once (bisa memicu secondary
 * rate limit GitHub/Vercel kalau request dalam jumlah besar ditembak bersamaan).
 *
 * @param {Array} items - daftar item yang mau diproses
 * @param {number} concurrency - jumlah task yang boleh jalan bersamaan
 * @param {(item: any, index: number) => Promise<any>} worker - fungsi async per item
 * @param {(done: number, total: number) => void} [onProgress] - callback progres (opsional)
 * @returns {Promise<Array>} hasil dalam urutan yang sama dengan `items`
 */
async function mapWithConcurrencyLimit(items, concurrency, worker, onProgress) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let done = 0;
  let failed = false; // fail-fast: begitu satu task gagal, worker lain berhenti ambil item baru

  async function runNext() {
    while (!failed && nextIndex < items.length) {
      const currentIndex = nextIndex++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (err) {
        failed = true;
        throw err;
      }
      done++;
      if (onProgress) {
        try { onProgress(done, items.length); } catch (_) { /* progress tidak boleh bikin task gagal */ }
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Array.from({ length: workerCount }, () => runNext());
  // allSettled supaya tidak ada rejection "menggantung" dari worker lain setelah yang pertama gagal;
  // error pertama tetap dilempar ke pemanggil.
  const settled = await Promise.allSettled(workers);
  const firstError = settled.find((r) => r.status === "rejected");
  if (firstError) throw firstError.reason;

  return results;
}

module.exports = { mapWithConcurrencyLimit };

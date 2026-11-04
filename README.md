# GitHub Upload Bot (Telegram) — Node.js

Bot Telegram untuk upload file/folder/zip langsung jadi isi repo GitHub, tanpa perlu terminal.

> Dibuat oleh **xvlover** — [GitHub](https://github.com/xvlover) · [WhatsApp Channel](https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E)
> Lisensi: MIT — bebas dipakai, dimodifikasi, dan disebarluaskan (lihat [LICENSE](./LICENSE))

## Fitur
- Multi-user, tiap user pakai token GitHub sendiri (Personal Access Token)
- `/status` — cek sesi/flow yang sedang aktif (upload/replace/rename/dsb) tanpa perlu mulai ulang
- `/myrepos` — lihat daftar semua repo kamu beserta status public/private dan kapan terakhir diupdate
- Upload ke repo yang sudah ada, atau bikin repo baru langsung dari bot, dengan **preview + konfirmasi** sebelum push
- Kirim file `.zip` → otomatis di-extract dan disusun sebagai folder di repo
- Kirim file satu-satu juga bisa (upload banyak file berturut-turut sebelum push)
- Ganti folder/file lama dengan yang baru dalam satu commit (`/replace`) — bisa di path yang sama atau path baru
- Ganti nama/pindahkan folder atau file (`/rename`) — **tanpa perlu upload ulang isinya**, cukup ketik nama baru. Setiap langkah punya tombol **⬅️ Kembali** untuk mundur satu langkah tanpa mulai dari awal
- Download seluruh repo sebagai zip, atau browse & download file/folder tertentu (`/download`) — dengan tombol grid dan navigasi Prev/Next kalau isinya banyak
- **Deploy repo GitHub ke Vercel** (`/deploy`) — tiap user pakai token Vercel sendiri, ada konfirmasi sebelum deploy, bisa cek riwayat & status deployment (dengan tombol Refresh), dan hapus deployment lewat bot
- **Update situs full-stack sekaligus** (`/updatesite`) — kirim satu zip baru, bot ganti TOTAL isi repo (satu commit) lalu otomatis trigger redeploy ke Vercel, tanpa perlu bikin repo atau project baru
- Hapus folder/file tertentu dalam repo (`/deletepath`) — repo tetap ada, cuma isinya yang dibuang
- Hapus repo secara permanen (`/deleterepo`) dengan konfirmasi
- **Rate limit GitHub/Vercel ditangani otomatis** — delay pendek (≤10 detik) di-retry otomatis, delay lebih lama menghasilkan pesan jelas kapan boleh coba lagi (bukan bot yang terasa hang)
- Semua pesan bot pakai format HTML dengan blockquote (`<blockquote>`), bukan Markdown biasa, supaya tampilan lebih rapi dan terstruktur seperti kartu info
- Database pakai **file JSON biasa** (`data/db.json`) — tidak perlu install database server
- Token GitHub & Vercel tetap **dienkripsi** (AES-256-GCM) sebelum disimpan ke JSON, bukan plaintext

## Struktur Project
```
github-upload-bot-js/
├── index.js                  # entry point
├── config.js                 # baca .env & konstanta
├── package.json
├── .env.example
├── handlers/                  # logic per fitur Telegram
│   ├── startHandler.js
│   ├── authHandler.js
│   ├── myReposHandler.js
│   ├── statusHandler.js
│   ├── uploadHandler.js
│   ├── deleteHandler.js
│   ├── replaceHandler.js
│   ├── renameHandler.js
│   ├── downloadHandler.js
│   ├── vercelAuthHandler.js
│   ├── deployHandler.js
│   └── updateSiteHandler.js
├── services/                  # logic bisnis, tidak tahu soal Telegram
│   ├── dbService.js           # baca/tulis data/db.json
│   ├── cryptoService.js       # enkripsi token
│   ├── githubService.js       # semua panggilan ke GitHub API
│   └── vercelService.js       # semua panggilan ke Vercel API
├── utils/
│   ├── fileUtils.js           # extract zip, susun path
│   ├── paginationUtils.js     # grid tombol + navigasi Prev/Next
│   ├── formatUtils.js         # helper HTML: escape, bold, code, blockquote
│   ├── menuUtils.js           # tombol "⬅️ Menu" yang dipakai beberapa layar
│   ├── buttonUtils.js         # tombol berwarna (danger/success/primary)
│   └── concurrencyUtils.js    # paralelisasi terbatas untuk request API
└── data/
    └── db.json                # auto dibuat saat pertama kali jalan
```

## Setup di VPS

### 1. Persiapan server (Node.js 18+)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs -y
node --version   # pastikan v18 ke atas (butuh fetch bawaan)
```

### 2. Upload project ke VPS, masuk foldernya, install dependency
```bash
cd github-upload-bot-js
npm install
```

### 3. Buat bot Telegram
1. Chat ke [@BotFather](https://t.me/BotFather) di Telegram
2. Ketik `/newbot`, ikuti instruksinya
3. Simpan token yang diberikan (format: `123456:ABC-DEF...`)

### 4. Konfigurasi environment
```bash
cp .env.example .env
```
Generate encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Isi file `.env`:
```
TELEGRAM_BOT_TOKEN=token_dari_botfather
ENCRYPTION_KEY=hasil_generate_di_atas
```

### 5. Jalankan bot
```bash
npm start
```

### 6. Supaya tetap jalan setelah SSH ditutup (pakai systemd)
Buat file `/etc/systemd/system/github-upload-bot.service`:
```ini
[Unit]
Description=Telegram GitHub Upload Bot
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/ke/github-upload-bot-js
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Aktifkan:
```bash
sudo systemctl daemon-reload
sudo systemctl enable github-upload-bot
sudo systemctl start github-upload-bot
sudo systemctl status github-upload-bot
```

Lihat log:
```bash
sudo journalctl -u github-upload-bot -f
```

Alternatif tanpa systemd: pakai [`pm2`](https://pm2.keymetrics.io/) (`npm install -g pm2`, lalu `pm2 start index.js --name github-upload-bot`).

## Cara Pakai (dari sisi user Telegram)
1. `/start` — lihat panduan
2. Buat Personal Access Token di https://github.com/settings/tokens/new dengan scope **repo** (dan **delete_repo** kalau mau pakai `/deleterepo`)
3. `/settoken TOKEN_KAMU` — hubungkan akun GitHub
4. `/myrepos` — lihat semua repo kamu
5. `/status` — cek sesi/proses yang sedang aktif (kalau ada)
6. `/upload` — pilih repo existing atau buat baru, kirim file `.zip`/file satu-satu, `/done` untuk lihat preview, konfirmasi untuk push
7. `/replace` — pilih repo, ketik path lama yang mau diganti, pilih path sama/baru, kirim file baru, `/done` untuk preview, konfirmasi untuk terapkan (1 commit gabungan hapus+upload)
8. `/rename` — pilih repo, ketik path lama, ketik path/nama baru, konfirmasi (tidak perlu upload ulang isi file, bisa mundur langkah pakai tombol ⬅️ Kembali)
9. `/download` — pilih repo, pilih "seluruh repo (zip)" atau "pilih file/folder", lalu browse & klik file yang mau diunduh
10. `/deletepath` — pilih repo, ketik nama folder/file yang mau dihapus (mis. `src/oldfolder`), konfirmasi
11. `/deleterepo` — pilih repo, konfirmasi untuk hapus permanen
12. `/cancel` — batalkan sesi apa pun yang sedang berjalan
13. `/logout` — hapus token GitHub dari bot

**Deploy ke Vercel (opsional):**
14. Buat token di https://vercel.com/account/tokens, lalu `/setvercel TOKEN_KAMU`
15. `/deploy` — pilih repo GitHub, konfirmasi, bot buat deployment di Vercel, dapat link
16. `/updatesite` — pilih repo, kirim satu file `.zip` baru, konfirmasi tegas, bot ganti total isi repo + auto redeploy ke Vercel (project yang sama, bukan baru)
17. `/deployments` — lihat riwayat & status semua deployment yang pernah dibuat lewat bot
18. `/deploystatus <nomor>` — cek detail 1 deployment, ada tombol 🔄 Refresh selagi masih build
19. `/deletedeployment` — pilih deployment dari riwayat, konfirmasi, hapus dari Vercel
20. `/logoutvercel` — hapus token Vercel dari bot

## Batasan Penting
- **Performa push/replace banyak file:** upload blob ke GitHub dijalankan paralel (maksimal 6 request bersamaan), bukan satu-per-satu, supaya push/replace repo dengan banyak file tidak lambat. Meski begitu, `handlerTimeout` Telegraf dinaikkan ke 5 menit sebagai jaring pengaman kedua untuk repo yang sangat besar.
- **Ukuran file:** Telegram Bot API membatasi bot mengunduh file maksimal **20MB per file**. Untuk project lebih besar, user perlu split jadi beberapa zip.
- **Database JSON:** cocok untuk bot skala kecil-menengah. Setiap operasi baca-tulis membuka seluruh file `db.json` — kalau nanti user sangat banyak (ribuan+), pertimbangkan migrasi ke database sungguhan (SQLite/PostgreSQL).
- **Sesi upload di memori:** daftar file yang sedang dikumpulkan (sebelum `/done`) disimpan di memori proses, bukan di JSON. Kalau bot di-restart di tengah sesi, user perlu kirim ulang filenya. Tapi token & pilihan repo (di `db.json`) tidak hilang.
- Push saat ini selalu ke branch default repo (biasanya `main`), belum mendukung pilih branch lain.
- `/deletepath` menghapus folder/file dengan menulis ulang tree repo tanpa entry di path tersebut lalu commit — history lama tetap ada di commit sebelumnya, tapi file/folder itu hilang mulai commit terbaru.
- `/deleterepo` butuh token dengan scope **delete_repo** dicentang, kalau tidak GitHub akan menolak (403).
- `/replace` menghapus path lama dan menambahkan file baru dalam **satu commit** (bukan dua commit terpisah) — kalau path baru berbeda dari path lama, efeknya seperti "pindah/rename" folder.
- `/rename` tidak men-download/upload ulang isi file — hanya menulis ulang path di Git tree memakai blob yang sudah ada, jadi cepat walau file/folder-nya besar.
- `/download` juga tunduk pada batas **20MB** Telegram Bot API — kalau zip repo atau file yang mau diunduh lebih besar dari itu, bot akan kasih tahu daripada gagal diam-diam.
- **`/deploy` mengasumsikan repo GitHub sudah pernah di-*import* ke akun Vercel user** (lewat dashboard Vercel, "Add New Project", pilih repo tsb sekali saja). Ini kebutuhan dari sisi Vercel sendiri — API deployment butuh Vercel sudah punya akses baca ke repo tersebut. Kalau belum pernah di-import, `/deploy` akan gagal dengan pesan error yang menjelaskan ini.
- Riwayat deployment (`/deployments`, `/deploystatus`, `/deletedeployment`) hanya mencatat deployment yang **dibuat lewat bot ini** — bukan semua deployment di akun Vercel user (yang mungkin juga dibuat lewat dashboard/CLI Vercel langsung).
- **Rate limit:** kalau GitHub/Vercel membatasi request dan waktu tunggunya lama (>10 detik), bot tidak menunggu otomatis (supaya command Telegram tidak terasa "hang") — bot akan kasih pesan kapan boleh coba lagi, tinggal diulang manual setelah itu.
- `/status` hanya menampilkan sesi multi-langkah yang tersimpan di `db.json` (upload/replace/rename/deletepath) — tidak menampilkan progress build Vercel yang sedang jalan (pakai `/deploystatus` untuk itu).
- **`/updatesite` menghapus SEMUA file lama di repo tanpa terkecuali**, bukan cuma sebagian — kalau butuh update sebagian saja, pakai `/replace` atau `/upload` biasa. Aksi ini tidak bisa di-undo dari bot; commit lama masih ada di histori Git kalau butuh rollback manual lewat GitHub.
- `/updatesite` juga mengasumsikan repo sudah pernah di-*import* ke akun Vercel (sama seperti `/deploy`) — kalau belum, tahap redeploy di akhir akan gagal walau repo-nya sudah berhasil diganti isinya.

## Tombol Berwarna
Tombol konfirmasi (hapus repo/path/deployment, deploy, upload, rename, replace, updatesite) memakai field `style` resmi dari **Telegram Bot API 9.4** (rilis Februari 2026): `"danger"` (merah) untuk aksi destruktif, `"success"` (hijau) untuk aksi aman, `"primary"` (biru) untuk aksi utama.

Catatan penting:
- Field ini resmi dari Telegram, tapi **Telegraf v4.16.3** yang dipakai project ini dirilis sebelum fitur ini ada, jadi ditambahkan manual lewat `utils/buttonUtils.js` (bukan lewat helper `Markup.button.callback()` bawaan). Telegraf tetap meneruskan field ini apa adanya ke Telegram API.
- Warna hanya akan tampil di **client Telegram yang sudah update ke versi yang mendukung Bot API 9.4+**. Di client lama, field `style` diabaikan dengan aman — tombol tetap tampil normal (tidak error, cuma tidak berwarna).

## Keamanan
- Token GitHub dienkripsi pakai AES-256-GCM (built-in Node.js `crypto`, tidak ada dependency tambahan) sebelum disimpan ke `db.json`
- Pesan Telegram yang berisi `/settoken` otomatis dihapus bot setelah diproses
- **Backup `ENCRYPTION_KEY` di tempat aman** — kalau hilang, semua token user yang tersimpan tidak bisa didekripsi lagi (user harus `/settoken` ulang)
- Jangan commit file `.env` maupun `data/db.json` ke git (sudah masuk `.gitignore`)
- Penulisan ke `db.json` pakai teknik atomic write (tulis ke file `.tmp` lalu rename) supaya tidak corrupt kalau proses tiba-tiba mati di tengah penulisan

## Pengembangan Selanjutnya (ide)
- Pilih branch tujuan push
- Progress bar untuk file besar
- Dukungan OAuth GitHub (tanpa perlu paste token manual)
- Riwayat upload per user
- Migrasi ke SQLite kalau jumlah user makin banyak

## Cara Publish Project Ini ke Repo GitHub Sendiri

Kalau kamu mau upload project ini (bukan bot-nya, tapi source code-nya) ke GitHub sebagai repo publik:

```bash
cd github-upload-bot-js
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/USERNAME_KAMU/telegram-github-upload-bot.git
git push -u origin main
```

Nama repo yang disarankan: **`telegram-github-upload-bot`**

Sebelum push, pastikan:
- File `.env` **tidak ikut ter-commit** (sudah otomatis diabaikan lewat `.gitignore`)
- File `data/db.json` (kalau sudah pernah dijalankan lokal dan berisi token user asli) juga tidak ikut ter-commit

## Credit
Project ini dibuat oleh **xvlover**.
- GitHub: [github.com/xvlover](https://github.com/xvlover)
- WhatsApp Channel: [whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E](https://whatsapp.com/channel/0029VbCKJpb6LwHpbtC1mb3E)

Dilisensikan di bawah [MIT License](./LICENSE) — bebas dipakai, dimodifikasi, dan disebarluaskan untuk keperluan apa pun, termasuk komersial, selama notice lisensi tetap disertakan.


---

## ⚙️ GitHub Actions (`/actions`)

Kelola dan pantau workflow GitHub Actions langsung dari Telegram.

- Pilih repo → pilih workflow → **▶️ Jalankan** (trigger `workflow_dispatch`).
- **⚙️ Jalankan dengan input/branch**: kirim `nama=nilai` per baris; `ref=nama-branch` untuk memilih branch.
- **Pemantauan real-time**: pesan status di-update otomatis (± tiap 4 detik) berisi job, step, durasi. Saat run selesai kamu dapat notifikasi baru.
- **Console**: potongan log job yang sedang berjalan ditampilkan bila GitHub menyediakannya; kalau tidak, progres step tetap real-time dan log lengkap tersedia begitu job selesai.
- Job gagal → bot otomatis mengirim ringkasan error + log terakhir.
- Tombol: 🛑 Cancel, 🔄 Re-run semua / 🔁 Re-run yang gagal, 📄 log per job (.txt), 📥 semua log (.zip), aktifkan/nonaktifkan workflow.

**Syarat:** workflow harus punya `on: workflow_dispatch:` agar bisa dijalankan manual. Token classic cukup dengan scope `repo` (fine-grained: *Actions: Read and write*). Scope `workflow` hanya perlu kalau kamu push file di `.github/workflows/` lewat bot.

## 🧵 Bot tetap responsif saat sibuk

Update Telegram diproses terpisah dari loop polling, jadi `/status`, `/cancel`, dan tombol lain tetap dijawab saat upload/deploy/pemantauan berjalan. Dokumen yang dikirim beruntun tetap diproses berurutan, dan `/done` menunggu semua unduhan selesai.

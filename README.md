# WA Electron

Aplikasi desktop WhatsApp client dengan **Electron + whatsapp-web.js**.
Login via QR (sesi tersimpan/persisten), lihat daftar chat, baca & kirim pesan,
dan notifikasi desktop untuk pesan masuk — semua real-time.

## Jalankan

```bash
npm install
npm start
```

Saat pertama jalan, pindai QR (WhatsApp HP → Perangkat tertaut → Tautkan perangkat).
Sesi disimpan di folder `userData` Electron (LocalAuth), jadi tidak perlu scan ulang
setiap buka.

## Master Data, AI & Reminder

- **📇 Master Data** — direktori Divisi · Kadev · Nomor WA (CRUD, tombol "Chat" buka chat ke kadev).
- **🤖 AI Lokal (Ollama)** — `http://localhost:11434`, default model `qwen3.5:9b`.
  - **✨ AI** di kotak ketik: susun/perbaiki balasan (kamu review lalu kirim manual).
  - **Auto-reply** (toggle di panel AI): balas pesan masuk otomatis, grounded ke master data.
  - Semua tergantung **Ollama** jalan: `ollama serve` + model ke-pull (`ollama pull qwen3.5:9b`).
- **⏰ Reminder** — kirim pesan WA terjadwal ke kadev divisi (target dari Master Data). Mode
  sekali (tanggal+jam) atau harian (jam). Tombol "✨ Susun AI" untuk mengarang isi pesan.

## Catatan teknis

- **Chrome sistem**: Puppeteer bawaan whatsapp-web.js diarahkan ke Chrome terpasang
  (`CHROME_PATH`, default `C:\Program Files\Google\Chrome\Application\chrome.exe`)
  karena unduh Chromium gagal di environment ini. Override lewat env `CHROME_PATH`.
- **Arsitektur**: client whatsapp-web.js berjalan di **main process** (`main.js`);
  UI di renderer (`src/`). Komunikasi via IPC dengan `contextIsolation` aktif
  (`preload.js`), tanpa `nodeIntegration`.
- **Build installer Windows**: `npm run dist` (electron-builder, target NSIS).

## Struktur

```
main.js       proses utama Electron + WhatsApp client + IPC handler
preload.js    jembatan aman renderer <-> main (contextBridge)
src/
  index.html  layout (overlay QR + sidebar chat + panel pesan)
  styles.css  tema gelap ala WhatsApp
  renderer.js logika UI
```

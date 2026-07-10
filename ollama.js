'use strict';

// Klien AI lokal via Ollama (http://localhost:11434). Dipakai untuk:
//   - draft()          : susun/perbaiki balasan (manual, user review dulu)
//   - autoReply()      : balasan otomatis pesan masuk (grounded master data)
//   - composeReminder(): susun teks pesan reminder dari poin singkat
// Tanpa dependency tambahan: pakai global fetch (Node 18+/Electron).

const settings = require('./settings');

// Buang blok <think>…</think> dari model thinking (qwen3.5 / deepseek-r1).
function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s+/, '')
    .trim();
}

function groundingText(master) {
  const rows = (master || []).filter((r) => r.divisi);
  if (!rows.length) return '';
  const lines = rows.map(
    (r) =>
      `- ${r.divisi}${r.kadev ? ` — ${r.kadev}` : ''}${
        r.number ? ` (WA: +${r.number})` : ''
      }`
  );
  return 'Data master divisi Greenpark:\n' + lines.join('\n');
}

async function chat(messages, { signal, options, format } = {}) {
  const { baseUrl, model } = settings.getAi();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, think: false, options, format }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return stripThink(data?.message?.content || '');
}

// Daftar model terpasang di Ollama.
async function listModels() {
  const { baseUrl } = settings.getAi();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

async function ping() {
  const { baseUrl, model } = settings.getAi();
  const models = await listModels();
  return { ok: true, baseUrl, model, models };
}

// Susun / perbaiki balasan. `draftText` opsional = arah/poin user.
async function draft({ chatName, lastIncoming, draftText, master }) {
  const sys =
    settings.getAi().systemPrompt +
    '\nTugas: tuliskan SATU balasan WhatsApp yang siap kirim. ' +
    'Keluarkan HANYA teks balasannya, tanpa tanda kutip atau penjelasan.';
  const ground = groundingText(master);
  const ctx = [
    chatName ? `Lawan bicara: ${chatName}` : '',
    lastIncoming ? `Pesan terakhir dari mereka: "${lastIncoming}"` : '',
    draftText ? `Arahan/poin balasan: ${draftText}` : 'Susun balasan yang sesuai.',
  ]
    .filter(Boolean)
    .join('\n');
  const messages = [
    { role: 'system', content: ground ? `${sys}\n\n${ground}` : sys },
    { role: 'user', content: ctx },
  ];
  return chat(messages);
}

// Balasan otomatis untuk pesan masuk. `history` = [{role, content}].
// `senderNumber` + `senderRow` (baris master data pengirim, bila ada) dipakai
// agar LaLa tahu siapa lawan bicaranya dan bisa memandu fitur input progres.
// `toneLine` = deskripsi gaya bicara pilihan pengirim (lembut/kasar/bro).
async function autoReply({ chatName, incoming, history, master, senderNumber, senderName, senderRow, toneLine }) {
  const sys =
    settings.getAi().systemPrompt +
    (toneLine ? `\n${toneLine}` : '') +
    '\nKamu membalas otomatis. Jawab langsung sebagai pesan WhatsApp, singkat.';
  const ground = groundingText(master);

  const nameBit = senderName ? ` Nama panggilannya: "${senderName}" — sapa pakai nama itu.` : '';
  const who = senderNumber
    ? senderRow
      ? `Pengirim pesan ini: +${senderNumber} — TERDAFTAR di Master Data sebagai divisi ${senderRow.divisi}${senderRow.kadev ? ` (${senderRow.kadev})` : ''}.${nameBit} ` +
        'Kamu SUDAH KENAL dia — perlakukan seperti rekan lama satu tim, sapa akrab, ' +
        'jangan formal, jangan minta dia memperkenalkan diri. ' +
        'JANGAN PERNAH menulis placeholder seperti [Nama] atau [Proyek] — bila tidak ' +
        'tahu namanya, sapa saja tanpa nama.'
      : `Pengirim pesan ini: +${senderNumber} — tidak terdaftar di Master Data divisi.${nameBit}`
    : '';
  const teknikCap = senderRow &&
    /tekni|dirops|direktur|direksi|ceo|owner|komisaris|pimpinan/i.test(
      `${senderRow.divisi || ''} ${senderRow.kadev || ''}`
    )
    ? 'KEMAMPUAN PROGRES TEKNIK (untuk pengirim ini):\n' +
      '1) INPUT: kirim laporan yang menyebut NAMA PROYEK, BLOK, dan item pekerjaan selesai. ' +
      'Contoh: "CMGP blok B1 selesai pasang genteng, nok, dan plafon". Sistem otomatis ' +
      'mendeteksi lalu minta balasan YA untuk menyimpan ke spreadsheet monitoring. ' +
      'Setiap progres WAJIB disertai foto — kirim di chat ini juga, otomatis tersimpan ' +
      'ke folder unit saat dikonfirmasi.\n' +
      '2) CEK: tanya progres dengan menyebut proyek (dan blok bila perlu), contoh: ' +
      '"cek progres CMGP B1" atau "cek CMGP" — sistem membacakan data dari spreadsheet; ' +
      'bila blok disebut dan ada foto tersimpan, sistem menawarkan kirim foto ' +
      '(user balas FOTO untuk menampilkannya).\n' +
      '3) KOREKSI/EDIT: hapus centang yang salah input dengan menyebut proyek, blok, dan ' +
      'itemnya, contoh: "koreksi CMGP B1, genteng ternyata belum selesai" — sistem minta ' +
      'konfirmasi YA lalu menghapus centangnya di spreadsheet.\n' +
      'Bila user bertanya cara input/cek, JELASKAN format di atas — jangan bilang kamu ' +
      'tidak bisa mengakses spreadsheet.'
    : '';
  const honesty =
    'PENTING: kamu TIDAK bisa mengubah Master Data / mendaftarkan nomor / menyimpan data ' +
    'apa pun lewat percakapan ini (kecuali alur laporan progres di atas bila tersedia). ' +
    'JANGAN PERNAH mengaku sudah mencatat, menyimpan, memverifikasi, atau memperbarui data ' +
    'apa pun — termasuk laporan progres dan foto. Penyimpanan HANYA terjadi lewat pesan ' +
    'sistem otomatis yang berawalan "📋 Terdeteksi laporan progres" lalu user membalas YA; ' +
    'kalau KAMU yang sedang menjawab, berarti sistem BELUM mendeteksi laporan dan BELUM ada ' +
    'yang tersimpan — katakan itu terus terang dan pandu formatnya (sebut proyek, blok, dan ' +
    'ITEM pekerjaan spesifik, bukan persentase). Bila diminta ubah Master Data, ' +
    'arahkan ke admin untuk mengubahnya di aplikasi. ' +
    'Jawab pertanyaan lanjutan BERDASARKAN riwayat percakapan (mis. hasil cek progres yang ' +
    'baru dibacakan). Data yang TIDAK ada di sistem — jadwal target, deadline, keterlambatan — ' +
    'katakan terus terang tidak tersedia; boleh simpulkan seadanya dari angka yang sudah ' +
    'disebut (mis. berapa unit belum mulai), jangan mengarang.';

  const sysFull = [sys, ground, who, teknikCap, honesty].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: sysFull },
    ...(history || []),
    { role: 'user', content: incoming },
  ];
  return chat(messages);
}

// Susun teks reminder dari poin singkat.
async function composeReminder({ points, divisi, kadev, master }) {
  const sys =
    'Kamu menyusun pesan WhatsApp pengingat (reminder) yang sopan dan jelas ' +
    'dalam Bahasa Indonesia. Keluarkan HANYA teks pesannya.';
  const ground = groundingText(master);
  const target = [divisi && `Divisi: ${divisi}`, kadev && `Penerima: ${kadev}`]
    .filter(Boolean)
    .join(', ');
  const messages = [
    { role: 'system', content: ground ? `${sys}\n\n${ground}` : sys },
    {
      role: 'user',
      content: `${target ? target + '\n' : ''}Poin pengingat: ${points}`,
    },
  ];
  return chat(messages);
}

module.exports = { chat, listModels, ping, draft, autoReply, composeReminder };

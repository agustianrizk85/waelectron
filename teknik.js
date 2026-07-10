'use strict';

// Laporan progres pembangunan via WA → Google Sheet monitoring Teknik.
//
// Alur: pesan masuk dari nomor divisi Teknik (Master Data) → LaLa (Ollama)
// ekstrak {proyek, blok, item selesai} → balas ringkasan minta konfirmasi →
// user balas "YA" → tulis ✓ ke kolom item di sheet "Master Database".
//
// Sheet: MASTER_DB_MONITORING_BOBOT_KURVAS_GREENPARK
//   baris 3 = header (A–H identitas, S–DF item pekerjaan, DG total, DH/DI BAST)
//   baris 5+ = data unit. Item dicentang "✓"; TOTAL BOBOT dihitung formula sheet.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const gsheets = require('./gsheets');
const ollama = require('./ollama');
const masterdata = require('./masterdata');

const SHEET_ID =
  process.env.TEKNIK_SHEET_ID || '1oDp4s086K5_I7dDQUTv_0HKiBinabAUWrqBYGJAL8uM';
const TAB = process.env.TEKNIK_SHEET_TAB || 'Master Database';
const SECTION_ROW = 2;
const HEADER_ROW = 3;
const DATA_START_ROW = 5;
const MODEL_TTL = 10 * 60 * 1000;
const PENDING_TTL = 15 * 60 * 1000;

// Foto progres: ditampung dulu per chat (_staging), lalu saat laporan
// dikonfirmasi YA dipindah ke <FOTO_DIR>\<PROYEK>\<BLOK>\<tanggal>\ —
// satu folder per unit per hari, siap dipakai bahan laporan.
const FOTO_DIR =
  process.env.TEKNIK_FOTO_DIR ||
  path.join(os.homedir(), 'Documents', 'Progres Teknik');
const PHOTO_TTL = 60 * 60 * 1000; // foto >1 jam tanpa laporan dianggap basi
const ACK_GAP = 10 * 60 * 1000;

let model = null; // { items, cats, units, proyeks, totalCol, at }
const pending = new Map(); // chatId -> { units, items, mode, expires }
const pendingFoto = new Map(); // chatId -> { photos, expires } (tawaran kirim foto)
const lastCtx = new Map(); // chatId -> { proyek, bloks, at } (rujukan "disana"/"unit itu")

// ---- Kendala lapangan (persist ke userData/kendala.json) ----------------------
// {id, proyek, blok, text, at, status:'open'|'selesai', selesaiAt?}
let kendalaFile = '';
let kendalaList = [];

// ---- Gaya bicara per nomor (persist ke userData/tone.json) --------------------
// number -> { tone: 'lembut'|'kasar'|'bro', asked: bool }
let toneFile = '';
let toneMap = {};

async function init(userDataDir) {
  kendalaFile = path.join(userDataDir, 'kendala.json');
  try {
    kendalaList = JSON.parse(fs.readFileSync(kendalaFile, 'utf8'));
    if (!Array.isArray(kendalaList)) kendalaList = [];
  } catch (_) {
    kendalaList = [];
  }
  toneFile = path.join(userDataDir, 'tone.json');
  try {
    toneMap = JSON.parse(fs.readFileSync(toneFile, 'utf8')) || {};
  } catch (_) {
    toneMap = {};
  }
}

function saveToneFile() {
  if (!toneFile) return;
  try {
    fs.writeFileSync(toneFile, JSON.stringify(toneMap, null, 2));
  } catch (_) {}
}

function getTone(number) {
  const num = masterdata.normalizeNumber(number);
  return (toneMap[num] || {}).tone || '';
}

function setTone(number, tone) {
  const num = masterdata.normalizeNumber(number);
  toneMap[num] = { ...(toneMap[num] || {}), tone, asked: true };
  saveToneFile();
}

const TONE_DESC = {
  lembut:
    'Gaya bicara: LEMBUT dan hangat — sopan, sabar, suportif, seperti teman dekat ' +
    'yang humble. Bahasa sehari-hari halus.',
  kasar:
    'Gaya bicara: TEGAS dan blak-blakan — langsung ke inti tanpa basa-basi, boleh ' +
    'menegur keras bila progres jelek/data bolong, tapi TETAP profesional, tanpa ' +
    'kata kotor atau merendahkan pribadi.',
  bro:
    'Gaya bicara: BRO BANGET — gaul santai kayak sohib nongkrong (pakai "bro/gan", ' +
    'bahasa anak muda, boleh bercanda dikit), tapi isi jawabannya tetap akurat dan ' +
    'kerjaan tetap serius. Jangan berlebihan sampai norak.',
};

function toneLine(number) {
  return TONE_DESC[getTone(number)] || TONE_DESC.lembut;
}

function saveKendalaFile() {
  if (!kendalaFile) return;
  try {
    fs.writeFileSync(kendalaFile, JSON.stringify(kendalaList, null, 2));
  } catch (_) {}
}

function openKendala(proyek, blok) {
  return kendalaList.filter(
    (k) =>
      k.status === 'open' &&
      norm(k.proyek) === norm(proyek) &&
      (!blok || normBlok(k.blok) === normBlok(blok))
  );
}

function kendalaLine(k) {
  const d = new Date(k.at);
  return `${k.text}${k.blok ? ` [${k.blok}]` : ''} (sejak ${dateStr(d)})`;
}

// Tandai kendala selesai utk proyek(+blok); return teks balasan.
function closeKendala(proyek, bloks) {
  const blokLabel = bloks.length ? ` ${bloks.join(', ')}` : '';
  const targets = bloks.length
    ? bloks.flatMap((b) => openKendala(proyek, b))
    : openKendala(proyek, '');
  if (!targets.length) {
    return `Tidak ada kendala aktif tercatat untuk ${proyek}${blokLabel}.`;
  }
  targets.forEach((k) => {
    k.status = 'selesai';
    k.selesaiAt = Date.now();
  });
  saveKendalaFile();
  return (
    `✅ ${targets.length} kendala ditandai selesai untuk ${proyek}${blokLabel}:\n` +
    targets.map((k) => `• ${k.text}`).join('\n')
  );
}
const photoStage = new Map(); // chatId -> [{ file, at }]
const photoAckAt = new Map(); // chatId -> ts ack terakhir (anti-spam)

function configured() {
  return gsheets.configured();
}

// Baca header + kolom identitas, bangun peta item/unit. Cache 10 menit.
async function loadModel(force) {
  if (!force && model && Date.now() - model.at < MODEL_TTL) return model;
  const headerRows = await gsheets.getValues(SHEET_ID, `'${TAB}'!A${HEADER_ROW}:DZ${HEADER_ROW}`);
  // Sel header bisa berisi newline ("TOTAL\nKONTRAK") — normalkan whitespace dulu.
  const header = (headerRows[0] || []).map((h) =>
    String(h || '').replace(/\s+/g, ' ').trim()
  );
  const startCol = header.findIndex((h) => /TOTAL KONTRAK/i.test(h)) + 1;
  const totalCol = header.findIndex((h) => /TOTAL BOBOT/i.test(h));
  if (startCol <= 0 || totalCol <= startCol) {
    throw new Error('Struktur header sheet tidak dikenali');
  }
  // Baris 2 = kategori (merged; nilai hanya di sel pertama → forward-fill).
  // "II. PONDASI & BETON (23.841%)" -> "PONDASI & BETON"
  const sectionRows = await gsheets.getValues(SHEET_ID, `'${TAB}'!A${SECTION_ROW}:DZ${SECTION_ROW}`);
  const sections = (sectionRows[0] || []).map((h) =>
    String(h || '').replace(/\s+/g, ' ').trim()
  );
  const items = [];
  let curCat = '';
  for (let c = startCol; c < totalCol; c++) {
    if (sections[c]) {
      curCat = sections[c]
        .replace(/^\s*[IVX]+\.\s*/i, '')
        .replace(/\s*\([\d.,]+%\)\s*$/, '')
        .trim();
    }
    const raw = header[c];
    if (!raw) continue;
    // "Genteng Cisangkan ▼2.123%" -> "Genteng Cisangkan"
    items.push({ name: raw.replace(/\s*▼[\d.,]+%?\s*$/, '').trim(), col: c, cat: curCat });
  }
  const cats = [...new Set(items.map((i) => i.cat).filter(Boolean))];
  const idRows = await gsheets.getValues(SHEET_ID, `'${TAB}'!A${DATA_START_ROW}:E100000`);
  const units = [];
  idRows.forEach((r, i) => {
    const group = String(r[1] || '').trim();
    const proyek = String(r[2] || '').trim();
    const blok = String(r[3] || '').trim();
    const tipe = String(r[4] || '').trim();
    if (!proyek || !blok) return;
    units.push({ row: DATA_START_ROW + i, group, proyek, blok, tipe });
  });
  const proyeks = [...new Set(units.map((u) => u.proyek))];
  model = { items, cats, units, proyeks, totalCol, at: Date.now() };
  return model;
}

function norm(s) {
  return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// Blok dibandingkan tanpa pemisah: "C3.1" = "C 3.1" = "C3-1".
function normBlok(s) {
  return norm(s).replace(/[^A-Z0-9]/g, '');
}

// LLM sering melewatkan blok dari teks — pindai deterministik: pola huruf+angka
// ("B4", "C 3.1", "A-2") dan nama blok murni huruf ("RUKO") yang benar-benar
// terdaftar di proyek terkait.
function scanBloks(text, m, proyek) {
  const known = new Map(); // normBlok -> blok asli
  m.units
    .filter((u) => !proyek || norm(u.proyek) === norm(proyek))
    .forEach((u) => known.set(normBlok(u.blok), u.blok));
  const found = [];
  const re = /\b([A-Z]{1,3})\s*[-.]?\s*(\d+(?:[.]\d+)?)\b/gi;
  let mt;
  while ((mt = re.exec(text))) {
    const key = normBlok(mt[1] + mt[2]);
    const orig = known.get(key);
    if (orig && !found.includes(orig)) found.push(orig);
  }
  for (const w of norm(text).split(/[^A-Z0-9]+/)) {
    if (w.length >= 3 && !/\d/.test(w)) {
      const orig = known.get(w);
      if (orig && !found.includes(orig)) found.push(orig);
    }
  }
  return found;
}

// Nama proyek juga dipindai deterministik (nama terpanjang dulu, agar
// "VERBUR EXTENTION" tidak tertukar "VERBUR").
function scanProyek(text, m) {
  const tN = ' ' + norm(text) + ' ';
  for (const p of [...m.proyeks].sort((a, b) => b.length - a.length)) {
    if (tN.includes(' ' + norm(p) + ' ') || tN.includes(norm(p))) return norm(p);
  }
  return '';
}

// Apakah nomor pengirim terdaftar sebagai divisi Teknik di Master Data.
// Dua sisi dinormalisasi — data lama bisa tersimpan tanpa awalan 62.
function isTeknikNumber(number) {
  const num = masterdata.normalizeNumber(number);
  if (!num) return false;
  return masterdata
    .list()
    .some(
      (r) =>
        /tekni/i.test(r.divisi || '') &&
        r.number &&
        masterdata.normalizeNumber(r.number) === num
    );
}

// Dirops/CEO/Direksi: akses semua data divisi (cek/konsul/kendala/lapor).
const BOSS_RE = /dirops|direktur|direksi|ceo|owner|komisaris|pimpinan/i;
function isBossNumber(number) {
  const num = masterdata.normalizeNumber(number);
  if (!num) return false;
  return masterdata
    .list()
    .some(
      (r) =>
        BOSS_RE.test(`${r.divisi || ''} ${r.kadev || ''}`) &&
        r.number &&
        masterdata.normalizeNumber(r.number) === num
    );
}

function isAuthorized(number) {
  return isTeknikNumber(number) || isBossNumber(number);
}

// Skema output parser — dipaksa lewat structured output Ollama, sehingga
// model TIDAK BISA mengeluarkan format rusak / field karangan.
const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    aksi: {
      type: 'string',
      enum: ['lapor', 'cek', 'koreksi', 'konsul', 'kendala', 'bukan'],
    },
    proyek: { type: 'string' },
    blok: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'string' } },
    kategori: { type: 'array', items: { type: 'string' } },
    kendala: { type: 'string' },
    kendalaSelesai: { type: 'boolean' },
  },
  required: ['aksi', 'proyek', 'blok', 'items', 'kategori'],
};

// Audit log: setiap hasil parse dicatat (JSONL) supaya kejadian aneh bisa
// ditelusuri dan dijadikan aturan deterministik baru.
function logParse(entry) {
  if (!kendalaFile) return; // belum init
  try {
    fs.appendFileSync(
      path.join(path.dirname(kendalaFile), 'parse-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    );
  } catch (_) {}
}

// LaLa ekstrak maksud pesan → {action:'lapor'|'cek', ...} | null bila bukan
// tentang progres. "lapor" = mencatat pekerjaan selesai; "cek" = tanya progres.
async function parseReport(text, ctx) {
  const m = await loadModel();
  const ctxLine =
    ctx && ctx.proyek
      ? `KONTEKS: unit terakhir yang dibahas user = proyek ${ctx.proyek}` +
        (ctx.bloks && ctx.bloks.length ? ` blok ${ctx.bloks.join(', ')}` : '') +
        '. Bila pesan memakai rujukan ("disana", "unit itu", "lanjut", tanpa ' +
        'menyebut proyek), pakai konteks ini sebagai proyek/blok-nya.\n'
      : '';
  const sys =
    'Kamu asisten data progres pembangunan rumah Greenpark. ' +
    'Baca pesan dari tim teknik lalu keluarkan HANYA JSON valid, tanpa teks lain.\n' +
    ctxLine +
    `NAMA PROYEK valid: ${m.proyeks.join(', ')}\n` +
    `KATEGORI PEKERJAAN valid: ${m.cats.join(' | ')}\n` +
    'ITEM PEKERJAAN valid (gunakan nama PERSIS):\n' +
    m.items.map((i) => '- ' + i.name).join('\n') +
    '\n\nFormat keluaran:\n' +
    '{"aksi":"lapor|cek|koreksi|konsul|kendala|bukan","proyek":"...","blok":["..."],' +
    '"items":["..."],"kategori":["..."],"kendala":"...","kendalaSelesai":false}\n' +
    '- "aksi":"lapor" bila user MELAPORKAN pekerjaan selesai; "cek" bila user MENANYAKAN ' +
    'progres/status/data unit atau proyek (items & kategori kosongkan); "koreksi" bila user ' +
    'minta MEMBATALKAN/menghapus centang item yang ternyata belum selesai atau salah input ' +
    '(isi "items"/"kategori" dengan yang mau dihapus centangnya); "konsul" bila user ' +
    'BERDISKUSI/minta saran/membandingkan kondisi lapangan dengan data (mis. "harusnya ' +
    'sudah 90%", "apa yang harus dilakukan", "kenapa masih 0%") — bukan sekadar minta ' +
    'data atau lapor; "kendala" bila user MELAPORKAN hambatan/masalah lapangan ' +
    '(hujan terus, material telat, kurang tukang, izin, dana, dll — isi field "kendala" ' +
    'dgn deskripsi singkatnya) ATAU menyatakan kendala sudah beres (set ' +
    '"kendalaSelesai":true); "bukan" bila pesannya tidak tentang progres pembangunan.\n' +
    '- "proyek" pilih dari daftar valid (perbaiki salah eja user ke nama valid terdekat).\n' +
    '- "blok" bisa lebih dari satu; boleh kosong untuk aksi "cek" satu proyek penuh.\n' +
    '- "items" = SEMUA item yang dilaporkan selesai/terpasang, dipilih dari daftar valid. ' +
    'Teliti satu per satu, jangan ada yang terlewat (mis. "genteng dan nok selesai" = 2 item: ' +
    '"Genteng Cisangkan" dan "Nok Cisangkan").\n' +
    '- "kategori" = HANYA bila satu tahap dilaporkan selesai SEMUA ' +
    '(mis. "pondasi beton sudah beres semua" → kategori "PONDASI & BETON"); selain itu [].\n' +
    '- Laporan berupa PERSENTASE atau tahap umum TANPA item spesifik ("finishing 90%", ' +
    '"sudah 90 persen", "hampir selesai") = aksi "konsul", BUKAN "lapor" — data dicatat ' +
    'per item, bukan persen, jadi user perlu dipandu menyebutkan itemnya.\n' +
    '- Pertanyaan agregat/analitis tentang proyek ("ada yang 100% ga?", "kok 0% semua?", ' +
    '"berapa unit yang selesai?", "mana saja yang belum?") = aksi "konsul", bukan "cek".';
  // Ekstraksi data harus deterministik — temperature 0 + skema JSON dipaksa.
  const out = await ollama.chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: text },
    ],
    { options: { temperature: 0 }, format: PARSE_SCHEMA }
  );
  const jm = String(out).match(/\{[\s\S]*\}/);
  if (!jm) {
    logParse({ text, error: 'no-json', raw: String(out).slice(0, 300) });
    return null;
  }
  let data;
  try {
    data = JSON.parse(jm[0]);
  } catch (_) {
    logParse({ text, error: 'bad-json', raw: jm[0].slice(0, 300) });
    return null;
  }
  logParse({ text, parsed: data });
  const action = String(data.aksi || '').toLowerCase().trim();
  let proyek = norm(data.proyek);
  let bloks = (Array.isArray(data.blok) ? data.blok : [data.blok]).map(norm).filter(Boolean);
  // Jangan andalkan LLM utk proyek/blok — verifikasi & lengkapi deterministik.
  // LLM pernah MENGARANG daftar blok yang tidak disebut user → blok hanya sah
  // bila tertulis di pesan (scan) atau berasal dari konteks percakapan.
  if (['lapor', 'cek', 'koreksi', 'konsul', 'kendala'].includes(action)) {
    if (!proyek || !m.proyeks.some((p) => norm(p) === proyek)) {
      proyek = scanProyek(text, m) || (ctx && ctx.proyek ? norm(ctx.proyek) : proyek);
    }
    const scanned = proyek ? scanBloks(text, m, proyek).map(norm) : [];
    if (scanned.length) {
      bloks = scanned;
    } else {
      const ctxBloks =
        ctx && ctx.proyek && norm(ctx.proyek) === proyek
          ? (ctx.bloks || []).map(norm)
          : [];
      bloks = bloks.filter((b) =>
        ctxBloks.some((cb) => normBlok(cb) === normBlok(b))
      );
      if (!bloks.length && ctxBloks.length && /disana|di sana|unit itu|blok itu|lanjut/i.test(text)) {
        bloks = ctxBloks;
      }
    }
  }
  const wanted = (Array.isArray(data.items) ? data.items : []).map(norm).filter(Boolean);
  const wantedCats = (Array.isArray(data.kategori) ? data.kategori : [])
    .map(norm)
    .filter(Boolean);

  if ((action === 'cek' || action === 'konsul' || action === 'kendala') && proyek) {
    const units = m.units.filter(
      (u) =>
        norm(u.proyek) === proyek &&
        (!bloks.length || bloks.some((b) => normBlok(b) === normBlok(u.blok)))
    );
    return {
      action,
      proyek,
      bloks,
      units,
      kendala: String(data.kendala || '').trim(),
      kendalaSelesai: !!data.kendalaSelesai,
    };
  }
  if (!proyek || !bloks.length || (!wanted.length && !wantedCats.length)) return null;

  // Cocokkan kembali ke model per item: eksak dulu; substring hanya bila
  // kandidatnya tunggal (mis. "Floor Drain" JANGAN ikut mencentang
  // "Floor Drain Taman" — dua-duanya item berbeda).
  const chosen = new Map();
  for (const w of wanted) {
    let hit = m.items.find((i) => norm(i.name) === w);
    if (!hit) {
      const cands = m.items.filter((i) => {
        const n = norm(i.name);
        return n.includes(w) || w.includes(n);
      });
      if (cands.length === 1) hit = cands[0];
    }
    if (hit) chosen.set(hit.col, hit);
  }
  // Kategori selesai semua → semua item dalam kategori itu ikut dicentang.
  for (const wc of wantedCats) {
    m.items
      .filter((i) => {
        const n = norm(i.cat);
        return n && (n === wc || n.includes(wc) || wc.includes(n));
      })
      .forEach((i) => chosen.set(i.col, i));
  }
  const isKoreksi = action === 'koreksi';
  // Jaring pengaman: LLM kadang melewatkan item yang jelas-jelas disebut.
  // Pindai kata pertama nama item di teks user — hanya bila cocoknya UNIK
  // dan tidak ada kata negasi (belum/tidak/…) di sekitarnya. Untuk koreksi
  // JANGAN dipakai: kalimat koreksi wajar mengandung negasi ("genteng belum").
  if (!isKoreksi) keywordNet(text, m, chosen);
  const items = [...chosen.values()];
  const units = m.units.filter(
    (u) =>
      norm(u.proyek) === proyek &&
      bloks.some((b) => normBlok(b) === normBlok(u.blok))
  );
  if (!items.length || !units.length) {
    return { action: isKoreksi ? 'koreksi' : 'lapor', unmatched: true, proyek, bloks, wanted };
  }
  return { action: isKoreksi ? 'koreksi' : 'lapor', units, items };
}

// ---- Konsultasi (aksi "konsul") -----------------------------------------------

// Jawab diskusi/pertanyaan terbuka secara natural, grounded data sheet terkini.
async function consult(text, units, proyek, history, senderNumber, senderName) {
  let dataText = '';
  try {
    if (units && units.length) dataText = await progressDetail(units.slice(0, 2));
    else if (proyek) dataText = (await progressSummary(proyek)) || '';
  } catch (_) {}
  const exampleUnit =
    units && units.length ? unitLabel(units[0]).replace(/\s*\(.*\)$/, '') : proyek || 'CMGP B1';
  const ks =
    units && units.length
      ? units.flatMap((u) => openKendala(u.proyek, u.blok))
      : proyek
      ? openKendala(proyek, '')
      : [];
  if (ks.length) {
    dataText +=
      '\n\nKENDALA AKTIF TERCATAT:\n' + ks.map((k) => `- ${kendalaLine(k)}`).join('\n');
  }
  const sys =
    'Kamu LaLa, asisten AI Greenpark — teman satu tim, bukan robot. ' +
    toneLine(senderNumber) +
    (senderName ? ` Lawan bicaramu bernama "${senderName}" — sapa pakai nama itu.` : '') +
    ' JANGAN PERNAH menulis placeholder seperti [Nama]. ' +
    'Tanpa template kaku. HANYA Bahasa Indonesia, jangan selipkan bahasa lain. ' +
    'Paham data, rendah hati mengakui keterbatasan.\n\n' +
    (dataText
      ? 'DATA SHEET MONITORING SAAT INI (satu-satunya sumber angka, jangan mengarang):\n' +
        dataText +
        '\n\n'
      : 'Data sheet untuk unit yang dimaksud belum ketemu — minta user sebutkan ' +
        'proyek/blok yang benar.\n\n') +
    'Cara menjawab:\n' +
    '- Bila kondisi lapangan yang disebut user beda dengan data (mis. lapangan 90% ' +
    'tapi sheet 0%), jelaskan gap-nya: kemungkinan laporan belum diinput.\n' +
    `- Beri langkah KONKRET: untuk input progres kirim pesan berformat bebas yang ` +
    `menyebut proyek, blok, dan pekerjaan selesai (mis. "${exampleUnit} selesai pondasi ` +
    `dan pasangan semua, lantai granit terpasang"), lampirkan foto, lalu balas YA. ` +
    `Untuk hapus centang salah: "koreksi ${exampleUnit}, <item> belum selesai". ` +
    `Pakai proyek/blok user yang sedang dibahas di contoh, jangan proyek lain.\n` +
    '- Tahapan pembangunan urut: persiapan → pondasi/beton → pasangan/plesteran → ' +
    'atap → plafon → lantai → kusen/pintu → sanitair/instalasi → pengecatan → ' +
    'tambahan. Pakai urutan ini bila menyarankan item apa yang biasanya sudah ' +
    'selesai di persentase tertentu.\n' +
    '- Bila user menyebut persen/tahap umum ("finishing 90%"): jelaskan bahwa data ' +
    'dicatat per ITEM (bukan persen), lihat DATA di atas kategori mana yang masih kosong, ' +
    'lalu minta user sebutkan item/kategori yang sudah selesai satu per satu.\n' +
    '- Data jadwal/deadline TIDAK tersedia — jangan mengarang keterlambatan.\n' +
    '- JANGAN PERNAH bilang data/laporan "sudah tersimpan" — penyimpanan hanya lewat ' +
    'alur konfirmasi sistem (ringkasan 📋 lalu user balas YA).\n' +
    '- Singkat, langsung ke inti, boleh pakai bullet seperlunya.';
  return ollama.chat(
    [
      { role: 'system', content: sys },
      ...(history || []).slice(-6),
      { role: 'user', content: text },
    ],
    { options: { temperature: 0.4 } }
  );
}

// ---- Baca progres dari sheet (aksi "cek") -------------------------------------

// Detail per unit: total % + rekap selesai per kategori (maks 3 unit sekali tanya).
async function progressDetail(units) {
  const m = await loadModel();
  const startCol = m.items[0].col;
  const startL = gsheets.colLetter(startCol);
  const endL = gsheets.colLetter(m.totalCol);
  const out = [];
  for (const u of units.slice(0, 3)) {
    const rows = await gsheets.getValues(SHEET_ID, `'${TAB}'!${startL}${u.row}:${endL}${u.row}`);
    const row = rows[0] || [];
    const total = String(row[m.totalCol - startCol] || '0%').trim();
    const byCat = new Map();
    for (const it of m.items) {
      const done = !!String(row[it.col - startCol] || '').trim();
      const e = byCat.get(it.cat) || { done: 0, all: 0 };
      e.all++;
      if (done) e.done++;
      byCat.set(it.cat, e);
    }
    out.push(`📊 ${unitLabel(u)} — total *${total}*`);
    for (const [cat, e] of byCat) {
      const mark = e.done === e.all ? ' ✓' : e.done === 0 ? ' —' : '';
      out.push(`• ${cat}: ${e.done}/${e.all}${mark}`);
    }
    const ks = openKendala(u.proyek, u.blok);
    if (ks.length) {
      out.push(`⚠️ Kendala aktif (${ks.length}):`);
      ks.forEach((k) => out.push(`   • ${kendalaLine(k)}`));
    }
    out.push('');
  }
  if (units.length > 3) {
    out.push(`(+${units.length - 3} unit lain — tanya per blok untuk detailnya)`);
  }
  return out.join('\n').trim();
}

// Rekap satu proyek penuh dari kolom TOTAL BOBOT.
async function progressSummary(proyek) {
  const m = await loadModel();
  const units = m.units.filter((u) => norm(u.proyek) === norm(proyek));
  if (!units.length) return null;
  const colL = gsheets.colLetter(m.totalCol);
  const first = units[0].row;
  const last = units[units.length - 1].row;
  const rows = await gsheets.getValues(SHEET_ID, `'${TAB}'!${colL}${first}:${colL}${last}`);
  const doneB = [],
    runB = [],
    zeroB = [];
  let sum = 0;
  for (const u of units) {
    const raw = String((rows[u.row - first] || [])[0] || '0')
      .replace('%', '')
      .replace(',', '.');
    const p = parseFloat(raw) || 0;
    if (p >= 99.995) doneB.push(u.blok);
    else if (p > 0) runB.push(`${u.blok} (${p.toFixed(0)}%)`);
    else zeroB.push(u.blok);
    sum += p;
  }
  const lst = (arr) =>
    arr.length
      ? arr.slice(0, 25).join(', ') + (arr.length > 25 ? `, … (${arr.length})` : '')
      : '—';
  const allKs = openKendala(units[0].proyek, '');
  return (
    `📊 ${units[0].proyek} — ${units.length} unit\n` +
    `✅ Selesai 100% (${doneB.length}): ${lst(doneB)}\n` +
    `🔨 Sedang berjalan (${runB.length}): ${lst(runB)}\n` +
    `⬜ Belum mulai (${zeroB.length}): ${lst(zeroB)}\n` +
    `• Rata-rata progres: ${(sum / units.length).toFixed(1)}%\n` +
    (allKs.length
      ? `⚠️ Kendala aktif (${allKs.length}):\n` +
        allKs.slice(0, 5).map((k) => `   • ${kendalaLine(k)}`).join('\n') +
        (allKs.length > 5 ? `\n   … dan ${allKs.length - 5} lainnya` : '') +
        '\n'
      : '') +
    `\nSebut bloknya untuk rincian, mis. "cek ${units[0].proyek} ${units[0].blok}".`
  );
}

function unitLabel(u) {
  return `${u.proyek} ${u.blok}${u.tipe ? ` (T${u.tipe})` : ''}`;
}

const NEGATION = new Set(['BELUM', 'BLM', 'BLOM', 'TIDAK', 'GAK', 'GA', 'JANGAN', 'BATAL']);

// Tambahkan item yang kata pertamanya disebut eksplisit di teks (unik, tanpa
// negasi ±3 kata) tapi terlewat oleh LLM. Mis. "nok" → "Nok Cisangkan".
function keywordNet(text, m, chosen) {
  const firstWordMap = new Map();
  for (const it of m.items) {
    const fw = norm(it.name).split(' ')[0];
    if (!fw || fw.length < 2) continue;
    const arr = firstWordMap.get(fw) || [];
    arr.push(it);
    firstWordMap.set(fw, arr);
  }
  const words = norm(text).split(/[^A-Z0-9]+/).filter(Boolean);
  words.forEach((w, idx) => {
    const cands = firstWordMap.get(w);
    if (!cands || cands.length !== 1) return; // ambigu → jangan tebak
    for (let j = Math.max(0, idx - 3); j <= Math.min(words.length - 1, idx + 3); j++) {
      if (NEGATION.has(words[j])) return;
    }
    chosen.set(cands[0].col, cands[0]);
  });
}

// ---- Foto progres -------------------------------------------------------------

function sanitizeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*]/g, '-').trim();
}

function dateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function stagedPhotos(chatId) {
  const list = (photoStage.get(chatId) || []).filter(
    (p) => Date.now() - p.at < PHOTO_TTL && fs.existsSync(p.file)
  );
  photoStage.set(chatId, list);
  return list;
}

// Simpan foto masuk ke staging. Return {count, ack|null}; null bila bukan
// nomor Teknik / bukan gambar. `ack` hanya diisi di awal rentetan foto
// (jeda >10 menit) supaya tidak membalas setiap foto.
function stagePhoto({ chatId, senderNumber, media }) {
  if (!isAuthorized(senderNumber)) return null;
  if (!media || !/^image\//i.test(media.mimetype || '')) return null;
  // Event pesan gambar bisa dobel (varian @lid) → tolak konten identik.
  const hash = crypto.createHash('md5').update(media.data).digest('hex');
  const list = stagedPhotos(chatId);
  if (list.some((x) => x.hash === hash)) {
    return { count: list.length, ack: null };
  }
  const dir = path.join(FOTO_DIR, '_staging', sanitizeName(chatId));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const ext = ((media.mimetype.split('/')[1] || 'jpg').split(';')[0] || 'jpg').toLowerCase();
  const file = path.join(dir, `${dateStr(now)}_${now.getTime()}.${ext}`);
  fs.writeFileSync(file, Buffer.from(media.data, 'base64'));
  list.push({ file, at: Date.now(), hash });
  photoStage.set(chatId, list);

  let ack = null;
  const last = photoAckAt.get(chatId) || 0;
  if (Date.now() - last > ACK_GAP && !pending.has(chatId)) {
    ack =
      `📷 Foto diterima. Kirim juga laporannya (proyek, blok, pekerjaan selesai) ` +
      `supaya foto ikut tersimpan ke folder unit.`;
  }
  photoAckAt.set(chatId, Date.now());
  return { count: list.length, ack };
}

// Foto tersimpan milik satu unit — ambil folder tanggal TERBARU (maks `cap` file).
function unitPhotos(u, cap) {
  const dir = path.join(FOTO_DIR, sanitizeName(u.proyek), sanitizeName(u.blok));
  let dates = [];
  try {
    dates = fs
      .readdirSync(dir)
      .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
      .sort()
      .reverse();
  } catch (_) {
    return { files: [], date: '', totalDates: 0 };
  }
  if (!dates.length) return { files: [], date: '', totalDates: 0 };
  const latest = dates[0];
  const files = fs
    .readdirSync(path.join(dir, latest))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort()
    .slice(0, cap)
    .map((f) => path.join(dir, latest, f));
  return { files, date: latest, totalDates: dates.length };
}

// Pindahkan foto staging ke folder final tiap unit yang dilaporkan.
function movePhotos(chatId, units) {
  const list = stagedPhotos(chatId);
  if (!list.length) return { count: 0, dirs: [] };
  const day = dateStr(new Date());
  const dirs = [];
  for (const u of units) {
    const dir = path.join(FOTO_DIR, sanitizeName(u.proyek), sanitizeName(u.blok), day);
    fs.mkdirSync(dir, { recursive: true });
    for (const p of list) {
      fs.copyFileSync(p.file, path.join(dir, path.basename(p.file)));
    }
    dirs.push(dir);
  }
  for (const p of list) {
    try {
      fs.unlinkSync(p.file);
    } catch (_) {}
  }
  photoStage.delete(chatId);
  return { count: list.length, dirs };
}

// Tulis ✓ (lapor) atau kosongkan sel (koreksi), lalu baca ulang total per unit.
async function applyPending(p) {
  const value = p.mode === 'hapus' ? '' : '✓';
  const data = [];
  for (const u of p.units) {
    for (const it of p.items) {
      data.push({
        range: `'${TAB}'!${gsheets.colLetter(it.col)}${u.row}`,
        values: [[value]],
      });
    }
  }
  await gsheets.batchUpdate(SHEET_ID, data);
  const m = await loadModel();
  const totals = [];
  for (const u of p.units) {
    try {
      const v = await gsheets.getValues(
        SHEET_ID,
        `'${TAB}'!${gsheets.colLetter(m.totalCol)}${u.row}`
      );
      totals.push(`${unitLabel(u)}: ${v[0] && v[0][0] ? v[0][0] : '-'}`);
    } catch (_) {
      totals.push(unitLabel(u));
    }
  }
  return totals;
}

// Titik masuk dari main.js. Return {reply} bila pesan ini bagian alur laporan
// teknik (main mengirim balasannya), atau null agar jatuh ke auto-reply biasa.
async function handleIncoming({ body, chatId, senderNumber, senderName, history }) {
  if (!configured()) return null;
  if (!isAuthorized(senderNumber)) return null;

  const text = String(body || '').trim();

  // Perintah ganti gaya bicara: "mode lembut / kasar / bro" (atau "gaya …").
  const toneCmd = text.match(
    /^(?:mode|gaya)?\s*(lembut|halus|kasar|tegas|bro(?:\s*banget)?)\s*(?:banget|aja|dong|ya)?\s*[.!]*$/i
  );
  if (toneCmd) {
    const t = /lembut|halus/i.test(toneCmd[1])
      ? 'lembut'
      : /bro/i.test(toneCmd[1])
      ? 'bro'
      : 'kasar';
    setTone(senderNumber, t);
    const ack = {
      lembut: 'Siap, aku pakai gaya lembut ya. Ada yang bisa kubantu? 😊',
      kasar: 'Oke. Mode tegas aktif. Langsung saja — mau cek apa?',
      bro: 'Gasss bro! 🤙 Mulai sekarang santai aja. Mau ngecek proyek mana nih?',
    };
    return { reply: ack[t] };
  }

  // Dirops/CEO pertama kali chat: suruh pilih gaya bicara dulu (sekali saja).
  const numKey = masterdata.normalizeNumber(senderNumber);
  if (isBossNumber(senderNumber) && !getTone(senderNumber) && !(toneMap[numKey] || {}).asked) {
    toneMap[numKey] = { asked: true };
    saveToneFile();
    return {
      reply:
        'Halo! Sebelum lanjut, enaknya aku bicara pakai gaya apa?\n' +
        '• *LEMBUT* — halus dan sabar\n' +
        '• *KASAR* — tegas blak-blakan, langsung ke inti\n' +
        '• *BRO* — santai kayak sohib\n' +
        'Balas salah satu (mis. "mode kasar"). Bisa diganti kapan saja.',
    };
  }
  const p = pending.get(chatId);
  if (p && Date.now() > p.expires) pending.delete(chatId);
  const pf = pendingFoto.get(chatId);
  if (pf && Date.now() > pf.expires) pendingFoto.delete(chatId);

  // Konfirmasi kirim foto hasil cek sebelumnya.
  if (pendingFoto.has(chatId) && /^(foto|kirim foto|tampilkan foto|lihat foto|ya foto)\b/i.test(text)) {
    const { photos } = pendingFoto.get(chatId);
    pendingFoto.delete(chatId);
    return { reply: `📷 Mengirim ${photos.length} foto…`, photos };
  }

  // "YA"/"FOTO" tanpa ada yang menunggu — jawab pasti, JANGAN jatuh ke AI bebas
  // (pernah kejadian AI pura-pura "data tersimpan" padahal tidak ada apa-apa).
  if (!pending.has(chatId) && /^(ya|iya|y|ok|oke|yes)\s*[.!]*$/i.test(text)) {
    return {
      reply:
        'Belum ada laporan yang menunggu konfirmasi, jadi belum ada yang disimpan. ' +
        'Kirim dulu laporannya — sebut proyek, blok, dan ITEM pekerjaan yang selesai ' +
        '(mis. "VERUA A2 selesai pondasi & pasangan bata semua"). Setelah sistem ' +
        'menampilkan ringkasan "📋 Terdeteksi laporan progres", baru balas YA.',
    };
  }
  if (!pendingFoto.has(chatId) && /^(foto|kirim foto|tampilkan foto)\s*[.!]*$/i.test(text)) {
    return {
      reply:
        'Tidak ada tawaran foto yang aktif. Cek dulu unitnya (mis. "cek VERUA A2") — ' +
        'kalau ada foto tersimpan, sistem akan menawarkan lalu balas FOTO.',
    };
  }

  // "kendala … beres/selesai" ditangani deterministik — LLM sering salah
  // mengklasifikasikan kalimat penyelesaian kendala.
  if (/kendala/i.test(text) && /(beres|selesai|teratasi|kelar|aman|clear)/i.test(text)) {
    const m2 = await loadModel();
    const ctx2 = lastCtx.get(chatId);
    const proyek2 = scanProyek(text, m2) || (ctx2 ? norm(ctx2.proyek) : '');
    if (proyek2) {
      let bloks2 = scanBloks(text, m2, proyek2).map(norm);
      if (!bloks2.length && ctx2 && norm(ctx2.proyek) === proyek2) {
        bloks2 = (ctx2.bloks || []).map(norm);
      }
      return { reply: closeKendala(proyek2, bloks2) };
    }
  }

  if (pending.has(chatId)) {
    if (/^(ya|y|iya|ok|oke|yes|betul|benar)\b/i.test(text)) {
      const cur = pending.get(chatId);
      pending.delete(chatId);
      const totals = await applyPending(cur);
      const isHapus = cur.mode === 'hapus';
      let fotoLine = '';
      if (!isHapus) {
        const fotos = movePhotos(chatId, cur.units);
        fotoLine = fotos.count
          ? `\n📷 ${fotos.count} foto tersimpan di:\n` +
            fotos.dirs.map((d) => `  ${d}`).join('\n')
          : `\n⚠️ Belum ada foto untuk progres ini — kirim fotonya menyusul ya.`;
      }
      return {
        reply:
          (isHapus
            ? `✅ Koreksi tersimpan — centang dihapus dari sheet monitoring.\n`
            : `✅ Tersimpan ke sheet monitoring.\n`) +
          `${cur.items.length} item ${isHapus ? 'dihapus centangnya' : 'dicentang'} untuk ${cur.units.length} unit.\n` +
          `Progres sekarang:\n` +
          totals.map((t) => `• ${t}`).join('\n') +
          fotoLine,
      };
    }
    if (/^(batal|tidak|no|gak|ga|jangan|cancel)\b/i.test(text)) {
      pending.delete(chatId);
      return { reply: '❌ Dibatalkan. Tidak ada yang ditulis ke sheet.' };
    }
    // bukan jawaban konfirmasi — coba parse sebagai laporan baru di bawah
  }

  const parsed = await parseReport(text, lastCtx.get(chatId));
  if (!parsed) return null; // bukan laporan progres → auto-reply biasa
  if (parsed.proyek || (parsed.units && parsed.units.length)) {
    lastCtx.set(chatId, {
      proyek: parsed.units && parsed.units.length ? parsed.units[0].proyek : parsed.proyek,
      bloks:
        parsed.units && parsed.units.length
          ? [...new Set(parsed.units.map((u) => u.blok))]
          : parsed.bloks || [],
      at: Date.now(),
    });
  }

  if (parsed.action === 'kendala') {
    const blokLabel = parsed.bloks.length ? ` ${parsed.bloks.join(', ')}` : '';
    if (parsed.kendalaSelesai) {
      return { reply: closeKendala(parsed.proyek, parsed.bloks) };
    }
    if (!parsed.kendala) {
      const list = parsed.bloks.length
        ? parsed.bloks.flatMap((b) => openKendala(parsed.proyek, b))
        : openKendala(parsed.proyek, '');
      return {
        reply: list.length
          ? `⚠️ Kendala aktif ${parsed.proyek}${blokLabel}:\n` +
            list.map((k) => `• ${kendalaLine(k)}`).join('\n')
          : `Tidak ada kendala aktif tercatat untuk ${parsed.proyek}${blokLabel}.`,
      };
    }
    const bloksToSave = parsed.bloks.length ? parsed.bloks : [''];
    for (const b of bloksToSave) {
      kendalaList.push({
        id: `k${Date.now()}${Math.floor(Math.random() * 1000)}`,
        proyek: parsed.proyek,
        blok: b,
        text: parsed.kendala,
        at: Date.now(),
        status: 'open',
      });
    }
    saveKendalaFile();
    const totalOpen = parsed.bloks.length
      ? parsed.bloks.flatMap((b) => openKendala(parsed.proyek, b)).length
      : openKendala(parsed.proyek, '').length;
    return {
      reply:
        `📝 Kendala tercatat untuk ${parsed.proyek}${blokLabel}:\n"${parsed.kendala}"\n` +
        `Total kendala aktif: ${totalOpen}. Bila sudah beres, kabari: ` +
        `"kendala ${parsed.proyek}${blokLabel} sudah selesai".`,
    };
  }

  if (parsed.action === 'konsul') {
    const reply = await consult(text, parsed.units, parsed.proyek, history, senderNumber, senderName);
    return reply ? { reply } : null;
  }

  if (parsed.action === 'cek') {
    // Blok disebut → detail per unit + foto tersimpan; tanpa blok → rekap proyek.
    if (parsed.bloks.length && parsed.units.length) {
      const reply = await progressDetail(parsed.units);
      const photos = [];
      const per = parsed.units.length > 1 ? 3 : 5;
      for (const u of parsed.units.slice(0, 3)) {
        const ph = unitPhotos(u, per);
        ph.files.forEach((f, i) =>
          photos.push({
            path: f,
            caption: `📷 ${unitLabel(u)} — ${ph.date} (${i + 1}/${ph.files.length})`,
          })
        );
      }
      // Foto tidak langsung dikirim — tawarkan dulu, kirim setelah balas FOTO.
      if (photos.length) {
        pendingFoto.set(chatId, { photos, expires: Date.now() + PENDING_TTL });
        return {
          reply:
            reply +
            `\n\n📷 Ada ${photos.length} foto tersimpan untuk unit ini. ` +
            `Balas *FOTO* untuk menampilkannya.`,
        };
      }
      return { reply: reply + '\n\n(📷 belum ada foto tersimpan untuk unit ini)' };
    }
    // Blok disebut tapi tidak ketemu → JANGAN jatuh ke rekap proyek (bikin
    // bingung); beri tahu bloknya tidak ada + daftar blok yang terdaftar.
    if (parsed.bloks.length && !parsed.units.length) {
      const m2 = await loadModel();
      const bloksOf = m2.units
        .filter((u) => norm(u.proyek) === norm(parsed.proyek))
        .map((u) => u.blok);
      return {
        reply:
          `⚠️ Blok ${parsed.bloks.join(', ')} tidak ketemu di ${parsed.proyek}.` +
          (bloksOf.length
            ? `\nBlok terdaftar di ${parsed.proyek}: ${bloksOf.slice(0, 30).join(', ')}` +
              (bloksOf.length > 30 ? `, … (${bloksOf.length} blok)` : '')
            : ''),
      };
    }
    const summary = await progressSummary(parsed.proyek);
    if (summary) return { reply: summary };
    const m = await loadModel();
    return {
      reply:
        `⚠️ Proyek/unit tidak ketemu di sheet monitoring.\n` +
        `Proyek yang ada: ${m.proyeks.join(', ')}`,
    };
  }

  if (parsed.unmatched) {
    return {
      reply:
        `⚠️ Laporan terbaca (proyek: ${parsed.proyek}, blok: ${parsed.bloks.join(', ')}) ` +
        `tapi tidak ketemu unit/item yang cocok di sheet monitoring. ` +
        `Cek penulisan nama proyek/blok/item lalu kirim ulang.`,
    };
  }

  const isHapus = parsed.action === 'koreksi';
  pending.set(chatId, {
    units: parsed.units,
    items: parsed.items,
    mode: isHapus ? 'hapus' : 'tulis',
    expires: Date.now() + PENDING_TTL,
  });
  const names = parsed.items.map((i) => `• ${i.name}`);
  const shown =
    names.length > 15
      ? names.slice(0, 15).concat(`… dan ${names.length - 15} item lainnya`)
      : names;
  if (isHapus) {
    return {
      reply:
        `✏️ Terdeteksi permintaan koreksi (hapus centang):\n` +
        `Unit: ${parsed.units.map(unitLabel).join(', ')}\n` +
        `Item yang dihapus centangnya (${parsed.items.length}):\n` +
        shown.join('\n') +
        `\n\nBalas *YA* untuk koreksi sheet monitoring, atau *BATAL*.`,
    };
  }
  const staged = stagedPhotos(chatId).length;
  const fotoLine = staged
    ? `\n📷 Foto terlampir: ${staged}`
    : `\n⚠️ Belum ada foto — kirim foto progresnya juga ya (wajib per progres).`;
  return {
    reply:
      `📋 Terdeteksi laporan progres:\n` +
      `Unit: ${parsed.units.map(unitLabel).join(', ')}\n` +
      `Item selesai (${parsed.items.length}):\n` +
      shown.join('\n') +
      fotoLine +
      `\n\nBalas *YA* untuk centang ke sheet monitoring, atau *BATAL*.`,
  };
}

module.exports = {
  init,
  configured,
  handleIncoming,
  stagePhoto,
  movePhotos,
  getTone,
  toneLine,
  isBossNumber,
  FOTO_DIR,
};

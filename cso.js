'use strict';

// ── CSO (Customer Complaint) ↔ WhatsApp bridge ──────────────────────────────
// Menghubungkan alur komplain ke WhatsApp, dua arah:
//   MASUK  : pesan WA berawalan "#komplain" (atau "komplain:") dari konsumen →
//            dibuatkan tiket di backend CSO (:8088), lalu dibalas ack sesuai SOP
//            Step 1 (DENGAR, SLA ≤1 jam, wajib Ticket ID).
//   KELUAR : rekap harian + alert SLA (dari /api/alerts) dikirim ke nomor/grup
//            target yang di-set di konfigurasi.
//
// Konfigurasi disimpan di <userData>/cso-config.json. Tanpa dependency tambahan
// (pakai global fetch bawaan Electron/Node).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  apiBase: process.env.CSO_API || 'http://localhost:8088',
  user: 'admin',
  pass: 'admin123',
  alertTarget: '', // nomor WA (628xx) atau chatId grup (…@g.us) tujuan rekap/alert
  recapEnabled: false,
  recapHour: 8, // jam rekap harian (0-23, waktu lokal)
};

let cfg = { ...DEFAULTS };
let configPath = '';
let token = '';
let lastRecapDate = ''; // "YYYY-MM-DD" — cegah rekap dobel di hari sama

// ---- lifecycle -------------------------------------------------------------

async function init(userData) {
  configPath = path.join(userData || '.', 'cso-config.json');
  try {
    if (fs.existsSync(configPath)) {
      cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } else {
      save();
    }
  } catch (err) {
    console.error('[cso] gagal baca config:', err.message);
  }
  console.log('[cso] siap · API', cfg.apiBase, '· target', cfg.alertTarget || '(belum di-set)');
}

function save() {
  try {
    if (configPath) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[cso] gagal tulis config:', err.message);
  }
}

function getConfig() {
  return { ...cfg };
}

function setConfig(patch) {
  cfg = { ...cfg, ...(patch || {}) };
  save();
  return getConfig();
}

// true bila alur intake aktif (butuh apiBase). Selalu true saat apiBase ada.
function configured() {
  return !!cfg.apiBase;
}

// ---- backend calls ---------------------------------------------------------

async function login() {
  const res = await fetch(`${cfg.apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  if (!res.ok) throw new Error(`login CSO ${res.status}`);
  const data = await res.json();
  token = data.token || '';
  return token;
}

// Panggil API dengan bearer token; auto-login sekali bila 401 / belum ada token.
async function apiFetch(pathname, opts = {}, retried = false) {
  if (!token) await login();
  const res = await fetch(`${cfg.apiBase}${pathname}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retried) {
    token = '';
    return apiFetch(pathname, opts, true);
  }
  if (!res.ok) throw new Error(`CSO ${pathname} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.status === 204 ? null : res.json();
}

async function createTicket(input) {
  return apiFetch('/api/tickets', { method: 'POST', body: JSON.stringify(input) });
}

async function getAlert() {
  return apiFetch('/api/alerts', { method: 'GET' });
}

// ---- INBOUND: pesan WA → tiket komplain ------------------------------------

// Trigger eksplisit supaya TIDAK bentrok dengan chat biasa / laporan teknik.
const TRIGGER = /^\s*(#?komplain|lapor\s+komplain)\b[:\-\s]*/i;

function isComplaint(body) {
  return typeof body === 'string' && TRIGGER.test(body);
}

// Ekstrak field ringan dari teks bebas. Format bebas; yang penting deskripsi.
// Contoh: "#komplain unit A12 proyek Le Hauz Cibubur: rembesan di plafon".
function parseComplaint(body, senderName) {
  const text = body.replace(TRIGGER, '').trim();
  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const unit = grab(/\bunit\s+([A-Za-z0-9\-\/]+)/i);
  const proyek = grab(/\bproyek\s+([^:,\n]+?)(?=[:,\n]|$)/i);
  // Deskripsi = setelah ":" bila ada, else seluruh sisa teks.
  const colon = text.indexOf(':');
  const deskripsi = (colon >= 0 ? text.slice(colon + 1) : text).trim() || text;
  return {
    nama: senderName || '',
    unit,
    proyek,
    deskripsi,
    source: 'WhatsApp',
  };
}

// handleIncoming: dipanggil main.js untuk tiap pesan chat pribadi. Mengembalikan
// { reply } bila pesan adalah komplain (sudah dibuatkan tiket), atau null bila
// bukan (biar main.js lanjut ke handler lain).
async function handleIncoming({ body, senderName }) {
  if (!configured() || !isComplaint(body)) return null;
  try {
    const input = parseComplaint(body, senderName);
    const t = await createTicket(input);
    const reply =
      `✅ Komplain Anda TERCATAT.\n` +
      `No. Tiket: *${t.id}*\n` +
      `Klasifikasi: ${t.klasifikasi} · Target: ${t.sla}\n` +
      (t.proyek ? `Proyek: ${t.proyek}\n` : '') +
      (t.unit ? `Unit: ${t.unit}\n` : '') +
      `\nTim CSO Greenpark akan menindaklanjuti. Simpan nomor tiket ini untuk memantau progres. 🙏`;
    return { reply, ticket: t };
  } catch (err) {
    console.error('[cso] createTicket gagal:', err.message);
    return {
      reply: '⚠️ Maaf, sistem komplain sedang sibuk. Mohon coba lagi beberapa saat, atau hubungi CSO Greenpark.',
    };
  }
}

// ---- OUTBOUND: rekap harian + alert SLA ------------------------------------

// tick: dipanggil scheduler main.js tiap ~30 dtk. Kirim rekap harian ke target
// saat jam rekap tiba (sekali per hari). sendToNumber(number, message).
async function tick(now, sendToNumber) {
  if (!cfg.recapEnabled || !cfg.alertTarget || !configured()) return null;
  const d = now || new Date();
  const ymd = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  if (d.getHours() < Number(cfg.recapHour) || lastRecapDate === ymd) return null;
  lastRecapDate = ymd;
  try {
    const alert = await getAlert();
    if (alert && alert.message) {
      await sendToNumber(cfg.alertTarget, alert.message);
      return { sent: cfg.alertTarget, slaBelow: alert.slaBelow };
    }
  } catch (err) {
    console.error('[cso] rekap gagal:', err.message);
  }
  return null;
}

// broadcastNow: kirim alert/rekap sekarang juga (tombol uji dari UI).
async function broadcastNow(sendToNumber, targetOverride) {
  const target = targetOverride || cfg.alertTarget;
  if (!target) throw new Error('Target WA belum di-set');
  const alert = await getAlert();
  await sendToNumber(target, alert.message);
  return { sent: target, headline: alert.headline };
}

module.exports = {
  init,
  configured,
  getConfig,
  setConfig,
  handleIncoming,
  isComplaint,
  tick,
  broadcastNow,
  getAlert,
};

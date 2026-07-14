'use strict';

// ── Keuangan (Purchasing PR/PO) → WhatsApp bridge ───────────────────────────
// Menghubungkan INPUTAN pengadaan (Purchase Request / Purchase Order) dari
// backend keuangan (:8084) ke WhatsApp. Arahnya KELUAR (notifikasi):
//   Saat ada PR/PO baru masuk berstatus "pending" (butuh persetujuan), modul ini
//   mengirim notifikasi WA ke approver yang berwenang. Approver ditentukan dari
//   TIER dokumen:
//     - PR pending          → kadep / dirops (nomor dari Master Data karyawan)
//     - PO tier "kadep"     → kadep / dirops
//     - PO tier "dirops"    → dirops
//   Nomor approver diambil dari master data karyawan backend (field telepon,
//   dicocokkan dgn role). Bisa juga ditambah `alertTarget` tetap (grup/nomor)
//   yang selalu menerima semua notifikasi.
//
// Konfigurasi disimpan di <userData>/keuangan-config.json. Tanpa dependency
// tambahan (pakai global fetch bawaan Electron/Node).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  apiBase: process.env.FINANCE_API || 'http://localhost:8084',
  user: process.env.FINANCE_USER || 'admin',
  pass: process.env.FINANCE_PASS || 'admin123',
  alertTarget: '', // nomor WA (628xx) atau chatId grup (…@g.us) yang SELALU dinotif
  routeToApprover: true, // kirim juga ke nomor approver (dari master karyawan)
  enabled: true, // aktifkan polling + notifikasi
  pollSec: 60, // interval cek pending (detik)
};

let cfg = { ...DEFAULTS };
let configPath = '';
let token = '';
// ID dokumen yang sudah pernah dinotif → cegah kirim ganda. Di-seed dari state
// awal saat init supaya PR/PO pending yang sudah lama TIDAK diblast ulang.
const notifiedPR = new Set();
const notifiedPO = new Set();
let seeded = false;
let lastPoll = 0;

// ---- lifecycle -------------------------------------------------------------

async function init(userData) {
  configPath = path.join(userData || '.', 'keuangan-config.json');
  try {
    if (fs.existsSync(configPath)) {
      cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } else {
      save();
    }
  } catch (err) {
    console.error('[keuangan] gagal baca config:', err.message);
  }
  console.log(
    '[keuangan] siap · API', cfg.apiBase,
    '· target', cfg.alertTarget || '(approver otomatis)',
    '· enabled', cfg.enabled
  );
}

function save() {
  try {
    if (configPath) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error('[keuangan] gagal tulis config:', err.message);
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

function configured() {
  return !!cfg.apiBase && cfg.enabled;
}

// ---- backend calls ---------------------------------------------------------

async function login() {
  const res = await fetch(`${cfg.apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cfg.user, password: cfg.pass }),
  });
  if (!res.ok) throw new Error(`login keuangan ${res.status}`);
  const data = await res.json();
  token = data.token || '';
  return token;
}

// Panggil API dengan bearer token; auto-login sekali bila 401 / belum ada token.
async function apiFetch(pathname, opts = {}, retried = false) {
  if (!token) await login();
  const res = await fetch(`${cfg.apiBase}${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && !retried) {
    token = '';
    return apiFetch(pathname, opts, true);
  }
  if (!res.ok) {
    throw new Error(`keuangan ${pathname} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.status === 204 ? null : res.json();
}

function pendingPRs() {
  return apiFetch('/api/pr?status=pending', { method: 'GET' });
}
function pendingPOs() {
  return apiFetch('/api/po?status=pending', { method: 'GET' });
}
function karyawanList() {
  return apiFetch('/api/karyawan', { method: 'GET' });
}

// ---- formatting ------------------------------------------------------------

function rupiah(n) {
  const v = Number(n) || 0;
  return 'Rp ' + v.toLocaleString('id-ID');
}

function prMessage(pr) {
  const items = (pr.items || [])
    .slice(0, 8)
    .map((it) => `• ${it.nama || '-'} — ${it.qty || 0} ${it.satuan || ''}`.trim())
    .join('\n');
  const more = (pr.items || []).length > 8 ? `\n…dan ${pr.items.length - 8} item lain` : '';
  return (
    `🧾 *PENGAJUAN PR BARU* — butuh persetujuan\n` +
    `No: *${pr.nomor || pr.id}*\n` +
    (pr.requestBy ? `Pemohon: ${pr.requestBy}${pr.dept ? ` (${pr.dept})` : ''}\n` : '') +
    (pr.proyek ? `Proyek: ${pr.proyek}\n` : '') +
    (pr.dateRequired ? `Dibutuhkan: ${pr.dateRequired}\n` : '') +
    (items ? `\nItem:\n${items}${more}\n` : '') +
    (pr.catatan ? `\nCatatan: ${pr.catatan}\n` : '') +
    `\nBuka dashboard Keuangan → Purchasing untuk menyetujui / menolak.`
  );
}

function poMessage(po) {
  const items = (po.items || [])
    .slice(0, 8)
    .map((it) => `• ${it.nama || '-'} — ${it.qty || 0} ${it.satuan || ''} @ ${rupiah(it.hargaSatuan)}`.trim())
    .join('\n');
  const more = (po.items || []).length > 8 ? `\n…dan ${po.items.length - 8} item lain` : '';
  const tierLabel = po.tier === 'dirops' ? 'Direktur Operasional' : po.tier === 'kadep' ? 'Kepala Departemen' : po.tier;
  return (
    `📦 *PENGAJUAN PO BARU* — butuh persetujuan\n` +
    `No: *${po.nomor || po.id}*\n` +
    (po.prNomor ? `Ref PR: ${po.prNomor}\n` : '') +
    (po.supplier ? `Supplier: ${po.supplier}\n` : '') +
    (po.proyek ? `Proyek: ${po.proyek}\n` : '') +
    `Total: *${rupiah(po.total)}*\n` +
    `Persetujuan: ${tierLabel}\n` +
    (items ? `\nItem:\n${items}${more}\n` : '') +
    `\nBuka dashboard Keuangan → Purchasing untuk menyetujui / menolak.`
  );
}

// ---- approver routing ------------------------------------------------------

// Role yang berwenang menyetujui, per konteks dokumen (selaras validatePOTier
// di backend: kadep bisa approve tier kadep, dirops approve keduanya).
function rolesFor(kind, tier) {
  if (kind === 'PO' && tier === 'dirops') return ['dirops', 'ceo', 'super'];
  // PR pending, atau PO tier kadep → kadep ke atas.
  return ['kadep', 'dirops', 'ceo', 'super'];
}

// Kembalikan daftar nomor tujuan (approver + alertTarget), sudah dedup.
async function recipientsFor(kind, tier, karyawan) {
  const out = new Set();
  if (cfg.alertTarget) out.add(cfg.alertTarget);
  if (cfg.routeToApprover) {
    const roles = rolesFor(kind, tier);
    for (const k of karyawan || []) {
      const role = String(k.role || '').toLowerCase().trim();
      const tel = String(k.telepon || '').trim();
      if (tel && roles.includes(role)) out.add(tel);
    }
  }
  return [...out];
}

// ---- polling / notifikasi --------------------------------------------------

// tick: dipanggil scheduler main.js. Cek PR/PO pending; kirim notifikasi untuk
// dokumen yang BELUM pernah dinotif. sendToNumber(number, message).
async function tick(now, sendToNumber) {
  if (!configured()) return null;
  const t = (now || new Date()).getTime();
  if (t - lastPoll < Number(cfg.pollSec) * 1000) return null;
  lastPoll = t;

  let prs = [];
  let pos = [];
  try {
    [prs, pos] = await Promise.all([pendingPRs(), pendingPOs()]);
  } catch (err) {
    console.error('[keuangan] poll gagal:', err.message);
    return null;
  }

  // Seed awal: tandai semua pending yang sudah ada sebagai "sudah dinotif"
  // supaya start-up tidak membanjiri approver dgn backlog lama.
  if (!seeded) {
    for (const p of prs || []) notifiedPR.add(p.id);
    for (const p of pos || []) notifiedPO.add(p.id);
    seeded = true;
    return null;
  }

  const freshPR = (prs || []).filter((p) => !notifiedPR.has(p.id));
  const freshPO = (pos || []).filter((p) => !notifiedPO.has(p.id));
  if (!freshPR.length && !freshPO.length) return null;

  let karyawan = [];
  try {
    karyawan = await karyawanList();
  } catch (err) {
    console.error('[keuangan] ambil karyawan gagal:', err.message);
  }

  const sent = [];
  for (const pr of freshPR) {
    const targets = await recipientsFor('PR', '', karyawan);
    const msg = prMessage(pr);
    for (const to of targets) {
      try {
        await sendToNumber(to, msg);
        sent.push({ target: to, doc: pr.nomor || pr.id, kind: 'PR' });
      } catch (err) {
        console.error('[keuangan] kirim PR ke', to, 'gagal:', err.message);
      }
    }
    notifiedPR.add(pr.id);
  }
  for (const po of freshPO) {
    const targets = await recipientsFor('PO', po.tier, karyawan);
    const msg = poMessage(po);
    for (const to of targets) {
      try {
        await sendToNumber(to, msg);
        sent.push({ target: to, doc: po.nomor || po.id, kind: 'PO' });
      } catch (err) {
        console.error('[keuangan] kirim PO ke', to, 'gagal:', err.message);
      }
    }
    notifiedPO.add(po.id);
  }
  return sent.length ? sent : null;
}

// broadcastNow: kirim ringkasan semua PR/PO pending SEKARANG ke target (uji dari
// UI). Mengabaikan set "sudah dinotif".
async function broadcastNow(sendToNumber, targetOverride) {
  const target = targetOverride || cfg.alertTarget;
  if (!target) throw new Error('Target WA belum di-set');
  const [prs, pos] = await Promise.all([pendingPRs(), pendingPOs()]);
  let n = 0;
  for (const pr of prs || []) {
    await sendToNumber(target, prMessage(pr));
    n++;
  }
  for (const po of pos || []) {
    await sendToNumber(target, poMessage(po));
    n++;
  }
  if (n === 0) await sendToNumber(target, '✅ Tidak ada PR/PO pending saat ini.');
  return { sent: target, count: n };
}

// status: ringkas jumlah pending (untuk indikator UI).
async function status() {
  const [prs, pos] = await Promise.all([pendingPRs(), pendingPOs()]);
  return { pendingPR: (prs || []).length, pendingPO: (pos || []).length };
}

module.exports = {
  init,
  configured,
  getConfig,
  setConfig,
  tick,
  broadcastNow,
  status,
};

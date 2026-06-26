'use strict';

// Reminder WA: kirim pesan ke kontak (target master data atau nomor manual)
// pada waktu tertentu. Penyimpanan: PostgreSQL (tabel wa_reminders) bila
// WA_DATABASE_URL di-set, jika tidak fallback userData/reminders.json.
// Read (list/due) sinkron dari cache; write (save/remove/markSent) async.
//
//   { id, targetId, number, divisi, kadev, message,
//     mode: 'once'|'daily', at, enabled, lastSentDay, done }

const fs = require('fs');
const path = require('path');
const db = require('./db');

let filePath = null;
let cache = [];

function rowFromDb(r) {
  return {
    id: r.id,
    targetId: r.target_id,
    number: r.number,
    divisi: r.divisi,
    kadev: r.kadev,
    message: r.message,
    mode: r.mode,
    at: r.at,
    enabled: r.enabled,
    lastSentDay: r.last_sent_day,
    done: r.done,
  };
}

async function init(userDataDir) {
  filePath = path.join(userDataDir, 'reminders.json');
  if (db.isReady()) {
    const { rows } = await db.query('SELECT * FROM wa_reminders ORDER BY id');
    cache = rows.map(rowFromDb);
    return;
  }
  if (!fs.existsSync(filePath)) writeFile([]);
  cache = readFile();
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (_) {
    return [];
  }
}

function writeFile(rows) {
  fs.writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf-8');
}

async function dbUpsert(r) {
  await db.query(
    `INSERT INTO wa_reminders
       (id, target_id, number, divisi, kadev, message, mode, at, enabled, last_sent_day, done)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       target_id=$2, number=$3, divisi=$4, kadev=$5, message=$6, mode=$7,
       at=$8, enabled=$9, last_sent_day=$10, done=$11`,
    [
      r.id, r.targetId, r.number, r.divisi, r.kadev, r.message, r.mode,
      r.at, r.enabled, r.lastSentDay, r.done,
    ]
  );
}

async function persistAll() {
  if (!db.isReady()) writeFile(cache);
}

function list() {
  return cache;
}

async function save(row) {
  const clean = {
    id: row.id || `rem-${Date.now()}-${cache.length}`,
    targetId: row.targetId || '',
    number: String(row.number || '').replace(/[^\d]/g, ''),
    divisi: String(row.divisi || '').trim(),
    kadev: String(row.kadev || '').trim(),
    message: String(row.message || '').trim(),
    mode: row.mode === 'daily' ? 'daily' : 'once',
    at: String(row.at || '').trim(),
    enabled: row.enabled !== false,
    lastSentDay: row.lastSentDay || '',
    done: !!row.done,
  };
  const idx = cache.findIndex((r) => r.id === clean.id);
  if (idx >= 0) cache[idx] = clean;
  else cache.push(clean);
  if (db.isReady()) await dbUpsert(clean);
  else await persistAll();
  return clean;
}

async function remove(id) {
  cache = cache.filter((r) => r.id !== id);
  if (db.isReady()) await db.query('DELETE FROM wa_reminders WHERE id = $1', [id]);
  else await persistAll();
  return cache;
}

// Dua helper waktu lokal.
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Reminder yang jatuh tempo pada `now` (Date). Tidak mengubah state.
function due(rows, now) {
  const today = dayKey(now);
  const nowMin = hhmm(now);
  return rows.filter((r) => {
    if (!r.enabled || !r.message || (!r.number && !r.targetId)) return false;
    if (r.mode === 'daily') return r.at === nowMin && r.lastSentDay !== today;
    if (r.done) return false;
    const t = new Date(r.at);
    return !isNaN(t) && t <= now;
  });
}

// Tandai sudah terkirim (mutasi cache + persist).
async function markSent(id, now) {
  const r = cache.find((x) => x.id === id);
  if (!r) return;
  if (r.mode === 'daily') r.lastSentDay = dayKey(now);
  else r.done = true;
  if (db.isReady()) await dbUpsert(r);
  else await persistAll();
}

// Satu siklus scheduler: kirim semua yang due. sendFn(number,message)->Promise.
async function tick(now, sendFn, resolveNumber) {
  const items = due(cache, now);
  const sent = [];
  for (const r of items) {
    let number = r.number;
    if (!number && r.targetId && resolveNumber) number = resolveNumber(r.targetId);
    if (!number) continue;
    try {
      await sendFn(number, r.message);
      await markSent(r.id, now);
      sent.push(r.id);
    } catch (_) {
      // gagal kirim -> coba lagi siklus berikutnya
    }
  }
  return sent;
}

module.exports = { init, list, save, remove, due, markSent, tick, dayKey, hhmm };

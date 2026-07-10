'use strict';

// Master data divisi: { id, divisi, kadev (kepala divisi), number }.
// Penyimpanan: PostgreSQL bila WA_DATABASE_URL di-set (tabel wa_masterdata),
// jika tidak fallback ke userData/masterdata.json. Seed awal dari
// seed-masterdata.json (divisi greenpark) saat tabel/file kosong.
//
// Read (list) bersifat sinkron dari cache memori; write (save/remove) menulis
// ke cache + persist (DB/file) dan bersifat async.

const fs = require('fs');
const path = require('path');
const db = require('./db');

let filePath = null;
let seedPath = null;
let cache = [];

function loadSeed() {
  try {
    return JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  } catch (_) {
    return [];
  }
}

async function init(userDataDir, appDir) {
  filePath = path.join(userDataDir, 'masterdata.json');
  seedPath = path.join(appDir, 'seed-masterdata.json');

  if (db.isReady()) {
    const { rows } = await db.query(
      'SELECT id, divisi, kadev, number FROM wa_masterdata ORDER BY ord, id'
    );
    if (rows.length === 0) {
      const seed = loadSeed();
      for (let i = 0; i < seed.length; i++) await dbUpsert(seed[i], i);
      cache = loadSeed();
    } else {
      cache = rows.map((r) => ({ id: r.id, divisi: r.divisi, kadev: r.kadev, number: r.number }));
    }
    return;
  }

  // ---- fallback file JSON ----
  if (!fs.existsSync(filePath)) writeFile(loadSeed());
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

async function dbUpsert(row, ord) {
  await db.query(
    `INSERT INTO wa_masterdata (id, divisi, kadev, number, ord)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET divisi=$2, kadev=$3, number=$4`,
    [row.id, row.divisi || '', row.kadev || '', row.number || '', ord || 0]
  );
}

async function persist() {
  if (!db.isReady()) writeFile(cache);
}

function normalizeNumber(raw) {
  let n = String(raw || '').replace(/[^\d]/g, '');
  if (!n) return '';
  if (n.startsWith('0')) n = '62' + n.slice(1);
  else if (n.startsWith('8')) n = '62' + n; // ditulis tanpa 0/62 (mis. 8784…)
  if (n.startsWith('620')) n = '62' + n.slice(3);
  return n;
}

function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

function list() {
  return cache;
}

async function save(row) {
  const clean = {
    id: row.id || `${slug(row.divisi)}-${cache.length + 1}`,
    divisi: String(row.divisi || '').trim(),
    kadev: String(row.kadev || '').trim(),
    number: normalizeNumber(row.number),
  };
  const idx = cache.findIndex((r) => r.id === clean.id);
  if (idx >= 0) cache[idx] = clean;
  else cache.push(clean);
  if (db.isReady()) await dbUpsert(clean, idx >= 0 ? idx : cache.length);
  else await persist();
  return clean;
}

async function remove(id) {
  cache = cache.filter((r) => r.id !== id);
  if (db.isReady()) await db.query('DELETE FROM wa_masterdata WHERE id = $1', [id]);
  else await persist();
  return cache;
}

module.exports = { init, list, save, remove, normalizeNumber };

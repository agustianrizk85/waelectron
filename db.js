'use strict';

// Lapisan PostgreSQL untuk WA Electron. Pola sama dengan backend greenpark:
// kalau DSN di-set (WA_DATABASE_URL), pakai Postgres; kalau tidak, modul data
// fallback ke file JSON di userData.
//
// DSN default menunjuk ke database khusus `waelectron` di server lokal. Set
// WA_DATABASE_URL di .env untuk override (host/user/password/db).

const { Pool } = require('pg');

const DSN = (process.env.WA_DATABASE_URL || process.env.DATABASE_URL || '').trim();

let pool = null;
let ready = false;

function configured() {
  return !!DSN;
}

// Buat database `waelectron` bila belum ada (connect ke db `postgres` dulu).
// Hanya jalan untuk DSN yang menunjuk db waelectron di server lokal; aman
// di-skip kalau gagal (mis. DSN custom yang dbnya sudah ada).
async function ensureDatabase() {
  let target;
  try {
    target = new URL(DSN);
  } catch (_) {
    return; // DSN format aneh -> biar connect utama yang error
  }
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, '')) || 'waelectron';
  const adminUrl = new URL(DSN);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (r.rowCount === 0) {
      // identifier tak bisa diparameter -> validasi ketat lalu interpolasi.
      if (!/^[a-zA-Z0-9_]+$/.test(dbName)) throw new Error('nama db tidak valid');
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_masterdata (
  id      TEXT PRIMARY KEY,
  divisi  TEXT NOT NULL DEFAULT '',
  kadev   TEXT NOT NULL DEFAULT '',
  number  TEXT NOT NULL DEFAULT '',
  ord     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_reminders (
  id           TEXT PRIMARY KEY,
  target_id    TEXT NOT NULL DEFAULT '',
  number       TEXT NOT NULL DEFAULT '',
  divisi       TEXT NOT NULL DEFAULT '',
  kadev        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL DEFAULT 'once',
  at           TEXT NOT NULL DEFAULT '',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  last_sent_day TEXT NOT NULL DEFAULT '',
  done         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS wa_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
`;

// Connect + migrate. Mengembalikan true bila Postgres siap dipakai.
async function init() {
  if (!configured()) return false;
  await ensureDatabase();
  pool = new Pool({ connectionString: DSN, max: 4 });
  await pool.query(SCHEMA);
  ready = true;
  return true;
}

function isReady() {
  return ready;
}

function query(text, params) {
  if (!pool) throw new Error('DB belum siap');
  return pool.query(text, params);
}

async function close() {
  if (pool) await pool.end().catch(() => {});
  pool = null;
  ready = false;
}

module.exports = { configured, init, isReady, query, close, DSN };

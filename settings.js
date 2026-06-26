'use strict';

// Settings app: konfigurasi AI (Ollama) + auto-reply. Penyimpanan: PostgreSQL
// (tabel wa_settings, key 'ai', JSONB) bila WA_DATABASE_URL di-set, jika tidak
// fallback userData/settings.json. Read (getAi) sinkron dari cache; setAi async.

const fs = require('fs');
const path = require('path');
const db = require('./db');

let filePath = null;
let cache = null;

const DEFAULTS = {
  ai: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen3.5:9b',
    autoReply: false,
    systemPrompt:
      'Namamu LaLa, asisten AI Greenpark yang ramah, hangat, dan cekatan. ' +
      'Perkenalkan diri sebagai "LaLa, asisten AI Greenpark" bila ditanya siapa ' +
      'kamu. JANGAN menyebut kata "WhatsApp" atau "WA". Jawab singkat dan ' +
      'profesional dalam Bahasa Indonesia. Gunakan data master divisi bila ' +
      'relevan. Jangan mengarang nomor atau data yang tidak diberikan.',
  },
};

async function init(userDataDir) {
  filePath = path.join(userDataDir, 'settings.json');

  if (db.isReady()) {
    const { rows } = await db.query("SELECT value FROM wa_settings WHERE key = 'ai'");
    if (rows.length === 0) {
      await db.query(
        "INSERT INTO wa_settings (key, value) VALUES ('ai', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify(DEFAULTS.ai)]
      );
      cache = { ai: { ...DEFAULTS.ai } };
    } else {
      cache = { ai: { ...DEFAULTS.ai, ...(rows[0].value || {}) } };
    }
    return;
  }

  if (!fs.existsSync(filePath)) writeFile(DEFAULTS);
  cache = readFile();
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { ai: { ...DEFAULTS.ai, ...(raw.ai || {}) } };
  } catch (_) {
    return { ai: { ...DEFAULTS.ai } };
  }
}

function writeFile(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function getAi() {
  return (cache && cache.ai) || { ...DEFAULTS.ai };
}

async function setAi(patch) {
  cache = cache || { ai: { ...DEFAULTS.ai } };
  cache.ai = { ...cache.ai, ...patch };
  if (db.isReady()) {
    await db.query(
      `INSERT INTO wa_settings (key, value) VALUES ('ai', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(cache.ai)]
    );
  } else {
    writeFile(cache);
  }
  return cache.ai;
}

module.exports = { init, getAi, setAi, DEFAULTS };

'use strict';

// Klien Google Sheets API v4 minimal via service account (JWT RS256).
// Tanpa dependency tambahan — pakai node crypto + global fetch.
// Kredensial: env GOOGLE_CREDENTIALS, default ke SA milik greenparkteknikbe
// (sheet monitoring sudah di-share ke dashboard@keen-scion-499708-j2).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEY_PATH =
  process.env.GOOGLE_CREDENTIALS ||
  path.join(__dirname, '..', 'greenparkteknikbe', 'google-credentials.json');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

let cachedToken = null; // { token, exp }

function configured() {
  return fs.existsSync(KEY_PATH);
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.exp - 60000) return cachedToken.token;
  const key = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  );
  const sig = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(key.private_key);
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent(
      'urn:ietf:params:oauth:grant-type:jwt-bearer'
    )}&assertion=${jwt}`,
  });
  if (!res.ok) {
    throw new Error(`Google token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function getValues(sheetId, range) {
  const token = await getToken();
  const res = await fetch(`${API}/${sheetId}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Sheets get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()).values || [];
}

// data: [{ range, values }] — ditulis sekali jalan.
async function batchUpdate(sheetId, data) {
  const token = await getToken();
  const res = await fetch(`${API}/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!res.ok) {
    throw new Error(`Sheets write ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// Index kolom 0-based -> huruf A1 (0->A, 26->AA).
function colLetter(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

module.exports = { configured, getValues, batchUpdate, colLetter, KEY_PATH };

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

async function chat(messages, { signal } = {}) {
  const { baseUrl, model } = settings.getAi();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, think: false }),
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
async function autoReply({ chatName, incoming, history, master }) {
  const sys =
    settings.getAi().systemPrompt +
    '\nKamu membalas otomatis. Jawab langsung sebagai pesan WhatsApp, singkat.';
  const ground = groundingText(master);
  const messages = [
    { role: 'system', content: ground ? `${sys}\n\n${ground}` : sys },
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

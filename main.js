'use strict';

require('dotenv').config();
const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const db = require('./db');
const masterdata = require('./masterdata');
const settings = require('./settings');
const ollama = require('./ollama');
const reminders = require('./reminders');
const teknik = require('./teknik');

// whatsapp-web.js bundles Puppeteer, but downloading Chromium fails in this
// environment, so we point Puppeteer at the system Chrome install.
const CHROME_PATH =
  process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Persist the WhatsApp session (LocalAuth) under userData so it survives restarts.
const SESSION_DIR = path.join(app.getPath('userData'), 'wa-session');

let mainWindow = null;
let client = null;
let lastState = 'INITIALIZING';
const processedMsgIds = new Set();
const processedMsgKeys = new Set();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#111b21',
    title: 'WA Electron',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    send('wa:state', lastState);
  });
}

// ---- WhatsApp client wiring -------------------------------------------------

// Sesi basi bisa lolos autentikasi tapi hang sebelum `ready` — kasih tahu user
// supaya pakai Reset Sesi, jangan menunggu tanpa batas.
let stuckTimer = null;
function setState(state) {
  lastState = state;
  send('wa:state', state);
  clearTimeout(stuckTimer);
  if (state === 'AUTHENTICATED') {
    stuckTimer = setTimeout(() => {
      if (lastState === 'AUTHENTICATED') {
        send('wa:stuck');
        send(
          'wa:error',
          'Macet memuat >3 menit — kemungkinan sesi basi. Klik "Reset Sesi" untuk scan ulang QR.'
        );
      }
    }, 180000);
  }
}

// Hapus total sesi tersimpan lalu mulai dari nol (QR baru).
async function resetSession() {
  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
    client = null;
  }
  // Chrome kadang masih memegang lock file sesaat setelah destroy — coba ulang.
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      break;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  setState('INITIALIZING');
  buildClient();
}

function buildClient() {
  const exists = fs.existsSync(CHROME_PATH);
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
    puppeteer: {
      headless: true,
      executablePath: exists ? CHROME_PATH : undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    },
  });

  client.on('qr', async (qr) => {
    setState('QR');
    try {
      const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
      send('wa:qr', dataUrl);
    } catch (err) {
      send('wa:error', 'Gagal render QR: ' + err.message);
    }
  });

  client.on('loading_screen', (percent, message) => {
    send('wa:loading', { percent: Number(percent) || 0, message });
  });

  client.on('authenticated', () => setState('AUTHENTICATED'));

  client.on('auth_failure', (msg) => {
    setState('AUTH_FAILURE');
    send('wa:error', 'Autentikasi gagal: ' + msg);
  });

  client.on('ready', async () => {
    setState('READY');
    try {
      const me = client.info;
      send('wa:me', {
        name: me?.pushname || '',
        number: me?.wid?.user || '',
        platform: me?.platform || '',
      });
    } catch (_) {}
  });

  client.on('disconnected', (reason) => {
    setState('DISCONNECTED');
    send('wa:error', 'Terputus: ' + reason);
  });

  client.on('message', async (msg) => {
    // Pesan dari chat @lid bisa memicu DUA event dgn id BERBEDA (varian lid
    // + varian nomor) → dedup id saja tidak cukup; teks di-dedup juga dgn
    // kunci body+timestamp (Ollama deterministik → balasan dobel identik).
    const mid = msg.id?._serialized;
    if (mid) {
      if (processedMsgIds.has(mid)) return;
      processedMsgIds.add(mid);
      if (processedMsgIds.size > 500) {
        processedMsgIds.delete(processedMsgIds.values().next().value);
      }
    }
    if (msg.body) {
      const dupKey = `${msg.body}|${msg.timestamp}|${msg.type}`;
      if (processedMsgKeys.has(dupKey)) return;
      processedMsgKeys.add(dupKey);
      if (processedMsgKeys.size > 500) {
        processedMsgKeys.delete(processedMsgKeys.values().next().value);
      }
    }
    await relayMessage(msg, false);
    const handled = await maybeTeknikReport(msg);
    if (!handled) await maybeAutoReply(msg);
  });

  client.on('message_create', async (msg) => {
    if (msg.fromMe) await relayMessage(msg, true);
  });

  client.initialize().catch((err) => {
    setState('ERROR');
    send('wa:error', 'Init gagal: ' + err.message);
  });
}

async function relayMessage(msg, fromMe) {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const payload = {
      id: msg.id?._serialized,
      chatId: chat.id._serialized,
      chatName: chat.name || contact.pushname || contact.number,
      body: msg.body,
      fromMe,
      author: fromMe ? 'Saya' : contact.pushname || contact.number,
      type: msg.type,
      timestamp: (msg.timestamp || 0) * 1000,
      hasMedia: msg.hasMedia,
    };
    send('wa:message', payload);

    if (!fromMe && Notification.isSupported()) {
      new Notification({
        title: payload.chatName,
        body: msg.type === 'chat' ? msg.body : `[${msg.type}]`,
      }).show();
    }
  } catch (err) {
    send('wa:error', 'Relay pesan gagal: ' + err.message);
  }
}

// ---- Resolusi nomor pengirim --------------------------------------------------

// Chat privasi baru memakai ID anonim "@lid" — chat.id.user BUKAN nomor telepon.
// Terjemahkan lid → nomor asli via getContactLidAndPhone (di-cache per sesi).
const lidNumberCache = new Map();
async function resolveSenderNumber(wid) {
  if (!wid) return '';
  if (wid.server !== 'lid') return wid.user;
  const ser = wid._serialized;
  if (lidNumberCache.has(ser)) return lidNumberCache.get(ser);
  try {
    const [r] = await client.getContactLidAndPhone([ser]);
    const num = r && r.pn ? String(r.pn).split('@')[0] : '';
    if (num) {
      lidNumberCache.set(ser, num);
      return num;
    }
  } catch (_) {}
  return wid.user;
}

// ---- Laporan progres Teknik → Google Sheet -----------------------------------

// Kirim balasan bot. Chat @lid dikirim ke alamat nomor asli (@c.us) —
// mengirim langsung ke @lid bisa terkirim dobel (bug wwebjs); pesan tetap
// masuk ke percakapan yang sama.
function replyTarget(chatId, senderNumber) {
  // JANGAN alihkan @lid → @c.us: mengirim ke pn-chat yang aslinya @lid membuat
  // WhatsApp menciptakan pesan di DUA chat (terlihat dobel di penerima).
  // Duplikasi pemrosesan event sudah ditangani dedup id/body + shouldSend.
  return chatId;
}

// Benteng terakhir anti-dobel: jangan kirim teks IDENTIK ke target yang sama
// dalam 30 detik, apa pun penyebab pemrosesan gandanya.
const lastSentText = new Map(); // target -> { text, at }
function shouldSend(target, text) {
  const prev = lastSentText.get(target);
  if (prev && prev.text === text && Date.now() - prev.at < 30000) return false;
  lastSentText.set(target, { text, at: Date.now() });
  return true;
}

async function replyAsLaLa(chatId, chatName, text, senderNumber) {
  const target = replyTarget(chatId, senderNumber);
  if (!shouldSend(target, text)) return;
  const sent = await client.sendMessage(target, text);
  send('wa:message', {
    id: sent.id?._serialized,
    chatId,
    chatName,
    body: text,
    fromMe: true,
    author: 'LaLa',
    type: 'chat',
    timestamp: Date.now(),
    hasMedia: false,
    aiReply: true,
  });
}

// Pesan chat pribadi dari nomor divisi Teknik dicoba sebagai laporan progres.
// Foto (image) dari nomor Teknik diunduh ke staging; captionnya ikut diproses
// sebagai teks laporan. true = sudah ditangani alur teknik (skip auto-reply).
async function maybeTeknikReport(msg) {
  try {
    if (!teknik.configured()) return false;
    if (msg.fromMe) return false;
    if (msg.type !== 'chat' && msg.type !== 'image') return false;
    const chat = await msg.getChat();
    if (chat.isGroup) return false;
    const chatId = chat.id._serialized;
    const senderNumber = await resolveSenderNumber(chat.id);

    let senderName = '';
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || '';
    } catch (_) {}

    if (msg.type === 'image' && msg.hasMedia) {
      const media = await msg.downloadMedia().catch(() => null);
      const st = media ? teknik.stagePhoto({ chatId, senderNumber, media }) : null;
      if (!msg.body) {
        // foto tanpa caption: cukup ack sekali di awal rentetan
        if (st && st.ack) await replyAsLaLa(chatId, chat.name, st.ack, senderNumber);
        return !!st;
      }
      // ada caption → lanjut diproses sebagai laporan di bawah
    }

    if (!msg.body) return false;
    const res = await teknik.handleIncoming({
      body: msg.body,
      chatId,
      senderNumber,
      senderName,
      history: convoHistory.get(chatId) || [],
    });
    if (!res) return false;
    await replyAsLaLa(chatId, chat.name, res.reply, senderNumber);
    // Catat ke riwayat percakapan AI supaya pertanyaan lanjutan user
    // ("disana ada keterlambatan?") bisa dijawab LaLa dengan konteks ini.
    pushHistory(chatId, 'user', msg.body);
    pushHistory(chatId, 'assistant', res.reply);
    // Aksi "cek" bisa menyertakan foto tersimpan unit → kirim sebagai media.
    if (res.photos && res.photos.length) {
      const target = replyTarget(chatId, senderNumber);
      for (const p of res.photos) {
        try {
          const media = MessageMedia.fromFilePath(p.path);
          await client.sendMessage(target, media, { caption: p.caption });
        } catch (err) {
          send('wa:error', 'Kirim foto gagal: ' + err.message);
        }
      }
    }
    return true;
  } catch (err) {
    send('wa:error', 'Laporan teknik gagal: ' + err.message);
    return true; // sudah dalam alur teknik — jangan dijawab auto-reply generik
  }
}

// ---- AI auto-reply ----------------------------------------------------------

// chatId -> [{role, content}] (dipangkas ke 10 turn terakhir).
const convoHistory = new Map();
function pushHistory(chatId, role, content) {
  const h = convoHistory.get(chatId) || [];
  h.push({ role, content });
  while (h.length > 10) h.shift();
  convoHistory.set(chatId, h);
}

async function maybeAutoReply(msg) {
  try {
    const ai = settings.getAi();
    if (!ai.autoReply) return;
    if (msg.fromMe || msg.type !== 'chat' || !msg.body) return;
    const chat = await msg.getChat();
    if (chat.isGroup) return; // hindari spam grup
    const chatId = chat.id._serialized;

    pushHistory(chatId, 'user', msg.body);
    await chat.sendStateTyping();
    const senderNumber = await resolveSenderNumber(chat.id);
    let senderName = '';
    try {
      const contact = await msg.getContact();
      senderName = contact.pushname || contact.name || '';
    } catch (_) {}
    // Nomor bisa terdaftar di lebih dari satu divisi — prioritaskan Teknik
    // supaya panduan input progres ikut terbawa.
    const senderNum = masterdata.normalizeNumber(senderNumber);
    const senderRows = masterdata
      .list()
      .filter(
        (r) => r.number && masterdata.normalizeNumber(r.number) === senderNum
      );
    const senderRow =
      senderRows.find((r) =>
        /tekni|dirops|direktur|direksi|ceo|owner|komisaris|pimpinan/i.test(
          `${r.divisi || ''} ${r.kadev || ''}`
        )
      ) || senderRows[0];
    const reply = await ollama.autoReply({
      chatName: chat.name,
      incoming: msg.body,
      history: convoHistory.get(chatId).slice(0, -1),
      master: masterdata.list(),
      senderNumber,
      senderName,
      senderRow,
      toneLine: teknik.toneLine(senderNum),
    });
    if (!reply) return;
    const target = replyTarget(chatId, senderNum);
    if (!shouldSend(target, reply)) return;
    const sent = await client.sendMessage(target, reply);
    pushHistory(chatId, 'assistant', reply);
    send('wa:message', {
      id: sent.id?._serialized,
      chatId,
      chatName: chat.name,
      body: reply,
      fromMe: true,
      author: 'LaLa',
      type: 'chat',
      timestamp: Date.now(),
      hasMedia: false,
      aiReply: true,
    });
  } catch (err) {
    send('wa:error', 'Auto-reply gagal: ' + err.message);
  }
}

// ---- Reminder scheduler -----------------------------------------------------

function sendToNumber(number, message) {
  const chatId = String(number).includes('@') ? number : `${number}@c.us`;
  return client.sendMessage(chatId, message);
}

function resolveTargetNumber(targetId) {
  const row = masterdata.list().find((r) => r.id === targetId);
  return row && row.number ? row.number : '';
}

let schedulerTimer = null;
function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(async () => {
    if (!client || lastState !== 'READY') return;
    try {
      const sent = await reminders.tick(new Date(), sendToNumber, resolveTargetNumber);
      if (sent.length) send('wa:reminderSent', sent);
    } catch (_) {}
  }, 30000);
}

// ---- IPC handlers (renderer -> main) ---------------------------------------

ipcMain.handle('wa:getChats', async () => {
  if (!client) return [];
  const chats = await client.getChats();
  return chats.slice(0, 50).map((c) => ({
    id: c.id._serialized,
    name: c.name || c.id.user,
    isGroup: c.isGroup,
    unread: c.unreadCount,
    timestamp: (c.timestamp || 0) * 1000,
    lastMessage: c.lastMessage ? c.lastMessage.body : '',
  }));
});

ipcMain.handle('wa:getMessages', async (_e, chatId) => {
  if (!client) return [];
  const chat = await client.getChatById(chatId);
  const msgs = await chat.fetchMessages({ limit: 40 });
  const out = [];
  for (const m of msgs) {
    let author = 'Saya';
    if (!m.fromMe) {
      try {
        const c = await m.getContact();
        author = c.pushname || c.number;
      } catch (_) {}
    }
    out.push({
      id: m.id?._serialized,
      body: m.body,
      fromMe: m.fromMe,
      author,
      type: m.type,
      timestamp: (m.timestamp || 0) * 1000,
      hasMedia: m.hasMedia,
    });
  }
  return out;
});

ipcMain.handle('wa:sendMessage', async (_e, { chatId, text }) => {
  if (!client) throw new Error('Client belum siap');
  const sent = await client.sendMessage(chatId, text);
  return { id: sent.id?._serialized };
});

// ---- Master data (divisi / kadev / nomor) ----

ipcMain.handle('md:list', async () => masterdata.list());
ipcMain.handle('md:save', async (_e, row) => masterdata.save(row));
ipcMain.handle('md:remove', async (_e, id) => masterdata.remove(id));

// Resolve nomor mentah -> chatId WA, validasi nomor terdaftar di WhatsApp.
ipcMain.handle('md:resolveNumber', async (_e, raw) => {
  if (!client) throw new Error('Client belum siap');
  const num = masterdata.normalizeNumber(raw);
  if (!num) throw new Error('Nomor kosong');
  const numberId = await client.getNumberId(num);
  if (!numberId) throw new Error('Nomor tidak terdaftar di WhatsApp: ' + num);
  return { chatId: numberId._serialized, number: num };
});

// ---- AI (Ollama) ----

ipcMain.handle('ai:getConfig', async () => settings.getAi());
ipcMain.handle('ai:setConfig', async (_e, patch) => settings.setAi(patch));
ipcMain.handle('ai:ping', async () => ollama.ping());
ipcMain.handle('ai:models', async () => ollama.listModels());
ipcMain.handle('ai:draft', async (_e, opts) =>
  ollama.draft({ ...opts, master: masterdata.list() })
);
ipcMain.handle('ai:composeReminder', async (_e, opts) =>
  ollama.composeReminder({ ...opts, master: masterdata.list() })
);

// ---- Reminder ----

ipcMain.handle('rem:list', async () => reminders.list());
ipcMain.handle('rem:save', async (_e, row) => reminders.save(row));
ipcMain.handle('rem:remove', async (_e, id) => reminders.remove(id));
ipcMain.handle('rem:test', async (_e, { number, targetId, message }) => {
  const num = number || resolveTargetNumber(targetId);
  if (!num) throw new Error('Nomor target tidak ditemukan');
  await sendToNumber(num, message);
  return { ok: true };
});

ipcMain.handle('wa:logout', async () => {
  if (!client) return;
  try {
    await client.logout();
  } catch (_) {}
  setState('LOGGED_OUT');
});

ipcMain.handle('wa:resetSession', resetSession);

ipcMain.handle('wa:restart', async () => {
  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
  }
  setState('INITIALIZING');
  buildClient();
});

// ---- App lifecycle ----------------------------------------------------------

app.whenReady().then(async () => {
  const userData = app.getPath('userData');

  // PostgreSQL bila WA_DATABASE_URL di-set; gagal => fallback file JSON.
  if (db.configured()) {
    try {
      await db.init();
      console.log('[db] PostgreSQL siap:', db.DSN.replace(/:[^:@/]*@/, ':***@'));
    } catch (err) {
      console.error('[db] Postgres gagal, fallback ke file JSON:', err.message);
    }
  }

  await masterdata.init(userData, __dirname);
  await settings.init(userData);
  await reminders.init(userData);
  await teknik.init(userData);
  createWindow();
  buildClient();
  startScheduler();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (client) {
    try {
      await client.destroy();
    } catch (_) {}
  }
  await db.close();
  if (process.platform !== 'darwin') app.quit();
});

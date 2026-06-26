'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  chats: [],
  activeChatId: null,
  activeChatName: '',
};

// ---- Overlay / connection states -------------------------------------------

const STATUS_TEXT = {
  INITIALIZING: 'Memulai…',
  QR: 'Pindai QR untuk masuk',
  AUTHENTICATED: 'Terautentikasi, memuat…',
  AUTH_FAILURE: 'Autentikasi gagal',
  READY: 'Siap',
  DISCONNECTED: 'Terputus',
  LOGGED_OUT: 'Sudah keluar',
  ERROR: 'Terjadi kesalahan',
};

function showOverlay(show) {
  $('overlay').classList.toggle('hidden', !show);
  $('app').classList.toggle('hidden', show);
}

function handleState(s) {
  $('overlay-status').textContent = STATUS_TEXT[s] || s;
  const isReady = s === 'READY';
  showOverlay(!isReady);

  $('qr-wrap').classList.toggle('hidden', s !== 'QR');
  const showRetry = ['AUTH_FAILURE', 'DISCONNECTED', 'LOGGED_OUT', 'ERROR'].includes(s);
  $('retry-btn').classList.toggle('hidden', !showRetry);
  if (s !== 'AUTHENTICATED' && s !== 'INITIALIZING') {
    $('loading-bar').classList.add('hidden');
  }

  if (isReady) loadChats();
}

// ---- Chats ------------------------------------------------------------------

async function loadChats() {
  try {
    state.chats = await window.wa.getChats();
    renderChats();
  } catch (err) {
    toast('Gagal memuat chat: ' + err.message);
  }
}

function renderChats() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('chat-list');
  list.innerHTML = '';
  state.chats
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .forEach((c) => {
      const div = document.createElement('div');
      div.className = 'chat-item' + (c.id === state.activeChatId ? ' active' : '');
      div.dataset.id = c.id;
      div.innerHTML = `
        <div class="ci-main">
          <div class="ci-name">${esc(c.name)}</div>
          <div class="ci-last">${esc(c.lastMessage || '')}</div>
        </div>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ''}`;
      div.addEventListener('click', () => openChat(c.id, c.name));
      list.appendChild(div);
    });
}

async function openChat(chatId, name) {
  state.activeChatId = chatId;
  state.activeChatName = name;
  state.activeIsGroup = (state.chats.find((c) => c.id === chatId) || {}).isGroup;
  $('chat-title').textContent = name;
  $('composer').classList.remove('hidden');
  $('messages').innerHTML = '<div class="ci-last" style="padding:20px">Memuat…</div>';
  renderChats();
  try {
    const msgs = await window.wa.getMessages(chatId);
    renderMessages(msgs);
  } catch (err) {
    toast('Gagal memuat pesan: ' + err.message);
  }
}

function renderMessages(msgs) {
  const box = $('messages');
  box.innerHTML = '';
  msgs.forEach((m) => box.appendChild(bubble(m)));
  box.scrollTop = box.scrollHeight;
  const lastIn = [...msgs].reverse().find((m) => !m.fromMe && m.type === 'chat');
  state.lastIncoming = lastIn ? lastIn.body : '';
}

function bubble(m) {
  const div = document.createElement('div');
  div.className = 'bubble' + (m.fromMe ? ' me' : '');
  const body = m.type === 'chat' ? esc(m.body) : `[${esc(m.type)}]`;
  const author = !m.fromMe && state.activeIsGroup ? `<span class="author">${esc(m.author)}</span><br>` : '';
  div.innerHTML = `${author}${body}<span class="meta">${time(m.timestamp)}</span>`;
  return div;
}

// ---- Incoming live messages -------------------------------------------------

function onIncoming(m) {
  // append if it belongs to the open chat
  if (m.chatId === state.activeChatId) {
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.appendChild(bubble(m));
    if (atBottom) box.scrollTop = box.scrollHeight;
    if (!m.fromMe && m.type === 'chat') state.lastIncoming = m.body;
  }
  // refresh sidebar preview / unread
  const chat = state.chats.find((c) => c.id === m.chatId);
  if (chat) {
    chat.lastMessage = m.type === 'chat' ? m.body : `[${m.type}]`;
    if (!m.fromMe && m.chatId !== state.activeChatId) chat.unread = (chat.unread || 0) + 1;
    // move to top
    state.chats = [chat, ...state.chats.filter((c) => c.id !== chat.id)];
    renderChats();
  } else {
    loadChats();
  }
}

// ---- Compose / send ---------------------------------------------------------

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.activeChatId) return;
  input.value = '';
  try {
    await window.wa.sendMessage(state.activeChatId, text);
    // optimistic render; message_create event will also fire
  } catch (err) {
    toast('Gagal kirim: ' + err.message);
    input.value = text;
  }
});

$('search').addEventListener('input', renderChats);

$('logout-btn').addEventListener('click', async () => {
  await window.wa.logout();
});

$('retry-btn').addEventListener('click', async () => {
  $('overlay-status').textContent = 'Memulai ulang…';
  $('retry-btn').classList.add('hidden');
  await window.wa.restart();
});

// ---- Master Data Divisi -----------------------------------------------------

$('master-btn').addEventListener('click', openMaster);
$('master-back').addEventListener('click', () => {
  $('master-view').classList.add('hidden');
});

async function openMaster() {
  $('master-view').classList.remove('hidden');
  await renderMaster();
}

async function renderMaster() {
  let rows = [];
  try {
    rows = await window.wa.md.list();
  } catch (err) {
    toast('Gagal memuat master data: ' + err.message);
  }
  const tbody = $('md-rows');
  tbody.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const num = r.number
      ? `+${esc(r.number)}`
      : '<span class="md-num-empty">belum diisi</span>';
    tr.innerHTML = `
      <td>${esc(r.divisi)}</td>
      <td>${esc(r.kadev)}</td>
      <td>${num}</td>
      <td>
        <button class="row-btn chat" ${r.number ? '' : 'disabled'}>Chat</button>
        <button class="row-btn edit">Edit</button>
        <button class="row-btn del">Hapus</button>
      </td>`;
    tr.querySelector('.chat').addEventListener('click', () => chatWith(r));
    tr.querySelector('.edit').addEventListener('click', () => fillForm(r));
    tr.querySelector('.del').addEventListener('click', () => delRow(r));
    tbody.appendChild(tr);
  });
}

function fillForm(r) {
  $('md-id').value = r.id || '';
  $('md-divisi').value = r.divisi || '';
  $('md-kadev').value = r.kadev || '';
  $('md-number').value = r.number || '';
  $('md-submit').textContent = r.id ? 'Simpan' : 'Tambah';
  $('md-cancel').classList.toggle('hidden', !r.id);
}

function resetForm() {
  fillForm({});
  $('md-submit').textContent = 'Tambah';
  $('md-cancel').classList.add('hidden');
}

$('md-cancel').addEventListener('click', resetForm);

$('md-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const row = {
    id: $('md-id').value.trim(),
    divisi: $('md-divisi').value.trim(),
    kadev: $('md-kadev').value.trim(),
    number: $('md-number').value.trim(),
  };
  if (!row.divisi) return toast('Divisi wajib diisi');
  try {
    await window.wa.md.save(row);
    resetForm();
    await renderMaster();
  } catch (err) {
    toast('Gagal simpan: ' + err.message);
  }
});

async function delRow(r) {
  try {
    await window.wa.md.remove(r.id);
    await renderMaster();
  } catch (err) {
    toast('Gagal hapus: ' + err.message);
  }
}

async function chatWith(r) {
  try {
    const { chatId } = await window.wa.md.resolveNumber(r.number);
    $('master-view').classList.add('hidden');
    if (!state.chats.find((c) => c.id === chatId)) await loadChats();
    openChat(chatId, r.kadev ? `${r.divisi} — ${r.kadev}` : r.divisi);
  } catch (err) {
    toast(err.message);
  }
}

// ---- Auto-reply header toggle ----------------------------------------------

function paintAutoReply(on) {
  state.autoReply = on;
  const btn = $('autoreply-toggle');
  btn.textContent = on ? '🤖 LaLa: ON' : '🤖 LaLa: OFF';
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  const cb = $('ai-autoreply');
  if (cb) cb.checked = on;
}

async function refreshAutoReply() {
  try {
    const cfg = await window.wa.ai.getConfig();
    paintAutoReply(!!cfg.autoReply);
  } catch (_) {}
}

$('autoreply-toggle').addEventListener('click', async () => {
  const next = !state.autoReply;
  try {
    await window.wa.ai.setConfig({ autoReply: next });
    paintAutoReply(next);
    toast(next ? 'LaLa auto-reply: ON' : 'LaLa auto-reply: OFF');
  } catch (err) {
    toast('Gagal ubah auto-reply: ' + err.message);
  }
});

// ---- AI (Ollama) settings ---------------------------------------------------

$('ai-btn').addEventListener('click', openAi);
$('ai-back').addEventListener('click', () => $('ai-view').classList.add('hidden'));

async function openAi() {
  $('ai-view').classList.remove('hidden');
  $('ai-status').textContent = 'Memeriksa…';
  let cfg = {};
  try {
    cfg = await window.wa.ai.getConfig();
  } catch (_) {}
  $('ai-baseurl').value = cfg.baseUrl || '';
  $('ai-autoreply').checked = !!cfg.autoReply;
  $('ai-prompt').value = cfg.systemPrompt || '';
  await loadModels(cfg.model);
}

async function loadModels(selected) {
  const sel = $('ai-model');
  try {
    const models = await window.wa.ai.models();
    sel.innerHTML = '';
    models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = m;
      if (m === selected) o.selected = true;
      sel.appendChild(o);
    });
    if (selected && !models.includes(selected)) {
      const o = document.createElement('option');
      o.value = selected;
      o.textContent = selected + ' (tak terpasang)';
      o.selected = true;
      sel.appendChild(o);
    }
    $('ai-status').textContent = `Ollama OK — ${models.length} model`;
  } catch (err) {
    sel.innerHTML = `<option value="${esc(selected || '')}">${esc(selected || '—')}</option>`;
    $('ai-status').textContent = 'Ollama tak terjangkau';
  }
}

$('ai-test').addEventListener('click', async () => {
  $('ai-status').textContent = 'Tes…';
  try {
    const r = await window.wa.ai.ping();
    $('ai-status').textContent = `OK — ${r.model} @ ${r.baseUrl} (${r.models.length} model)`;
    toast('Ollama terhubung.');
  } catch (err) {
    $('ai-status').textContent = 'Gagal';
    toast('Tes gagal: ' + err.message);
  }
});

$('ai-save').addEventListener('click', async () => {
  try {
    await window.wa.ai.setConfig({
      baseUrl: $('ai-baseurl').value.trim(),
      model: $('ai-model').value,
      autoReply: $('ai-autoreply').checked,
      systemPrompt: $('ai-prompt').value.trim(),
    });
    paintAutoReply($('ai-autoreply').checked);
    toast('Pengaturan AI disimpan.');
  } catch (err) {
    toast('Gagal simpan: ' + err.message);
  }
});

// ---- AI draft balasan (composer) -------------------------------------------

$('draft-btn').addEventListener('click', async () => {
  if (!state.activeChatId) return toast('Buka chat dulu.');
  const btn = $('draft-btn');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const reply = await window.wa.ai.draft({
      chatName: state.activeChatName,
      lastIncoming: state.lastIncoming || '',
      draftText: $('msg-input').value.trim(),
    });
    if (reply) $('msg-input').value = reply;
  } catch (err) {
    toast('Draft AI gagal: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ LaLa';
  }
});

// ---- Reminder ---------------------------------------------------------------

$('reminder-btn').addEventListener('click', openReminders);
$('rem-back').addEventListener('click', () => $('rem-view').classList.add('hidden'));
$('rem-mode').addEventListener('change', syncRemMode);

function syncRemMode() {
  const daily = $('rem-mode').value === 'daily';
  $('rem-at-once').classList.toggle('hidden', daily);
  $('rem-at-daily').classList.toggle('hidden', !daily);
}

async function openReminders() {
  $('rem-view').classList.remove('hidden');
  await loadTargets();
  await renderReminders();
  syncRemMode();
}

async function loadTargets() {
  const sel = $('rem-target');
  sel.innerHTML = '';
  let rows = [];
  try {
    rows = await window.wa.md.list();
  } catch (_) {}
  rows.forEach((r) => {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${r.divisi}${r.kadev ? ' — ' + r.kadev : ''}${
      r.number ? '' : ' (no. kosong)'
    }`;
    o.dataset.divisi = r.divisi;
    o.dataset.kadev = r.kadev;
    o.dataset.number = r.number;
    sel.appendChild(o);
  });
}

async function renderReminders() {
  let rows = [];
  try {
    rows = await window.wa.rem.list();
  } catch (err) {
    return toast('Gagal memuat reminder: ' + err.message);
  }
  const tbody = $('rem-rows');
  tbody.innerHTML = '';
  rows.forEach((r) => {
    const sched =
      r.mode === 'daily' ? `Harian ${esc(r.at)}` : `Sekali ${esc(r.at.replace('T', ' '))}`;
    const tgt = `${esc(r.divisi || r.number)}${r.kadev ? ' — ' + esc(r.kadev) : ''}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${tgt}${r.enabled ? '' : ' <span class="md-num-empty">(off)</span>'}</td>
      <td>${sched}</td>
      <td class="rem-msg-cell">${esc(r.message)}</td>
      <td>
        <button class="row-btn chat">Tes kirim</button>
        <button class="row-btn edit">Edit</button>
        <button class="row-btn del">Hapus</button>
      </td>`;
    tr.querySelector('.chat').addEventListener('click', () => testReminder(r));
    tr.querySelector('.edit').addEventListener('click', () => fillRem(r));
    tr.querySelector('.del').addEventListener('click', () => delReminder(r));
    tbody.appendChild(tr);
  });
}

function fillRem(r) {
  $('rem-id').value = r.id || '';
  $('rem-target').value = r.targetId || '';
  $('rem-mode').value = r.mode || 'once';
  if (r.mode === 'daily') $('rem-time').value = r.at || '';
  else $('rem-datetime').value = r.at || '';
  $('rem-message').value = r.message || '';
  $('rem-submit').textContent = r.id ? 'Simpan' : 'Tambah';
  $('rem-cancel').classList.toggle('hidden', !r.id);
  syncRemMode();
}

function resetRem() {
  fillRem({});
}

$('rem-cancel').addEventListener('click', resetRem);

$('rem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const opt = $('rem-target').selectedOptions[0];
  if (!opt) return toast('Pilih target dari master data.');
  const mode = $('rem-mode').value;
  const at = mode === 'daily' ? $('rem-time').value : $('rem-datetime').value;
  if (!at) return toast('Isi waktu reminder.');
  const message = $('rem-message').value.trim();
  if (!message) return toast('Isi pesan reminder.');
  try {
    await window.wa.rem.save({
      id: $('rem-id').value.trim(),
      targetId: opt.value,
      number: opt.dataset.number || '',
      divisi: opt.dataset.divisi || '',
      kadev: opt.dataset.kadev || '',
      message,
      mode,
      at,
      enabled: true,
    });
    resetRem();
    await renderReminders();
    toast('Reminder disimpan.');
  } catch (err) {
    toast('Gagal simpan: ' + err.message);
  }
});

$('rem-ai').addEventListener('click', async () => {
  const points = $('rem-aipoints').value.trim();
  if (!points) return toast('Tulis poin singkat dulu.');
  const opt = $('rem-target').selectedOptions[0];
  const btn = $('rem-ai');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const text = await window.wa.ai.composeReminder({
      points,
      divisi: opt?.dataset.divisi || '',
      kadev: opt?.dataset.kadev || '',
    });
    if (text) $('rem-message').value = text;
  } catch (err) {
    toast('Susun AI gagal: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Susun AI';
  }
});

async function testReminder(r) {
  try {
    await window.wa.rem.test({ number: r.number, targetId: r.targetId, message: r.message });
    toast('Tes kirim terkirim.');
  } catch (err) {
    toast('Tes gagal: ' + err.message);
  }
}

async function delReminder(r) {
  try {
    await window.wa.rem.remove(r.id);
    await renderReminders();
  } catch (err) {
    toast('Gagal hapus: ' + err.message);
  }
}

// ---- Helpers ----------------------------------------------------------------

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}
function time(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---- Wire main-process events ----------------------------------------------

window.wa.on('wa:state', handleState);
window.wa.on('wa:qr', (dataUrl) => {
  $('qr-img').src = dataUrl;
});
window.wa.on('wa:loading', ({ percent, message }) => {
  $('loading-bar').classList.remove('hidden');
  $('loading-fill').style.width = percent + '%';
  $('overlay-status').textContent = message || 'Memuat…';
});
window.wa.on('wa:me', (me) => {
  $('me-name').textContent = me.name || me.number || '—';
  $('me-number').textContent = me.number ? '+' + me.number : '';
});
window.wa.on('wa:message', onIncoming);
window.wa.on('wa:error', (msg) => toast(msg));
refreshAutoReply();
window.wa.on('wa:reminderSent', (ids) =>
  toast(`Reminder terkirim (${ids.length}).`)
);

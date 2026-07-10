'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wa', {
  // renderer -> main (request/response)
  getChats: () => ipcRenderer.invoke('wa:getChats'),
  getMessages: (chatId) => ipcRenderer.invoke('wa:getMessages', chatId),
  sendMessage: (chatId, text) =>
    ipcRenderer.invoke('wa:sendMessage', { chatId, text }),
  logout: () => ipcRenderer.invoke('wa:logout'),
  restart: () => ipcRenderer.invoke('wa:restart'),
  resetSession: () => ipcRenderer.invoke('wa:resetSession'),

  // master data divisi / kadev / nomor
  md: {
    list: () => ipcRenderer.invoke('md:list'),
    save: (row) => ipcRenderer.invoke('md:save', row),
    remove: (id) => ipcRenderer.invoke('md:remove', id),
    resolveNumber: (raw) => ipcRenderer.invoke('md:resolveNumber', raw),
  },

  // AI lokal (Ollama)
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:getConfig'),
    setConfig: (patch) => ipcRenderer.invoke('ai:setConfig', patch),
    ping: () => ipcRenderer.invoke('ai:ping'),
    models: () => ipcRenderer.invoke('ai:models'),
    draft: (opts) => ipcRenderer.invoke('ai:draft', opts),
    composeReminder: (opts) => ipcRenderer.invoke('ai:composeReminder', opts),
  },

  // reminder
  rem: {
    list: () => ipcRenderer.invoke('rem:list'),
    save: (row) => ipcRenderer.invoke('rem:save', row),
    remove: (id) => ipcRenderer.invoke('rem:remove', id),
    test: (opts) => ipcRenderer.invoke('rem:test', opts),
  },

  // main -> renderer (events)
  on: (channel, cb) => {
    const allowed = [
      'wa:state',
      'wa:stuck',
      'wa:qr',
      'wa:loading',
      'wa:me',
      'wa:message',
      'wa:error',
      'wa:reminderSent',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latchi', {
  // حالة عامة
  state:          ()        => ipcRenderer.invoke('app:state'),
  version:        ()        => ipcRenderer.invoke('app:version'),

  // OAuth
  connect:        ()        => ipcRenderer.invoke('auth:connect'),
  disconnect:     ()        => ipcRenderer.invoke('auth:disconnect'),
  setClientId:    (id)      => ipcRenderer.invoke('auth:setClientId', id),
  authStatus:     ()        => ipcRenderer.invoke('auth:status'),

  // القنوات
  listChannels:   ()        => ipcRenderer.invoke('channels:list'),
  selectChannel:  (id)      => ipcRenderer.invoke('channels:select', id),
  categories:     ()        => ipcRenderer.invoke('categories:list'),

  // الفيديو
  pickVideo:      ()        => ipcRenderer.invoke('video:pick'),
  analyzeVideo:   (f)       => ipcRenderer.invoke('video:analyze', f),
  clearVideo:     ()        => ipcRenderer.invoke('video:clear'),
  pickThumbnail:  ()        => ipcRenderer.invoke('thumbnail:pick'),

  // البث
  startLive:      (o)       => ipcRenderer.invoke('live:start', o),
  stopLive:       ()        => ipcRenderer.invoke('live:stop'),
  liveStatus:     ()        => ipcRenderer.invoke('live:status'),
  openUrl:        (u)       => ipcRenderer.invoke('live:openUrl', u),

  // أدوات
  toolsStatus:    ()        => ipcRenderer.invoke('tools:status'),
  pickFfmpeg:     ()        => ipcRenderer.invoke('tools:pickFfmpeg'),
  openToolsDir:   ()        => ipcRenderer.invoke('tools:openDir'),
  openExternal:   (u)       => ipcRenderer.invoke('shell:open', u),
  openUserData:   ()        => ipcRenderer.invoke('app:openUserData'),

  // أحداث
  onState:        (cb)      => ipcRenderer.on('state', (e, d) => cb(d)),
  onLog:          (cb)      => ipcRenderer.on('log', (e, m) => cb(m))
});

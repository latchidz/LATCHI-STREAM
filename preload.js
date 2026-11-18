// جسر آمن بين الواجهة والتطبيق
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latchi', {
  info:            ()      => ipcRenderer.invoke('app:info'),
  getSettings:     ()      => ipcRenderer.invoke('settings:get'),
  setSettings:     (p)     => ipcRenderer.invoke('settings:set', p),

  audioList:       ()      => ipcRenderer.invoke('audio:list'),
  encodersList:    ()      => ipcRenderer.invoke('encoders:list'),

  keyEmbedded:     ()      => ipcRenderer.invoke('key:embedded'),
  keyTest:         (k)     => ipcRenderer.invoke('key:test', k),

  previewStart:    (s)     => ipcRenderer.invoke('preview:start', s),
  previewStop:     ()      => ipcRenderer.invoke('preview:stop'),
  previewFrame:    ()      => ipcRenderer.invoke('preview:frame'),

  streamStart:     (s)     => ipcRenderer.invoke('stream:start', s),
  streamStop:      ()      => ipcRenderer.invoke('stream:stop'),
  state:           ()      => ipcRenderer.invoke('state:get'),

  windowList:      ()      => ipcRenderer.invoke('window:list'),
  pickWindowMouse: ()      => ipcRenderer.invoke('window:pickByMouse'),
  defaultFont:     ()      => ipcRenderer.invoke('font:default'),
  setFullscreen:   (on)    => ipcRenderer.invoke('fullscreen:set', on),
  pickImage:       ()      => ipcRenderer.invoke('dialog:image'),
  pickFont:        ()      => ipcRenderer.invoke('dialog:font'),

  openExternal:    (u)     => ipcRenderer.invoke('shell:open', u),
  quit:            ()      => ipcRenderer.invoke('app:quit'),
  quitApp:         ()      => ipcRenderer.invoke('app:quit'),
  hideToTray:      ()      => ipcRenderer.invoke('window:hide'),

  onLog:           (cb)    => ipcRenderer.on('log', (e, m) => cb(m)),
  onStreamEnded:   (cb)    => ipcRenderer.on('stream-ended', (e, d) => cb(d)),
  onStreamRestarting: (cb) => ipcRenderer.on('stream-restarting', (e, d) => cb(d)),
  onStreamRestarted:  (cb) => ipcRenderer.on('stream-restarted', (e, d) => cb(d)),
  onBrowserEsc:    (cb)    => ipcRenderer.on('browser-esc', (e, d) => cb(d)),

  // ffmpeg
  ffmpegStatus:    ()      => ipcRenderer.invoke('ffmpeg:status'),
  ffmpegRetry:     ()      => ipcRenderer.invoke('ffmpeg:retry'),
  ffmpegPick:      ()      => ipcRenderer.invoke('ffmpeg:pick'),
  ffmpegOpenDir:   ()      => ipcRenderer.invoke('ffmpeg:openDir'),
  onFfmpegReady:   (cb)    => ipcRenderer.on('ffmpeg-ready', (e, d) => cb(d))
});

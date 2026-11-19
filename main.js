// ==============================================================================================
// LATCHI STREAM 4.0.1  -  بث فيديوهات محلية إلى YouTube
// ----------------------------------------------------------------------------------------------
// المبدأ: Local Video File → FFmpeg → YouTube Live RTMP
// • تسجيل دخول Google OAuth (PKCE) في متصفح النظام — لا متصفح مدمج.
// • إدارة القنوات عبر YouTube Data API (بما فيها القنوات المتعددة وBrand Accounts).
// • إنشاء البث وربطه بتيار RTMP رسمياً، ثم transition عند الجهوزية.
// • نسخ مباشر (-c copy) بلا ترميز عند توافق الملف، وإلا ترميز خفيف.
// • إيقاف تلقائي عند نهاية الملف + إنهاء البث عبر API (لا بث عالق).
// • لا التقاط شاشة، لا معاينة، لا ميكروفون.
// ==============================================================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const { GoogleAuth } = require(path.join(__dirname, 'core', 'OAuth.js'));
const { YouTubeApi } = require(path.join(__dirname, 'core', 'YouTubeApi.js'));
const VideoStream = require(path.join(__dirname, 'core', 'VideoStream.js'));

const PKG = (() => { try { return require(path.join(__dirname, 'package.json')); } catch (e) { return { version: '4.0.0' }; } })();
const APP_VERSION = PKG.version || '4.0.0';

let win = null;
let auth = null;
let yt = null;
let engine = null;         // StreamEngine

let FFMPEG = null;
let FFPROBE = null;

// حالة البث
const live = {
  phase: 'idle',           // idle | preparing | connecting | ready | live | stopping | done | error
  broadcast: null,         // { id, watchUrl, studioUrl, lifecycle }
  stream: null,            // { id, streamName, ingestionAddress, ... }
  video: null,             // معلومات الملف
  startedAt: 0,
  endedAt: 0,
  error: '',
  progress: { frame: 0, fps: 0, bitrate: '', outTimeMs: 0, speed: '', dropFrames: 0 },
  channel: null,
  autoStopped: false,
  lastHealthPolls: 0
};

const settingsFile = () => path.join(dataDir(), 'settings.json');
const oauthFile = () => path.join(dataDir(), 'oauth.json');
const clientsFile = () => path.join(dataDir(), 'oauth-client.json');

function dataDir() {
  const d = app.getPath('userData');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), 'latchi-stream');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const progressFile = () => path.join(tmpDir(), 'progress.txt');
const thumbFile = () => path.join(tmpDir(), 'thumb.png');

function safeSend(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch (e) {}
}
function log(msg, kind) {
  const line = (kind ? '[' + kind + '] ' : '') + msg;
  safeSend('log', line);
}

// ------------------------------------------------------------------ الإعدادات
let settings = {
  channelId: '',
  channelTitle: '',
  channelThumb: '',
  title: 'LATCHI STREAM — بث مباشر',
  description: '',
  privacy: 'unlisted',
  madeForKids: false,
  categoryId: '',
  thumbnail: '',
  videoPath: '',
  videoInfo: null,
  copySafe: true,
  preset: 'veryfast',
  videoBitrate: '3000k',
  audioBitrate: '128k',
  threads: 0,
  clientId: ''
};

function loadAll() {
  try { if (fs.existsSync(settingsFile())) Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))); } catch (e) {}
  // Client ID: من ملف منفصل (لا يُحزَّم)
  try {
    if (fs.existsSync(clientsFile())) {
      const j = JSON.parse(fs.readFileSync(clientsFile(), 'utf8'));
      if (j && j.clientId) settings.clientId = String(j.clientId);
    }
  } catch (e) {}
  if (process.env.LATCHI_GOOGLE_CLIENT_ID) settings.clientId = process.env.LATCHI_GOOGLE_CLIENT_ID;
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) {}
}

// ------------------------------------------------------------------ ffmpeg / ffprobe
const IS_WIN = process.platform === 'win32';
const FF_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
const FFP_NAME = IS_WIN ? 'ffprobe.exe' : 'ffprobe';

function ffBinDir() {
  const d = path.join(dataDir(), 'bin');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function findBin(name) {
  const c = [path.join(ffBinDir(), name), path.join(dataDir(), name)];
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'ffmpeg', name));
  c.push(path.join(__dirname, 'resources', 'ffmpeg', name));
  const exeDir = path.dirname(app.getPath('exe'));
  c.push(path.join(exeDir, name), path.join(exeDir, 'ffmpeg', name), path.join(exeDir, 'resources', 'ffmpeg', name));
  if (IS_WIN) c.push('C:\\ffmpeg\\bin\\' + name);
  for (const x of c) { try { if (fs.existsSync(x) && fs.statSync(x).size > 1000) return x; } catch (e) {} }
  const P = process.env.PATH || process.env.Path || '';
  for (const d of P.split(path.delimiter)) {
    if (!d) continue;
    const x = path.join(d, name);
    try { if (fs.existsSync(x)) return x; } catch (e) {}
  }
  return null;
}

function works(binPath, args) {
  return new Promise(resolve => {
    if (!binPath) return resolve(false);
    let done = false;
    let p;
    try { p = spawn(binPath, args, { windowsHide: true }); } catch (e) { return resolve(false); }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} if (!done) { done = true; resolve(false); } }, 10000);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => out += d.toString());
    p.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(false); } });
    p.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve(/version/i.test(out)); } });
  });
}

async function resolveTools() {
  const f = findBin(FF_NAME), p = findBin(FFP_NAME);
  // تحقق فعلي (لا تخمين): الملف الموجود ليس بالضرورة قابلاً للتنفيذ
  const okF = await works(f, ['-hide_banner', '-version']);
  const okP = await works(p, ['-hide_banner', '-version']);
  FFMPEG = okF ? f : null;
  FFPROBE = okP ? p : null;
  return { ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE, ffmpegPath: FFMPEG || '', ffprobePath: FFPROBE || '' };
}

// ------------------------------------------------------------------ النافذة
function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 780, minWidth: 900, minHeight: 640,
    backgroundColor: '#0f1520',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ------------------------------------------------------------------ حالة للواجهة
function stateForUi() {
  return {
    version: APP_VERSION,
    phase: live.phase,
    error: live.error,
    tools: { ffmpeg: !!FFMPEG, ffprobe: !!FFPROBE },
    auth: auth ? auth.profile() : { connected: false },
    clientConfigured: !!(auth && auth.configured()),
    settings: {
      title: settings.title, description: settings.description, privacy: settings.privacy,
      madeForKids: settings.madeForKids, categoryId: settings.categoryId, thumbnail: settings.thumbnail,
      videoPath: settings.videoPath, preset: settings.preset, videoBitrate: settings.videoBitrate,
      audioBitrate: settings.audioBitrate, threads: settings.threads
    },
    channel: live.channel || (settings.channelId ? { id: settings.channelId, title: settings.channelTitle, thumbnail: settings.channelThumb } : null),
    video: live.video,
    broadcast: live.broadcast,
    progress: live.progress,
    elapsed: live.startedAt ? Math.round((Date.now() - live.startedAt) / 1000) : 0,
    duration: (live.video && live.video.duration) || 0,
    copySafe: !!(live.video && live.video.copySafe)
  };
}
function pushState() { safeSend('state', stateForUi()); }

// ------------------------------------------------------------------ اختيار الفيديو
async function pickVideo() {
  const r = await dialog.showOpenDialog(win, {
    title: 'اختر ملف فيديو لبثه على YouTube',
    properties: ['openFile'],
    filters: [
      { name: 'ملفات فيديو مدعومة', extensions: ['mp4', 'mkv', 'mov', 'avi', 'flv', 'webm', 'ts', 'm4v', 'mpg', 'mpeg', 'wmv'] },
      { name: 'كل الملفات', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  return analyzeVideo(r.filePaths[0]);
}

async function analyzeVideo(file) {
  if (!engine) engine = new VideoStream.StreamEngine({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, log });
  if (!FFPROBE) return { ok: false, error: 'ffprobe غير متاح — لا يمكن فحص الفيديو' };
  if (!fs.existsSync(file)) return { ok: false, error: 'الملف غير موجود' };

  const info = await engine.probe(file);
  if (!info.ok) return info;

  info.file = file;
  info.fileName = path.basename(file);
  info.sizeMB = Math.round((info.size || 0) / 1048576 * 10) / 10;
  info.copySafe = VideoStream.isYouTubeCopySafe(info);
  info.strategy = info.copySafe ? 'نسخ مباشر (بلا ترميز)' : 'ترميز خفيف H.264/AAC';
  info.durationHMS = hms(info.duration);

  live.video = info;
  settings.videoPath = file;
  settings.videoInfo = {
    duration: info.duration, width: info.video.width, height: info.video.height,
    codec: info.video.codec, copySafe: info.copySafe
  };
  saveSettings();
  pushState();
  log('تم فحص الفيديو: ' + info.fileName + ' — ' + info.strategy + (info.hasAudio ? '' : ' (بلا صوت ⇒ صمت مولّد)'), 'ok');
  return { ok: true, video: info };
}

function hms(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(q).padStart(2, '0');
}

// ------------------------------------------------------------------ بدء البث
async function startLive(input) {
  if (live.phase === 'live' || live.phase === 'connecting' || live.phase === 'preparing') {
    return { ok: false, error: 'هناك بث جارٍ بالفعل' };
  }
  live.error = '';
  live.autoStopped = false;

  if (!auth || !auth.connected()) return fail('اربط حساب Google أولاً');
  if (!FFMPEG || !FFPROBE) return fail('ffmpeg/ffprobe غير متاحين');
  if (!live.channel && !settings.channelId) return fail('اختر قناة YouTube أولاً');
  if (!settings.videoPath || !fs.existsSync(settings.videoPath)) return fail('اختر ملف فيديو أولاً');

  const opt = Object.assign({
    title: settings.title, description: settings.description, privacy: settings.privacy,
    madeForKids: settings.madeForKids, categoryId: settings.categoryId, thumbnail: settings.thumbnail
  }, input || {});

  settings.title = String(opt.title || settings.title).slice(0, 100);
  settings.description = String(opt.description || '');
  settings.privacy = ['public', 'unlisted', 'private'].includes(opt.privacy) ? opt.privacy : 'unlisted';
  settings.madeForKids = !!opt.madeForKids;
  settings.categoryId = opt.categoryId || settings.categoryId;
  saveSettings();

  try {
    // 1) فحص الفيديو (محدث)
    live.phase = 'preparing'; pushState();
    const info = (live.video && live.video.file === settings.videoPath) ? live.video : await analyzeVideo(settings.videoPath);
    if (!info || !info.ok) return fail((info && info.error) || 'تعذّر فحص الفيديو');

    // 2) تيار RTMP
    log('جارٍ تجهيز تيار البث على YouTube…');
    const st = await yt.ensureLiveStream('LATCHI STREAM');
    if (!st.ok) return fail(st.error || 'تعذّر إنشاء تيار RTMP');
    live.stream = st.stream;
    log('تيار RTMP جاهز: ' + st.stream.ingestionAddress + (st.reused ? ' (مُعاد استعماله)' : ' (جديد)'), 'ok');

    // 3) البث
    const br = await yt.createBroadcast({
      title: settings.title, description: settings.description, privacy: settings.privacy,
      madeForKids: settings.madeForKids, categoryId: settings.categoryId
    });
    if (!br.ok) return fail(br.error || 'تعذّر إنشاء البث');
    live.broadcast = br.broadcast;
    log('أُنشئ البث: ' + br.broadcast.watchUrl, 'ok');

    // 4) ربط
    const bind = await yt.bindBroadcast(br.broadcast.id, st.stream.id);
    if (!bind.ok) return fail(bind.error || 'تعذّر ربط البث بالتيار');
    log('تم ربط البث بالتيار (bind)', 'ok');

    // 5) صورة مصغّرة (اختياري، لا يُفشل البث)
    if (settings.thumbnail && fs.existsSync(settings.thumbnail)) {
      const th = await yt.setThumbnail(br.broadcast.id, settings.thumbnail);
      if (th.ok) log('تم رفع الصورة المصغّرة', 'ok');
      else log('تعذّر رفع الصورة المصغّرة: ' + th.error, 'warn');
    }

    // 6) تشغيل ffmpeg
    const rtmp = yt.rtmpUrl(st.stream, false);
    const pf = progressFile();
    try { fs.writeFileSync(pf, ''); } catch (e) {}

    engine = new VideoStream.StreamEngine({ ffmpegPath: FFMPEG, ffprobePath: FFPROBE, onEnd: onStreamEnd, log });
    const startRes = engine.start(info, {
      file: settings.videoPath,
      rtmpUrl: rtmp,
      copySafe: info.copySafe,
      progressPath: pf,
      threads: settings.threads,
      preset: settings.preset,
      videoBitrate: settings.videoBitrate,
      audioBitrate: settings.audioBitrate,
      cwd: tmpDir()
    });
    if (!startRes.ok) return fail(startRes.error);

    live.phase = 'connecting';
    live.startedAt = Date.now();
    live.endedAt = 0;
    live.progress = { frame: 0, fps: 0, bitrate: '', outTimeMs: 0, speed: '', dropFrames: 0 };
    startProgressTimer();
    startHealthTimer();
    pushState();
    log('بدأ إرسال الفيديو إلى YouTube…', 'ok');
    return { ok: true, broadcast: live.broadcast, stream: { id: live.stream.id } };
  } catch (e) {
    return fail('خطأ غير متوقع: ' + (e && e.message));
  }
}

function fail(msg) {
  live.phase = 'error';
  live.error = String(msg || 'خطأ');
  stopTimers();
  log('فشل: ' + live.error, 'err');
  pushState();
  return { ok: false, error: live.error };
}

// ------------------------------------------------------------------ مراقبة التقدم
let progressTimer = null;
let healthTimer = null;

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    try {
      const txt = fs.readFileSync(progressFile(), 'utf8');
      const p = VideoStream.parseProgress(txt);
      if (p.frame || p.outTimeMs) {
        live.progress = p;
        const dur = (live.video && live.video.duration) || 0;
        const outSec = p.outTimeMs / 1000000;
        // ★ إيقاف تلقائي عند نهاية الملف الفعلية (بهوامش أمان)
        if (dur > 0 && outSec >= dur - 0.4 && live.phase !== 'stopping') {
          log('انتهى الفيديو — إيقاف تلقائي للبث', 'ok');
          stopLive({ auto: true });
          return;
        }
        pushState();
      }
    } catch (e) {}
  }, 1000);
}
function stopProgressTimer() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

// راقب حالة البث على YouTube: connecting → ready → live
function startHealthTimer() {
  stopHealthTimer();
  healthTimer = setInterval(async () => {
    if (!live.broadcast || !yt) return;
    try {
      const s = await yt.broadcastStatus(live.broadcast.id);
      if (!s.ok) return;
      const lc = s.lifeCycleStatus;
      if (lc === 'ready' && live.phase === 'connecting') {
        live.phase = 'ready';
        log('YouTube جاهز للبث (ready) — أكمل إلى live…', 'ok');
        pushState();
        // ننتظر ثانيتين ثم ننتقل إلى live
        setTimeout(async () => {
          if (live.phase !== 'ready') return;
          const t = await yt.transition(live.broadcast.id, 'live');
          if (t.ok) { live.phase = 'live'; log('البث صار LIVE على يوتيوب ✓', 'ok'); }
          else log('تعذّر الانتقال إلى live: ' + t.error, 'warn');
          pushState();
        }, 2000);
      } else if (lc === 'live' && live.phase !== 'live') {
        live.phase = 'live';
        log('البث صار LIVE على يوتيوب ✓', 'ok');
        pushState();
      } else if (lc === 'complete') {
        if (live.phase !== 'done') { live.phase = 'done'; pushState(); }
      }
      live.lastHealthPolls++;
    } catch (e) {}
  }, 3000);
}
function stopHealthTimer() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }
function stopTimers() { stopProgressTimer(); stopHealthTimer(); }

// ------------------------------------------------------------------ إيقاف البث
async function stopLive(opts) {
  const o = opts || {};
  if (live.phase === 'stopping' || live.phase === 'done') return { ok: true };
  const hadBroadcast = !!live.broadcast;
  live.phase = 'stopping';
  pushState();
  log(o.auto ? 'إيقاف تلقائي بعد نهاية الفيديو…' : 'إيقاف البث بناءً على طلبك…');

  // 1) أوقف ffmpeg بلطف
  if (engine && engine.running) {
    engine.stop(true);
    const t0 = Date.now();
    while (engine.running && Date.now() - t0 < 6000) await sleep(150);
    if (engine.running) { try { engine.stop(false); } catch (e) {} }
  }
  stopProgressTimer();

  // 2) أنهِ البث على YouTube عبر API — لا نترك بثاً عالقاً
  if (hadBroadcast && yt) {
    try {
      const st = await yt.broadcastStatus(live.broadcast.id);
      const lc = (st.ok && st.lifeCycleStatus) || '';
      if (lc !== 'complete') {
        const t = await yt.transition(live.broadcast.id, 'complete');
        if (t.ok) log('أُنهي البث على YouTube (complete) ✓', 'ok');
        else log('تعذّر إنهاء البث عبر API: ' + t.error, 'warn');
      }
    } catch (e) {}
  }
  stopHealthTimer();
  live.phase = 'done';
  live.endedAt = Date.now();
  live.autoStopped = !!o.auto;
  pushState();
  return { ok: true };
}

function onStreamEnd(info) {
  // ffmpeg خرج — إن كان طبيعياً ولا يوجد إيقاف جارٍ، أنهِ البث على YouTube
  if (!info) return;
  if (info.natural) {
    log('انتهى إرسال الفيديو (ffmpeg خرج بسلام)', 'ok');
    setTimeout(() => { if (live.phase !== 'done') stopLive({ auto: true }); }, 1200);
  } else if (!info.ok) {
    log('توقّف ffmpeg: ' + (info.error || ''), 'err');
    if (live.phase !== 'stopping' && live.phase !== 'done') {
      live.error = info.error || 'انقطع البث';
      setTimeout(() => { if (live.phase !== 'done') stopLive({ auto: true }); }, 800);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ IPC
function ipc() {
  ipcMain.handle('app:state', async () => stateForUi());

  // ---- OAuth ----
  ipcMain.handle('auth:connect', async () => {
    if (!auth.configured()) return { ok: false, error: 'أضف Google OAuth Client ID أولاً (زر الإعدادات)' };
    const r = await auth.connect();
    if (r.ok) { log('تم ربط حساب Google: ' + (r.profile.email || ''), 'ok'); pushState(); }
    else log('فشل الربط: ' + r.error, 'err');
    return r;
  });
  ipcMain.handle('auth:disconnect', async () => {
    await auth.disconnect();
    live.channel = null;
    settings.channelId = ''; settings.channelTitle = ''; settings.channelThumb = '';
    saveSettings();
    pushState();
    return { ok: true };
  });
  ipcMain.handle('auth:setClientId', async (e, id) => {
    const clean = String(id || '').trim();
    if (!/^[0-9A-Za-z._-]{20,}\.apps\.googleusercontent\.com$/.test(clean)) {
      return { ok: false, error: 'معرّف العميل غير صالح — يجب أن ينتهي بـ .apps.googleusercontent.com' };
    }
    settings.clientId = clean;
    try { fs.writeFileSync(clientsFile(), JSON.stringify({ clientId: clean })); } catch (err) {}
    auth.clientId = clean;
    pushState();
    return { ok: true };
  });
  ipcMain.handle('auth:status', async () => ({
    configured: auth.configured(), profile: auth.profile()
  }));

  // ---- القنوات ----
  ipcMain.handle('channels:list', async () => {
    if (!auth.connected()) return { ok: false, error: 'اربط حساب Google أولاً', channels: [] };
    const r = await yt.listChannels();
    if (!r.ok) return r;
    // إذا قناة واحدة ⇒ اختيار تلقائي
    if (r.channels.length === 1) {
      selectChannel(r.channels[0]);
    }
    return { ok: true, channels: r.channels, selected: settings.channelId };
  });
  ipcMain.handle('channels:select', async (e, channelId) => {
    const r = await yt.listChannels();
    if (!r.ok) return r;
    const ch = r.channels.find(c => c.id === channelId);
    if (!ch) return { ok: false, error: 'القناة غير موجودة ضمن حسابك' };
    selectChannel(ch);
    return { ok: true, channel: ch };
  });
  ipcMain.handle('categories:list', async () => {
    if (!auth.connected()) return { ok: false, categories: [] };
    return yt.categories();
  });

  // ---- الفيديو ----
  ipcMain.handle('video:pick', async () => pickVideo());
  ipcMain.handle('video:analyze', async (e, file) => analyzeVideo(String(file || '')));
  ipcMain.handle('video:clear', async () => {
    live.video = null; settings.videoPath = ''; settings.videoInfo = null; saveSettings(); pushState();
    return { ok: true };
  });

  // ---- صورة مصغّرة ----
  ipcMain.handle('thumbnail:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر صورة مصغّرة',
      properties: ['openFile'],
      filters: [{ name: 'صور', extensions: ['jpg', 'jpeg', 'png'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const f = r.filePaths[0];
    // YouTube: حد أقصى 2 ميغابايت
    const sz = fs.statSync(f).size;
    if (sz > 2 * 1024 * 1024) return { ok: false, error: 'حجم الصورة يتجاوز 2 ميغابايت (شرط يوتيوب)' };
    settings.thumbnail = f; saveSettings(); pushState();
    return { ok: true, thumbnail: f };
  });

  // ---- البث ----
  ipcMain.handle('live:start', async (e, o) => startLive(o));
  ipcMain.handle('live:stop', async () => stopLive({ auto: false }));
  ipcMain.handle('live:status', async () => {
    if (!live.broadcast) return { ok: false };
    const s = await yt.broadcastStatus(live.broadcast.id);
    return s;
  });
  ipcMain.handle('live:openUrl', async (e, url) => {
    if (/^https:\/\/(www\.)?(youtube\.com|studio\.youtube\.com|youtu\.be)/i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  // ---- أدوات ----
  ipcMain.handle('tools:status', async () => resolveTools());
  ipcMain.handle('tools:pickFfmpeg', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر ملف ffmpeg' + (IS_WIN ? '.exe' : ''),
      properties: ['openFile'],
      filters: [{ name: 'ffmpeg', extensions: IS_WIN ? ['exe'] : ['*'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const src = r.filePaths[0];
    const dst = path.join(ffBinDir(), path.basename(src));
    try { fs.copyFileSync(src, dst); } catch (e) { return { ok: false, error: 'تعذّر نسخ الملف' }; }
    // ffprobe عادة بجانبه
    const probeSrc = path.join(path.dirname(src), FFP_NAME);
    if (fs.existsSync(probeSrc)) { try { fs.copyFileSync(probeSrc, path.join(ffBinDir(), FFP_NAME)); } catch (e) {} }
    const t = await resolveTools();
    pushState();
    return { ok: t.ffmpeg, tools: t, error: t.ffmpeg ? '' : 'الملف لا يعمل كـ ffmpeg' };
  });
  ipcMain.handle('tools:openDir', async () => { try { await shell.openPath(ffBinDir()); } catch (e) {} return { ok: true }; });

  ipcMain.handle('shell:open', async (e, url) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { ok: true }; });
  ipcMain.handle('app:version', async () => ({ version: APP_VERSION }));
  ipcMain.handle('app:openUserData', async () => { try { await shell.openPath(dataDir()); } catch (e) {} return { ok: true }; });
}

function selectChannel(ch) {
  live.channel = ch;
  settings.channelId = ch.id;
  settings.channelTitle = ch.title;
  settings.channelThumb = ch.thumbnail || '';
  saveSettings();
  log('تم اختيار القناة: ' + ch.title, 'ok');
  pushState();
}

// ------------------------------------------------------------------ دورة الحياة
// ★ قفل النسخة الواحدة.
// ملاحظة مهمة: الإصدارات القديمة (3.x) لها نفس appId وتعمل في الخلفية (Tray)،
// فتمسك هذا القفل وتُغلق النسخة الجديدة بصمت. لذلك نُظهر تنبيهاً واضحاً بدل الخروج الصامت.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  try {
    const { dialog: d } = require('electron');
    app.whenReady().then(() => {
      d.showMessageBoxSync({
        type: 'warning',
        title: 'LATCHI STREAM',
        message: 'هناك نسخة أخرى من LATCHI STREAM تعمل بالفعل',
        detail: 'إن لم تظهر نافذتها، فهي مخفية في أيقونة الساعة (Tray) — وقد تكون نسخة قديمة (3.x).\n\n' +
                'الحل: انقر زر الفأرة الأيمن على أيقونة الساعة واختر «خروج»، أو استعمل ملف «شغّل-التنظيف.cmd» لإزالة النسخة القديمة نهائياً.'
      });
    });
  } catch (e) {}
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    loadAll();
    Menu.setApplicationMenu(null);
    log('LATCHI STREAM v' + APP_VERSION + ' — ' + (process.windowsStore ? 'Store' :
        (process.env.PORTABLE_EXECUTABLE_DIR ? 'نسخة محمولة' : 'نسخة مثبّتة')) + ' · ' + process.platform);

    auth = new GoogleAuth({
      clientId: settings.clientId,
      file: oauthFile(),
      openExternal: u => shell.openExternal(u),
      log: m => log(m)
    });
    yt = new YouTubeApi(auth);

    await resolveTools();

    ipc();
    createWindow();

    if (FFMPEG) log('ffmpeg جاهز: ' + FFMPEG);
    else log('تنبيه: ffmpeg غير متاح — استخدم «اختيار ffmpeg يدوياً» من الواجهة', 'warn');
    if (FFPROBE) log('ffprobe جاهز: ' + FFPROBE);
    else log('تنبيه: ffprobe غير متاح — لا يمكن فحص الفيديو', 'warn');
    if (!auth.configured()) log('تنبيه: Google OAuth Client ID غير مضبوط بعد', 'warn');
  });

  app.on('window-all-closed', async () => {
    if (live.phase === 'live' || live.phase === 'connecting' || live.phase === 'ready') {
      await stopLive({ auto: true });
    }
    app.quit();
  });
  app.on('before-quit', async () => {
    if (live.broadcast && live.phase !== 'done') {
      try { await yt.transition(live.broadcast.id, 'complete'); } catch (e) {}
    }
  });
}

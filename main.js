// ==============================================================================================
// LATCHI STREAM 3.0.0  -  تطبيق حاسوب حقيقي (Electron)  -  العملية الرئيسية
// ----------------------------------------------------------------------------------------------
// كل شيء داخل نافذة التطبيق: لا متصفح خارجي، لا خادم ويب، لا منفذ مفتوح.
// المعاينة، القص، الزوم، البانر، العنوان، والبث الفعلي إلى يوتيوب كلها هنا.
// ==============================================================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const core = require(path.join(__dirname, 'core', 'LatchiCore.js'));

// نسخة التطبيق: من package.json (لا من نسخة Electron)
const PKG = (() => { try { return require(path.join(__dirname, 'package.json')); } catch (e) { return { version: '3.0.0' }; } })();
const APP_VERSION = PKG.version || '3.0.0';

let win = null;
let previewProc = null;      // مراقب المعاينة (mjpeg)
let liveProc = null;         // البث الحي
let liveStarted = null;
let liveServer = '';
let lastError = '';
let blockedAudio = [];
let FFMPEG = null;

// مسار مؤقت سريع (لا تخلطه بملفات المستخدم)
function tmpDir() {
  const d = path.join(app.getPath('userData'), 'cache');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const previewFile  = () => path.join(tmpDir(), 'preview.jpg');
const progressFile = () => path.join(tmpDir(), 'progress.txt');

// ------------------------------------------------------------------ اكتشاف ffmpeg
function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'ffmpeg', exe));
  cands.push(path.join(__dirname, 'resources', 'ffmpeg', exe));
  cands.push(path.join(path.dirname(app.getPath('exe')), exe));
  cands.push(path.join(path.dirname(app.getPath('exe')), 'ffmpeg', exe));
  cands.push(path.join(path.dirname(app.getPath('exe')), 'tools', exe));
  if (process.platform === 'win32') cands.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  const PATH = process.env.PATH || process.env.Path || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

// ------------------------------------------------------------------ الإعدادات
function cfgDir() {
  const d = app.getPath('userData');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const settingsPath = () => path.join(cfgDir(), 'settings.json');

// مسار البانر الرسمي المرفق بالتطبيق
function bundledBanner() {
  const cands = [];
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'banner-1920x1080.png'));
  cands.push(path.join(__dirname, 'assets', 'banner-1920x1080.png'));
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return '';
}

// خط النظام الافتراضي للعناوين
function systemFont() {
  const list = process.platform === 'win32'
    ? ['C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf',
       'C:\\Windows\\Fonts\\tahomabd.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
    : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
       '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
       '/System/Library/Fonts/Helvetica.ttc'];
  for (const f of list) { try { if (fs.existsSync(f)) return f; } catch (e) {} }
  return '';
}

let settings = null;
function loadSettings() {
  const def = core.defaultSettings();
  try {
    if (fs.existsSync(settingsPath())) {
      settings = core.mergeSettings(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), def);
      return settings;
    }
  } catch (e) { /* تجاهل */ }
  settings = def;
  return settings;
}

// يُستدعى بعد loadSettings: يضمن وجود مسار بانر وخط عنوان صالحين
function ensureAssets() {
  let changed = false;
  if (!settings.bannerPath || !fs.existsSync(settings.bannerPath)) {
    const b = bundledBanner();
    if (b) { settings.bannerPath = b; changed = true; }
  }
  if (!settings.titleFont || !fs.existsSync(settings.titleFont)) {
    const f = systemFont();
    if (f) { settings.titleFont = f; changed = true; }
  }
  if (changed) saveSettings();
  return settings;
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}

// ------------------------------------------------------------------ أدوات
function killTree(p) {
  if (!p || !p.pid) return;
  try { p.kill(); } catch (e) {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(p.pid), '/F', '/T'], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
  }
}

function run(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', done = false;
    let p;
    try { p = spawn(exe, args, { windowsHide: true }); }
    catch (e) { return resolve({ code: -1, out: String(e) }); }
    const t = setTimeout(() => { if (!done) killTree(p); }, timeoutMs || 20000);
    const acc = d => { if (out.length < 400000) out += d.toString(); };
    p.stdout.on('data', acc);
    p.stderr.on('data', acc);
    p.on('close', c => { done = true; clearTimeout(t); resolve({ code: c, out }); });
    p.on('error', e => { done = true; clearTimeout(t); resolve({ code: -1, out: String(e) }); });
  });
}

function ffmpegRun(args, timeoutMs) {
  if (!FFMPEG) return Promise.resolve({ code: -1, out: 'ffmpeg غير موجود' });
  return run(FFMPEG, ['-hide_banner', '-nostdin'].concat(args), timeoutMs);
}

// ------------------------------------------------------------------ الأجهزة والمرمّزات
async function listAudioDevices() {
  const r = await ffmpegRun(['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 25000);
  const raw = [];
  const re = /"([^"]+)"\s+\(audio\)/g;
  let m;
  while ((m = re.exec(r.out)) !== null) raw.push(m[1]);
  const sel = core.selectSystemAudioDevices(raw);
  blockedAudio = sel.blocked;
  return sel;
}

async function listEncoders() {
  const r = await ffmpegRun(['-encoders'], 20000);
  const have = [];
  for (const w of ['libx264', 'h264_qsv', 'h264_amf', 'h264_nvenc']) {
    if (new RegExp('\\b' + w + '\\b').test(r.out)) have.push(w);
  }
  return have.length ? have : ['libx264'];
}

// ------------------------------------------------------------------ المعاينة (ذكية)
// تُبثّ إطارات مخففة، وتُطبَّق عليها:
//   - طبقة البانر (إن كان مفعّلاً)
//   - العنوان النصي (كطبقة HTML في الواجهة، لا تُحرق في الصورة)
// القص والزوم يُرسمان في الواجهة فوق الصورة (بلا حمل إضافي).
// تُبنى في النواة حتى تبقى قابلة للاختبار
function previewArgs(s) { return core.buildPreviewArgs(Object.assign({}, s, { _previewOut: previewFile() })); }

function startPreview(s) {
  stopPreview();
  if (!FFMPEG) return { ok: false, error: 'ffmpeg.exe غير موجود بجانب التطبيق' };
  // نسخة محلية: لا نكتب التراجع على القرص وإلا عاد المصدر إلى «كل الشاشة»
  const use = Object.assign({}, s);
  if (use.captureMode === 'window' && !String(use.windowTitle || '').trim()) {
    use.captureMode = 'desktop';
  }
  const args = previewArgs(use);
  try {
    previewProc = spawn(FFMPEG, args, { windowsHide: true });
  } catch (e) { return { ok: false, error: 'تعذّر تشغيل ffmpeg: ' + e.message }; }

  let err = '';
  previewProc.stderr.on('data', d => { if (err.length < 12000) err += d.toString(); });
  previewProc.on('close', () => { previewProc = null; });
  previewProc.on('error', () => { previewProc = null; });
  return { ok: true, args };
}

function stopPreview() {
  if (previewProc) { killTree(previewProc); previewProc = null; }
  try { if (fs.existsSync(previewFile())) fs.unlinkSync(previewFile()); } catch (e) {}
}

function readPreviewFrame() {
  try {
    const f = previewFile();
    if (!fs.existsSync(f)) return null;
    const st = fs.statSync(f);
    if (st.size < 800) return null;
    const buf = fs.readFileSync(f);
    if (!core.isJpeg(buf)) return null;
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (e) { return null; }
}

// ------------------------------------------------------------------ اختبار المفتاح
async function testKey(key) {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg.exe غير موجود' };
  const shape = core.testKeyShape(core.cleanStreamKey(key || core.embeddedKey()));
  if (!shape.ok) return { ok: false, error: shape.error };

  const eps = core.youtubeEndpoints(shape.key);
  const args = ['-loglevel', 'debug',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x120:r=5', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-b:v', '150k', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-an', '-f', 'flv', eps[0].url];

  const r = await ffmpegRun(args, 30000);
  const out = r.out;
  if (/Connection refused|Connection reset|Network is unreachable|No route to host|Could not resolve/.test(out)) {
    return { ok: false, error: 'تعذّر الوصول إلى خادم يوتيوب. تحقق من الإنترنت.' };
  }
  if (/Error opening output|Input\/output error|Failed to update header/i.test(out)) {
    return { ok: false, error: 'يوتيوب رفض المفتاح. تأكد أنك نسخته كاملاً وأن البث ما زال مُنشأً في YouTube Studio.' };
  }
  if (/Successfully opened the file/.test(out)) {
    return { ok: true, message: 'يوتيوب قبل المفتاح — البث جاهز للانطلاق', server: eps[0].name };
  }
  if (/Sending publish command/.test(out) && r.code === 0) {
    return { ok: true, message: 'يوتيوب قبل المفتاح — البث جاهز للانطلاق', server: eps[0].name };
  }
  if (/Sending publish command/.test(out)) {
    return { ok: false, error: 'يوتيوب رفض المفتاح.' };
  }
  const tail = out.split('\n').filter(x => x.trim()).slice(-4).join(' · ');
  return { ok: false, error: ('لم يتأكد الاتصال: ' + tail).slice(0, 600) };
}

// ------------------------------------------------------------------ البث الحي
function startLive(s) {
  return new Promise(async (resolve) => {
    if (!FFMPEG) return resolve({ ok: false, error: 'ffmpeg.exe غير موجود' });

    const built = core.buildLiveArgs(s, progressFile(), 'primary');
    if (!built.ok) return resolve({ ok: false, error: built.errors.join(' ') });

    stopLive();
    try { fs.writeFileSync(progressFile(), ''); } catch (e) {}

    const attempt = (which) => new Promise((res) => {
      const b = core.buildLiveArgs(s, progressFile(), which);
      if (!b.ok) return res({ ok: false, error: b.errors.join(' ') });

      let err = '';
      let p;
      try { p = spawn(FFMPEG, b.args, { windowsHide: true }); }
      catch (e) { return res({ ok: false, error: 'تعذّر تشغيل ffmpeg: ' + e.message }); }

      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; res(v); } };

      p.stderr.on('data', d => { if (err.length < 60000) err += d.toString(); });
      p.on('error', e => { clearTimeout(timer); settle({ ok: false, error: String(e && e.message || e) }); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (!settled) {
          const tail = err.split('\n').map(x => x.trim()).filter(Boolean).slice(-5).join(' · ');
          return settle({ ok: false, error: (tail || ('ffmpeg خرج بالكود ' + code)).slice(0, 900) });
        }
        // كان يعمل ثم توقف
        if (liveProc === p) {
          liveProc = null; liveStarted = null;
          lastError = 'توقف البث (كود ' + code + ')';
          if (win) win.webContents.send('stream-ended', { code, error: lastError });
        }
      });

      // معيار النجاح: صمد 3 ثوانٍ دون موت
      const timer = setTimeout(() => {
        if (p.exitCode === null) {
          liveProc = p;
          liveStarted = new Date();
          liveServer = which;
          settle({ ok: true, pid: p.pid, server: which });
        }
      }, 3000);
    });

    let r = await attempt('primary');
    if (!r.ok) {
      if (win) win.webContents.send('log', 'الخادم الرئيسي لم يستجب — تجريب الاحتياطي…');
      const r2 = await attempt('backup');
      if (r2.ok) return resolve(r2);
      return resolve({ ok: false, error: 'فشل البث على الخادمين:\n' + r.error });
    }
    resolve(r);
  });
}

function stopLive() {
  if (liveProc) { killTree(liveProc); liveProc = null; }
  liveStarted = null; liveServer = '';
  try { fs.writeFileSync(progressFile(), ''); } catch (e) {}
}

function readProgress() {
  const r = { fps: 0, dropped: 0, bitrate: '' };
  try {
    const txt = fs.readFileSync(progressFile(), 'utf8');
    const a = [...txt.matchAll(/fps=([\d.]+)/g)];
    const b = [...txt.matchAll(/drop_frames=(\d+)/g)];
    const c = [...txt.matchAll(/bitrate=\s*([\d.]+\w+)/g)];
    if (a.length) r.fps = parseFloat(a[a.length - 1][1]) || 0;
    if (b.length) r.dropped = parseInt(b[b.length - 1][1], 10) || 0;
    if (c.length) r.bitrate = c[c.length - 1][1];
  } catch (e) {}
  return r;
}

// ------------------------------------------------------------------ النافذة
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1200, minHeight: 780,
    backgroundColor: '#070b12', show: false, autoHideMenuBar: true,
    title: 'LATCHI STREAM ' + APP_VERSION,
    icon: (() => {
      const a = path.join(__dirname, 'assets', 'icon', 'icon.ico');
      const b = path.join(__dirname, 'build', 'icon.ico');
      try { if (fs.existsSync(a)) return a; } catch (e) {}
      return b;
    })(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); shell.openExternal(url); }
  });
}

// ------------------------------------------------------------------ IPC
function ipc() {
  ipcMain.handle('app:info', async () => ({
    version: APP_VERSION,
    ffmpeg: FFMPEG, ffmpegOk: !!FFMPEG,
    platform: process.platform,
    userData: cfgDir(),
    bannerPath: settings ? settings.bannerPath : bundledBanner(),
    bundledBanner: bundledBanner(),
    fontPath: settings ? settings.titleFont : systemFont(),
    portable: !!process.env.PORTABLE_EXECUTABLE_DIR
  }));

  ipcMain.handle('settings:get', async () => settings);
  ipcMain.handle('settings:set', async (e, patch) => {
    if (patch && typeof patch === 'object') Object.assign(settings, patch);
    settings.audioMode = 'system';
    saveSettings();
    return { ok: true, settings };
  });
  // لا تسمح لكائن قديم من الواجهة بمحو مسار بانر أو خط محفوظين
  function mergeRuntime(s) {
    const p = Object.assign({}, s || {});
    if (!p.bannerPath && settings.bannerPath) p.bannerPath = settings.bannerPath;
    if (!p.titleFont && settings.titleFont) p.titleFont = settings.titleFont;
    if (!p.youtubeKey && settings.youtubeKey) p.youtubeKey = settings.youtubeKey;
    Object.assign(settings, p);
    settings.audioMode = 'system';
    saveSettings();
    return settings;
  }

  ipcMain.handle('audio:list', async () => {
    const sel = await listAudioDevices();
    return { ok: true, devices: sel.devices, blocked: blockedAudio };
  });
  ipcMain.handle('encoders:list', async () => ({ ok: true, encoders: await listEncoders() }));

  ipcMain.handle('key:embedded', async () => {
    const k = core.embeddedKey();
    return { ok: !!k, hasKey: !!k, masked: k ? (k.slice(0, 4) + '-••••-••••-' + k.slice(-3)) : '••••' };
  });
  ipcMain.handle('key:test', async (e, k) => testKey(k));

  // ---- المعاينة
  ipcMain.handle('preview:start', async (e, s) => {
    return startPreview(mergeRuntime(s));
  });
  ipcMain.handle('preview:stop', async () => { stopPreview(); return { ok: true }; });
  ipcMain.handle('preview:frame', async () => ({ on: !!previewProc, frame: readPreviewFrame() }));

  // ---- البث
  ipcMain.handle('stream:start', async (e, s) => {
    const r = await startLive(mergeRuntime(s));
    if (r.ok) stopPreview();     // تحرير المعالج للبث
    return r;
  });
  ipcMain.handle('stream:stop', async () => { stopLive(); return { ok: true }; });

  ipcMain.handle('state:get', async () => {
    const pr = readProgress();
    let elapsed = '—';
    if (liveStarted) {
      const sec = Math.floor((Date.now() - liveStarted.getTime()) / 1000);
      elapsed = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
        .map(x => String(x).padStart(2, '0')).join(':');
    }
    return {
      streaming: !!liveProc, previewOn: !!previewProc,
      fps: pr.fps, dropped: pr.dropped, bitrate: pr.bitrate,
      elapsed, lastError, server: liveServer, ffmpeg: !!FFMPEG
    };
  });

  // ---- النوافذ
  ipcMain.handle('window:list', async () => {
    if (process.platform !== 'win32') return { ok: true, windows: [] };
    const ps = `
$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class LW {
  delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  static List<string> R = new List<string>();
  static bool C(IntPtr h, IntPtr l) {
    try {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int n = GetWindowTextLength(h);
      if (n <= 0) return true;
      var sb = new StringBuilder(n + 2);
      GetWindowTextW(h, sb, sb.Capacity);
      string t = sb.ToString().Trim();
      if (t.Length > 0 && !R.Contains(t)) R.Add(t);
    } catch {}
    return true;
  }
  public static string[] Titles() { R = new List<string>(); EnumWindows(new E(C), IntPtr.Zero); return R.ToArray(); }
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop
[LW]::Titles() | ConvertTo-Json -Compress
`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 25000);
    let list = [];
    try { list = JSON.parse((r.out || '').trim() || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [list];
    return { ok: true, windows: list.filter(x => typeof x === 'string' && x.trim()) };
  });

  // نافذة نشطة بعد إخفاء التطبيق (اختيار بالماوس)
  ipcMain.handle('window:pickByMouse', async () => {
    if (process.platform !== 'win32') return { ok: false, error: 'غير مدعوم على هذه المنصة' };
    const wasVisible = win && win.isVisible();
    if (win) win.hide();
    await new Promise(r => setTimeout(r, 2600));
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WP {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static string Title(int x, int y) {
    var pt = new POINT(); pt.X = x; pt.Y = y;
    IntPtr h = WindowFromPoint(pt);
    if (h == IntPtr.Zero) return "";
    IntPtr root = GetAncestor(h, 2);
    if (root != IntPtr.Zero) h = root;
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new StringBuilder(n + 2);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString().Trim();
  }
}
"@
[WP]::Title($p.X, $p.Y)
`;
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 20000);
    if (wasVisible && win) { win.show(); win.focus(); }
    const title = (r.out || '').trim().split(/\r?\n/).pop().trim();
    if (!title) return { ok: false, error: 'لم يُعثر على نافذة تحت المؤشر' };
    return { ok: true, title };
  });

  // ---- اختيار ملفات
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر صورة البانر',
      filters: [{ name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    const dest = path.join(cfgDir(), 'banner-custom.png');
    try {
      fs.copyFileSync(r.filePaths[0], dest);
      // حوّل إلى PNG دائماً لتفادي مشاكل المسارات
      try {
        const im = nativeImage.createFromPath(dest);
        if (!im.isEmpty()) fs.writeFileSync(dest, im.toPNG());
      } catch (e) {}
      return { ok: true, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('dialog:font', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'اختر ملف خط',
      filters: [{ name: 'خطوط', extensions: ['ttf', 'otf', 'ttc'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    const dest = path.join(cfgDir(), 'font' + path.extname(r.filePaths[0]));
    try { fs.copyFileSync(r.filePaths[0], dest); return { ok: true, path: dest }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  // خط النظام الافتراضي للعناوين
  ipcMain.handle('font:default', async () => {
    const f = systemFont();
    return f ? { ok: true, path: f } : { ok: false };
  });

  ipcMain.handle('shell:open', async (e, url) => {
    try { await shell.openExternal(String(url)); return { ok: true }; } catch (x) { return { ok: false }; }
  });

  ipcMain.handle('fullscreen:get', async () => ({ full: win ? win.isFullScreen() : false }));
  ipcMain.handle('fullscreen:set', async (e, on) => { if (win) win.setFullScreen(!!on); return { ok: true }; });
}

// ------------------------------------------------------------------ دورة الحياة
app.whenReady().then(() => {
  FFMPEG = findFfmpeg();
  loadSettings();
  ensureAssets();
  Menu.setApplicationMenu(null);
  ipc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  stopPreview(); stopLive();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { stopPreview(); stopLive(); });
process.on('exit', () => { stopPreview(); stopLive(); });

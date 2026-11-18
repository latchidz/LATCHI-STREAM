// ==============================================================================================
// LATCHI STREAM 3.2.1  -  تطبيق حاسوب حقيقي (Electron)  -  العملية الرئيسية
// ----------------------------------------------------------------------------------------------
// كل شيء داخل نافذة التطبيق: لا متصفح خارجي، لا خادم ويب، لا منفذ مفتوح.
// المعاينة، القص، الزوم، البانر، العنوان، والبث الفعلي إلى يوتيوب كلها هنا.
// جديد 3.2.0: نظام ffmpeg مضاد للفشل (المجلد الدائم + استثناء Defender + لوحة إصلاح)،
//             أوضاع شاشة سريعة (fast/fastlight) للمعالجات الضعيفة مثل Celeron N3060.
// 3.1.0: البث في الخلفية (إخفاء النافذة لا يوقف البث)، أيقونة Tray بمشغّل بث،
//             إعادة اتصال تلقائي عند الانقطاع، مانع سكون، متصفح مدمج بشاشة كاملة + ESC ×2.
// ==============================================================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage, Tray, powerSaveBlocker } = require('electron');
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
let tray = null;             // أيقونة الخلفية (Tray)
let quitting = false;        // خروج نهائي حقيقي (من أيقونة الساعة)
let psBlockerId = null;      // مانع السكون أثناء البث

// مسار مؤقت سريع (لا تخلطه بملفات المستخدم)
function tmpDir() {
  // ★ ذاكرة مؤقتة دائمة في %TEMP% (تُفرَّغ تلقائياً) — لا نستهلك قرص المستخدم
  const d = path.join(os.tmpdir(), 'latchi-stream');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}
const previewFile  = () => path.join(tmpDir(), 'preview.jpg');
const progressFile = () => path.join(tmpDir(), 'progress.txt');

// ------------------------------------------------------------------ اكتشاف ffmpeg (نسخة مضادة للفشل)
// ★ سبب العطل الشهير في النسخة Portable: ffmpeg.exe يُفكّ في %TEMP%\...\resources\ffmpeg
//   فيمنعه Windows Defender (ASR) من التنفيذ ⇒ spawn ENOENT رغم وجود الملف.
//   الحل: مسارات دائمة + نسخة في userData\bin + استثناء Defender + تشغيل بمسار مطلق.
const IS_WIN = process.platform === 'win32';
const FF_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';
const FF_MIN_BYTES = 1000000;   // أقل من هذا = ملف تالف/ناقص

function ffBinDir() {
  const d = path.join(cfgDir(), 'bin');
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function ffmpegCandidates() {
  const c = [];
  // 1) النسخة الدائمة المثبّتة (المفضّلة — خارج %TEMP%)
  c.push(path.join(ffBinDir(), FF_NAME));
  c.push(path.join(cfgDir(), FF_NAME));
  // 2) داخل الحزمة
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'ffmpeg', FF_NAME));
  c.push(path.join(__dirname, 'resources', 'ffmpeg', FF_NAME));
  // 3) بجانب التطبيق (نسخة ZIP — المسار المستقر D:\LATCHI)
  const exeDir = path.dirname(app.getPath('exe'));
  c.push(path.join(exeDir, FF_NAME));
  c.push(path.join(exeDir, 'ffmpeg', FF_NAME));
  c.push(path.join(exeDir, 'resources', 'ffmpeg', FF_NAME));
  c.push(path.join(exeDir, 'tools', FF_NAME));
  c.push(path.join(exeDir, 'bin', FF_NAME));
  // 4) مسارات نظام شائعة
  if (IS_WIN) {
    c.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
    const la = process.env.LOCALAPPDATA;
    if (la) c.push(path.join(la, 'LatchiStream', 'ffmpeg.exe'));
  }
  // 5) PATH
  const PATH = process.env.PATH || process.env.Path || '';
  for (const dir of PATH.split(path.delimiter)) {
    if (dir) c.push(path.join(dir, FF_NAME));
  }
  // إزالة التكرار مع حفظ الترتيب
  const seen = new Set(); const out = [];
  for (const x of c) { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

function isUsableFf(p) {
  try { const st = fs.statSync(p); return st.isFile() && st.size > FF_MIN_BYTES; } catch (e) { return false; }
}

// تنفيذ فعلي للتحقق: ffmpeg -version ⇒ يجب أن يطبع «ffmpeg version» ويخرج بالكود 0
function ffmpegWorks(p, timeoutMs) {
  return new Promise(resolve => {
    if (!isUsableFf(p)) return resolve({ ok: false, reason: 'الملف مفقود أو صغير جداً', version: '' });
    let out = '', done = false;
    let pr;
    try { pr = spawn(p, ['-hide_banner', '-version'], { windowsHide: true, cwd: tmpDir() }); }
    catch (e) { return resolve({ ok: false, reason: 'spawn فشل: ' + e.message, version: '' }); }
    const fin = r => { if (!done) { done = true; clearTimeout(to); resolve(r); } };
    const to = setTimeout(() => { try { killTree(pr); } catch (e) {} fin({ ok: false, reason: 'انتهت المهلة (' + (timeoutMs||8000) + 'ms) — غالباً منع أمني', version: '' }); }, timeoutMs || 8000);
    pr.stdout.on('data', d => { out += d.toString(); });
    pr.stderr.on('data', d => { out += d.toString(); });
    pr.on('error', e => fin({ ok: false, reason: 'خطأ التنفيذ: ' + (e.code || e.message), version: '' }));
    pr.on('close', code => {
      const m = /ffmpeg version\s+(\S+)/i.exec(out);
      if (code === 0 && m) fin({ ok: true, reason: '', version: m[1] });
      else fin({ ok: false, reason: 'خرج بالكود ' + code + (m ? '' : ' بلا بصمة إصدار'), version: m ? m[1] : '' });
    });
  });
}

// تثبيت دائم: نسخ ffmpeg إلى userData\bin (خارج %TEMP%) + محاولة استثناء Defender
function installFfmpegPermanent(src) {
  try {
    const dst = path.join(ffBinDir(), FF_NAME);
    if (path.resolve(src).toLowerCase() !== path.resolve(dst).toLowerCase()) {
      fs.copyFileSync(src, dst);
    }
    // إزالة علامة «ملف من الإنترنت» التي تُفعّل فحص ASR
    if (IS_WIN) {
      try {
        const zone = dst + ':Zone.Identifier';
        if (fs.existsSync(zone)) fs.unlinkSync(zone);
      } catch (e) {}
      // استثناء Defender لمجلدنا (قد يفشل بلا صلاحيات — غير حرج)
      try {
        const { execFile } = require('child_process');
        const cmd = 'Add-MpPreference -ExclusionPath "' + ffBinDir() + '"; Add-MpPreference -ExclusionProcess "' + FF_NAME + '"';
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', cmd],
          { windowsHide: true, timeout: 15000 }, () => {});
      } catch (e) {}
    }
    return isUsableFf(dst) ? dst : '';
  } catch (e) { return ''; }
}

// الاختيار النهائي: أول مرشّح يعمل فعلياً ⇒ انسخه لمسار دائم إن كان في %TEMP%
async function resolveFfmpeg(force) {
  const cands = ffmpegCandidates();
  const permanent = path.join(ffBinDir(), FF_NAME);
  const inTemp = p => { const t = (os.tmpdir() || '').toLowerCase(); return p.toLowerCase().startsWith(t); };

  for (const c of cands) {
    if (!isUsableFf(c)) continue;
    // الموجود في %TEMP% قد يُحجب — نجرّبه أولاً ثم ننسخه
    const r = await ffmpegWorks(c);
    if (r.ok) {
      if (inTemp(c) || path.resolve(c).toLowerCase() !== path.resolve(permanent).toLowerCase()) {
        const perm = installFfmpegPermanent(c);
        if (perm) {
          const r2 = await ffmpegWorks(perm);
          if (r2.ok) { FFMPEG = perm; return { ok: true, path: perm, version: r2.version, note: 'ثُبّت في مجلد دائم' }; }
        }
      }
      FFMPEG = c;
      return { ok: true, path: c, version: r.version, note: 'يعمل من مكانه' };
    }
  }
  FFMPEG = null;
  return { ok: false, path: '', version: '', note: 'لم يُعثر على ffmpeg صالح للتنفيذ' };
}

// تشغيل ffmpeg بمسار مطلق وبمجلد عمل آمن (يمنع مشاكل %TEMP% والصلاحيات)
function spawnFfmpeg(args, opts) {
  const o = Object.assign({ windowsHide: true, cwd: tmpDir(), stdio: ['ignore', 'pipe', 'pipe'] }, opts || {});
  if (!FFMPEG) return null;
  try { return spawn(FFMPEG, args, o); } catch (e) { return null; }
}

async function ffmpegStatus() {
  const found = ffmpegCandidates().filter(isUsableFf);
  let version = '';
  if (FFMPEG) { const r = await ffmpegWorks(FFMPEG, 8000); if (r.ok) version = r.version; else FFMPEG = null; }
  return {
    ok: !!FFMPEG,
    path: FFMPEG || '',
    version,
    permanentDir: ffBinDir(),
    foundCount: found.length,
    searched: ffmpegCandidates().slice(0, 12)
  };
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

// إرسال آمن للواجهة (حتى لو كانت النافذة مخفية أو مُخرَّبة)
function safeSend(ch, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); } catch (e) {}
}

function fmtElapsed() {
  if (!liveStarted) return '';
  const sec = Math.floor((Date.now() - liveStarted.getTime()) / 1000);
  return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    .map(x => String(x).padStart(2, '0')).join(':');
}

// مانع السكون: يمنع ويندوز من إسبات الجهاز أثناء البث
function startPowerBlocker() {
  try { if (psBlockerId === null) psBlockerId = powerSaveBlocker.start('prevent-app-suspension'); } catch (e) {}
}
function stopPowerBlocker() {
  try { if (psBlockerId !== null) { powerSaveBlocker.stop(psBlockerId); psBlockerId = null; } } catch (e) {}
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
  return run(FFMPEG, ['-hide_banner', '-nostdin'].concat(args), timeoutMs, tmpDir());
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
    previewProc = spawnFfmpeg(args);
    if (!previewProc) return { ok: false, error: 'ffmpeg غير قابل للتنفيذ — افتح لوحة الإصلاح' };
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
// ★ نجاح الاتصال ≠ نجاح البث: يُقرأ معدل الإطارات الحقيقي بعد 12 ثانية ويُرفض البث الكاذب.
// ★ عند الانقطاع المفاجئ يعاد الاتصال تلقائياً حتى restartMax مرات (إعداد autoRestart).
const RESTART_DELAY = 3000;
let liveArgs = null;        // آخر أمر بث ناجح — يُستعمل لإعادة الاتصال
let restartCount = 0;       // عدّاد إعادة الاتصال للجلسة الحالية
let restartTimer = null;
let userStop = false;       // true = الإيقاف بطلب المستخدم (بلا إعادة اتصال)

function restartMax() {
  return Math.max(1, parseInt((settings && settings.restartMax) || 5, 10) || 5);
}

function spawnLive(args) {
  let p;
  try { p = spawnFfmpeg(args); if (!p) return res({ ok: false, error: 'ffmpeg غير قابل للتنفيذ' }); }
  catch (e) { return null; }

  p.on('close', (code) => {
    if (liveProc !== p) return;           // عملية قديمة أو أُوقفت بطلب المستخدم
    liveProc = null; liveStarted = null;
    stopPowerBlocker();
    updateTray();
    if (userStop || quitting) return;
    // انقطاع غير متوقع → إعادة اتصال تلقائية
    if (settings && settings.autoRestart !== false && liveArgs && restartCount < restartMax()) {
      restartCount++;
      lastError = 'انقطع البث (كود ' + code + ') — إعادة اتصال ' + restartCount + '/' + restartMax();
      safeSend('log', lastError);
      safeSend('stream-restarting', { attempt: restartCount, max: restartMax(), error: lastError });
      scheduleRestart();
    } else {
      lastError = 'توقف البث (كود ' + code + ')';
      liveArgs = null;
      safeSend('stream-ended', { code, error: lastError });
    }
  });
  return p;
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (quitting || userStop || !liveArgs || !FFMPEG) return;
    try { fs.writeFileSync(progressFile(), ''); } catch (e) {}
    const p = spawnLive(liveArgs);
    if (!p) return;
    // إن صمد 6 ثوانٍ فقد عاد البث فعلاً
    setTimeout(() => {
      if (liveProc === p && p.exitCode === null && !userStop && !quitting) {
        liveStarted = new Date();
        startPowerBlocker();
        updateTray();
        safeSend('log', '✓ عاد البث للعمل بعد إعادة الاتصال رقم ' + restartCount);
        safeSend('stream-restarted', { attempt: restartCount });
      }
    }, 6000);
  }, RESTART_DELAY);
}

function runAttempt(s, which) {
  return new Promise((res) => {
    const b = core.buildLiveArgs(s, progressFile(), which);
    if (!b.ok) return res({ ok: false, error: b.errors.join(' ') });

    userStop = false; restartCount = 0;
    let err = '';
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; res(v); } };

    const p = spawnLive(b.args);
    if (!p) return res({ ok: false, error: 'تعذّر تشغيل ffmpeg' });

    p.stderr.on('data', d => { if (err.length < 60000) err += d.toString(); });
    p.on('error', e => { clearTimeout(timer); settle({ ok: false, error: String(e && e.message || e) }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        const tail = err.split('\n').map(x => x.trim()).filter(Boolean).slice(-5).join(' · ');
        settle({ ok: false, error: (tail || ('ffmpeg خرج بالكود ' + code)).slice(0, 900) });
      }
    });

    // معيار النجاح المبدئي: صمد 3 ثوانٍ دون موت
    const timer = setTimeout(() => {
      if (p.exitCode === null) {
        liveProc = p;
        liveStarted = new Date();
        liveServer = which;
        liveArgs = b.args;
        settle({ ok: true, pid: p.pid, server: which });
      }
    }, 3000);
  });
}

function startLive(s) {
  return new Promise(async (resolve) => {
    if (!FFMPEG) return resolve({ ok: false, error: 'ffmpeg.exe غير موجود' });

    const built = core.buildLiveArgs(s, progressFile(), 'primary');
    if (!built.ok) return resolve({ ok: false, error: built.errors.join(' ') });

    stopLive();
    try { fs.writeFileSync(progressFile(), ''); } catch (e) {}

    let r = await runAttempt(s, 'primary');
    if (r.ok) {
      r = await verifyThroughput(s);
    }
    if (!r.ok) {
      if (liveProc) { killTree(liveProc); liveProc = null; }
      safeSend('log', 'الخادم الرئيسي لم يستجب — تجريب الاحتياطي…');
      const r2 = await runAttempt(s, 'backup');
      if (r2.ok) {
        const v = await verifyThroughput(s);
        if (v.ok) { startPowerBlocker(); updateTray(); return resolve(v); }
        stopLive();
        return resolve(v);
      }
      return resolve({ ok: false, error: 'فشل البث على الخادمين:\n' + r.error });
    }
    startPowerBlocker();
    updateTray();
    resolve(r);
  });
}

// ★ مهم: نجاح الاتصال ≠ نجاح البث.
// إن كان الجهاز عاجزاً عن الترميز يرسل ffmpeg إطاراً كل عدة ثوانٍ
// (شاهدنا 0.1 إطار/ث) فيقبل يوتيوب الاتصال لكن لا يظهر بث إطلاقاً.
// نتحقق من معدل الإطارات الحقيقي بعد 12 ثانية ونرفض البث الكاذب.
function verifyThroughput(s) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const want = parseInt(s.fps, 10) || 30;
      const got = readProgress().fps;
      const floor = Math.max(3, want * 0.25);   // 25% من الهدف = بث مقبول
      if (got >= floor) return resolve({ ok: true, fps: got, verified: true });
      stopLive();
      lastError = 'معدل إطارات منخفض: ' + got.toFixed(1);
      safeSend('stream-ended', { code: -2, error: lastError });
      resolve({
        ok: false,
        error: 'الجهاز عاجز عن الترميز بهذه الجودة: ' + got.toFixed(1) +
               ' إطار/ث بدل ' + want + '. يوتيوب قبل الاتصال لكن لن يظهر بث.\n' +
               'الحل: اختر وضع «موفّر» (854×480 @15) أو «متوازن» (720p) وقلّل القص.'
      });
    }, 12000);
  });
}

function stopLive() {
  userStop = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (liveProc) { killTree(liveProc); liveProc = null; }
  liveStarted = null; liveArgs = null; liveServer = '';
  stopPowerBlocker();
  try { fs.writeFileSync(progressFile(), ''); } catch (e) {}
  updateTray();
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

// مستطيل نافذة بالعنوان — يُستخدم لقصّ النافذة من الشاشة الكاملة (وضع اللعبة)
async function windowRect(title) {
  if (!title) return { ok: false, error: 'لا عنوان' };
  const safe = title.replace(/'/g, "''");
  const ps = `
$target = '${safe}'
$src = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WR {
  delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(E cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  static string T; static IntPtr Found = IntPtr.Zero;
  static bool C(IntPtr h, IntPtr l) {
    try {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int n = GetWindowTextLength(h); if (n <= 0) return true;
      var sb = new StringBuilder(n + 2); GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString().Trim() == T) { Found = h; return false; }
    } catch {}
    return true;
  }
  public static string Find(string t) {
    T = t.Trim(); Found = IntPtr.Zero;
    EnumWindows(new E(C), IntPtr.Zero);
    if (Found == IntPtr.Zero) return "NOTFOUND";
    POINT p = new POINT(); p.X = 0; p.Y = 0;
    ClientToScreen(Found, ref p);
    RECT cr; GetClientRect(Found, out cr);
    int w = cr.Right - cr.Left, hh = cr.Bottom - cr.Top;
    if (w <= 0 || hh <= 0) { RECT wr; GetWindowRect(Found, out wr); p.X = wr.Left; p.Y = wr.Top; w = wr.Right - wr.Left; hh = wr.Bottom - wr.Top; }
    return p.X + "," + p.Y + "," + w + "," + hh;
  }
}
"@
Add-Type -TypeDefinition $src -ErrorAction Stop
[WR]::Find($target)
`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], 25000);
  const out = (r.out || '').trim().split(/\r?\n/).pop().trim();
  if (!out || out === 'NOTFOUND') {
    return { ok: false, error: 'لم أجد نافذة عنوانها: ' + title + ' — حدّث القائمة واختر من جديد' };
  }
  const [x, y, w, h] = out.split(',').map(n => parseInt(n, 10));
  if ([x, y, w, h].some(v => isNaN(v)) || w < 16 || h < 16) {
    return { ok: false, error: 'مستطيل النافذة غير صالح: ' + out };
  }
  return { ok: true, x, y, w, h };
}

// ------------------------------------------------------------------ أيقونة الخلفية (Tray)
function trayIconPath() {
  const cands = [path.join(__dirname, 'assets', 'icon', 'icon.ico'),
                 path.join(__dirname, 'build', 'icon.ico')];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return '';
}

function showMainWindow() {
  try {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  } catch (e) {}
}

function balloon(title, content) {
  if (process.platform !== 'win32' || !tray) return;
  try { tray.displayBalloon({ title, content }); } catch (e) {}
}

function updateTray() {
  if (!tray) return;
  try {
    const live = !!liveProc;
    tray.setToolTip(live ? 'LATCHI STREAM — البث يعمل على يوتيوب' + (liveStarted ? ' · ' + fmtElapsed() : '')
                         : 'LATCHI STREAM — جاهز في الخلفية');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: live ? '● البث يعمل على يوتيوب' + (liveStarted ? ' · ' + fmtElapsed() : '')
                    : 'البث متوقف', enabled: false },
      { type: 'separator' },
      { label: 'إظهار التطبيق', click: showMainWindow },
      { label: 'إيقاف البث', enabled: live,
        click: () => { stopLive(); safeSend('log', 'أُوقف البث من أيقونة الخلفية'); } },
      { label: 'بدء البث (الإعدادات المحفوظة)', enabled: !live && !!(settings && settings.youtubeKey),
        click: () => {
          const s = Object.assign({}, settings);
          startLive(s).then(r => {
            if (r.ok) { stopPreview(); balloon('LATCHI STREAM', 'انطلق البث على يوتيوب ✓'); }
            else safeSend('log', 'فشل بدء البث: ' + r.error);
          });
        } },
      { type: 'separator' },
      { label: 'خروج نهائي (يوقف البث)', click: () => { quitting = true; app.quit(); } }
    ]));
  } catch (e) {}
}

function createTray() {
  try {
    const p = trayIconPath();
    if (!p) { tray = null; return; }
    tray = new Tray(p);
  } catch (e) { tray = null; return; }
  updateTray();
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

  // ★ الإغلاق (X) لا يخرج من التطبيق: النافذة تُخفى والبث يستمر في الخلفية.
  //   الخروج النهائي فقط من أيقونة الساعة أو زر «خروج نهائي».
  win.on('close', (e) => {
    if (quitting) return;
    if (settings && settings.closeToTray === false) { quitting = true; app.quit(); return; }
    e.preventDefault();
    try { win.hide(); } catch (err) {}
    balloon('LATCHI STREAM — في الخلفية',
            liveProc ? 'البث مستمر على يوتيوب ✓ افتح التطبيق من أيقونة الساعة بجانب الوقت.'
                     : 'التطبيق يعمل في الخلفية. الخروج النهائي من أيقونة الساعة.');
  });

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
    const cfg = mergeRuntime(s);
    if (cfg.captureMode === 'game' && process.platform === 'win32') {
      const rc = await windowRect(cfg.windowTitle || '');
      if (!rc.ok) return { ok: false, error: rc.error };
      cfg.cropX = rc.x; cfg.cropY = rc.y; cfg.cropW = rc.w; cfg.cropH = rc.h;
      cfg.screenW = Math.max(cfg.screenW || 0, rc.x + rc.w);
      cfg.screenH = Math.max(cfg.screenH || 0, rc.y + rc.h);
      Object.assign(settings, { cropX: rc.x, cropY: rc.y, cropW: rc.w, cropH: rc.h,
                                screenW: cfg.screenW, screenH: cfg.screenH });
      saveSettings();
      safeSend('log', 'وضع اللعبة: نافذة عند (' + rc.x + ',' + rc.y + ') بحجم ' + rc.w + '×' + rc.h);
    }
    const r = await startLive(cfg);
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
      restarting: !!restartTimer, restartCount,
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

  // مستطيل النافذة على الشاشة (لوضع اللعبة/النافذة القصّية)
  ipcMain.handle('window:rect', async (e, title) => {
    if (process.platform !== 'win32') return { ok: false, error: 'غير مدعوم على هذه المنصة' };
    const r = await windowRect(String(title || ''));
    return r;
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

  // إخفاء النافذة إلى الخلفية (البث يستمر) + خروج نهائي حقيقي
  ipcMain.handle('window:hide', async () => {
    try { if (win && !win.isDestroyed()) win.hide(); } catch (e) {}
    balloon('LATCHI STREAM — في الخلفية',
            liveProc ? 'البث مستمر على يوتيوب ✓' : 'التطبيق يعمل في الخلفية');
    return { ok: true };
  });
  // ---------------------------------------------------------------- ffmpeg (لوحة الإصلاح)
  ipcMain.handle('ffmpeg:status', async () => ffmpegStatus());

  ipcMain.handle('ffmpeg:retry', async () => {
    const r = await resolveFfmpeg(true);
    if (win && !win.isDestroyed()) win.webContents.send('ffmpeg-ready', Object.assign({}, r, { permanentDir: ffBinDir() }));
    return Object.assign({ ok: r.ok, path: r.path, version: r.version, permanentDir: ffBinDir(), note: r.note }, await ffmpegStatus());
  });

  ipcMain.handle('ffmpeg:pick', async () => {
    const d = await dialog.showOpenDialog(win, {
      title: 'اختر ملف ffmpeg.exe',
      properties: ['openFile'],
      filters: [{ name: 'ffmpeg', extensions: IS_WIN ? ['exe'] : ['*'] }]
    });
    if (d.canceled || !d.filePaths || !d.filePaths[0]) return { ok: false, canceled: true };
    const src = d.filePaths[0];
    const perm = installFfmpegPermanent(src);
    const target = perm || src;
    const v = await ffmpegWorks(target, 15000);
    if (v.ok) FFMPEG = target;
    if (win && !win.isDestroyed()) win.webContents.send('ffmpeg-ready', { ok: v.ok, path: target, version: v.version, permanentDir: ffBinDir() });
    return { ok: v.ok, path: target, version: v.version, reason: v.reason, permanentDir: ffBinDir() };
  });

  ipcMain.handle('ffmpeg:openDir', async () => {
    const d = ffBinDir();
    try { await shell.openPath(d); } catch (e) {}
    return { ok: true, dir: d };
  });

  ipcMain.handle('app:quit', async () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });
}

// ------------------------------------------------------------------ دورة الحياة
// نسخة واحدة فقط من التطبيق: أي تشغيل ثانٍ يُظهر النافذة الموجودة بدل فتح نسخة جديدة
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    // اكتشاف مبدئي سريع (بلا تنفيذ) حتى تعمل الواجهة فوراً
    for (const c of ffmpegCandidates()) { if (isUsableFf(c)) { FFMPEG = c; break; } }
    // ثم تحقق فعلي + تثبيت دائم في الخلفية
    setTimeout(() => {
      resolveFfmpeg().then(r => {
        if (win && !win.isDestroyed()) win.webContents.send('ffmpeg-ready', Object.assign({}, r, { permanentDir: ffBinDir() }));
      }).catch(() => {});
    }, 1200);
    loadSettings();
    ensureAssets();
    Menu.setApplicationMenu(null);
    ipc();
    createTray();
    createWindow();

    // التقاط ESC داخل صفحات المتصفح المدمج (webview) وتحويله للواجهة
    // حتى يعمل «ESC مرتين للخروج» وأنت داخل الصفحة نفسها
    app.on('web-contents-created', (e, contents) => {
      if (contents.getType() === 'webview') {
        contents.on('before-input-event', (ev, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape') {
            safeSend('browser-esc', { ts: Date.now() });
          }
        });
      }
    });

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('window-all-closed', () => {
  // لا خروج تلقائي: النافذة تُخفى للخلفية والبث مستمر.
  // الخروج النهائي من أيقونة الساعة (خروج نهائي) أو زر «خروج نهائي».
});
app.on('before-quit', () => { quitting = true; stopPreview(); stopLive(); });
process.on('exit', () => { stopPreview(); stopLive(); });

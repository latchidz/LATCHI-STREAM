// ==============================================================================================
// LATCHI STREAM - النواة (منطق نقي بلا واجهة)
// ----------------------------------------------------------------------------------------------
// كل ما يتعلق بإعدادات ffmpeg: الاعدادات، الاوضاع، القص، الفلاتر، اوامر البث والمعاينة.
// كل الدوال نقية قدر الامكان لتسهيل الاختبار.
// ==============================================================================================

'use strict';

// ------------------------------------------------------------------ المفتاح المدمج
// مشوّش. لا يظهر كنص صريح في أي ملف.
function embeddedKey() {
  try {
    const garbled = 'eg44EFMjXFlWHQlQew0nFW00ClVSHR1JbiNcSVNpDls=';
    const mask = [0x37, 0x5A, 0x6D, 0x21];
    const raw = Buffer.from(garbled, 'base64');
    const plain = Buffer.alloc(raw.length);
    for (let i = 0; i < raw.length; i++) plain[i] = raw[i] ^ mask[i % 4];
    return Buffer.from(plain.toString('ascii'), 'base64').toString('ascii');
  } catch (e) { return ''; }
}

// ------------------------------------------------------------------ تنظيف المفتاح
function cleanStreamKey(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (/^rtmp:\/\//i.test(s)) {
    const m = s.match(/live2(?:\?backup=1)?\/([^/\s]+)/i);
    if (m) return m[1].trim();
    s = s.split('/').pop();
  }
  s = s.replace(/^(?:\s*stream[\s_-]*key\s*[:=]?\s*)/i, '');
  s = s.trim().replace(/^["']|["']$/g, '');
  return s;
}

function testKeyShape(key) {
  const k = cleanStreamKey(key);
  if (!k) return { ok: false, error: 'مفتاح البث فارغ' };
  if (/\s/.test(k)) return { ok: false, error: 'المفتاح يحتوي مسافة - انسخه كاملاً بدون فراغات' };
  if (k.length < 12) return { ok: false, error: 'المفتاح قصير جداً - تأكد أنك نسخته كاملاً' };
  if (k.length > 80) return { ok: false, error: 'المفتاح طويل جداً - تأكد أنك لم تنسخ شيئاً زائداً' };
  return { ok: true, key: k };
}

function youtubeEndpoints(key) {
  if (!key) return [];
  // خطاف اختبار فقط: يسمح ببثّ الاختبار إلى خادم RTMP محلي بدل يوتيوب
  if (process.env.LATCHI_RTMP_BASE) {
    return [
      { name: 'اختبار-رئيسي', url: process.env.LATCHI_RTMP_BASE + '/' + key },
      { name: 'اختبار-احتياطي', url: process.env.LATCHI_RTMP_BASE + '/b?backup=1/' + key }
    ];
  }
  return [
    { name: 'الرئيسي', url: 'rtmp://a.rtmp.youtube.com/live2/' + key },
    { name: 'الاحتياطي', url: 'rtmp://b.rtmp.youtube.com/live2?backup=1/' + key }
  ];
}

// خطاف اختبار فقط: على لينكس لا يوجد gdigrab/dshow
function testInputMode() { return process.env.LATCHI_TEST_INPUT || ''; }

// ------------------------------------------------------------------ الاعدادات الافتراضية
function defaultSettings(screenW = 1920, screenH = 1080) {
  return {
    schema: 3,
    youtubeKey: embeddedKey(),
    preset: 'balanced',
    outW: 1280,
    outH: 720,
    fps: 30,
    videoBitrate: '2500k',
    encoder: 'libx264',
    x264Preset: 'veryfast',
    threads: 0,
    captureMode: 'desktop',
    windowTitle: '',
    drawMouse: true,
    screenW,
    screenH,
    cropX: 0,
    cropY: 0,
    cropW: screenW,
    cropH: screenH,
    ratio: 'free',
    audioMode: 'system',
    audioDevice: '',
    audioBitrate: '128k',
    previewFps: 8,
    previewWidth: 720,
    autoRestart: true,
    // البانر والعنوان
    bannerEnabled: true,
    bannerPath: '',
    bannerDuration: 10,
    bannerFade: 1.5,
    streamTitle: 'GTA VI LIVE STREAMING',
    titleEnabled: true,
    titleFont: '',
    titleSize: 44,
    titleColor: '#ffffff',
    titleBoxColor: 'black@0.55',
    titlePosition: 'topcenter',
    // فتح رابط منصة
    platformUrl: ''
  };
}

// ------------------------------------------------------------------ اوضاع الاداء
function presetTable() {
  return {
    saver:    { outW: 854,  outH: 480,  fps: 15, videoBitrate: '800k',  x264Preset: 'ultrafast', threads: 0, label: 'موفّر' },
    balanced: { outW: 1280, outH: 720,  fps: 30, videoBitrate: '2500k', x264Preset: 'veryfast',  threads: 0, label: 'متوازن' },
    high:     { outW: 1280, outH: 720,  fps: 30, videoBitrate: '4000k', x264Preset: 'veryfast',  threads: 0, label: 'عالي' },
    portrait: { outW: 720,  outH: 1280, fps: 30, videoBitrate: '2500k', x264Preset: 'veryfast',  threads: 0, label: '9:16' }
  };
}

function applyPreset(settings, name) {
  const t = presetTable()[name];
  if (!t) return settings;
  return Object.assign({}, settings, {
    preset: name, outW: t.outW, outH: t.outH, fps: t.fps,
    videoBitrate: t.videoBitrate, x264Preset: t.x264Preset, threads: t.threads
  });
}

function mergeSettings(loaded, defaults) {
  const out = Object.assign({}, defaults);
  if (loaded && typeof loaded === 'object') {
    for (const k of Object.keys(loaded)) {
      if (k in defaults) out[k] = loaded[k];
    }
  }
  // سياسة: صوت النظام فقط
  out.audioMode = 'system';
  return out;
}

// ------------------------------------------------------------------ حساب القص
function effectiveCrop(s) {
  let sw = parseInt(s.screenW, 10) || 1920;
  let sh = parseInt(s.screenH, 10) || 1080;
  let x = parseInt(s.cropX, 10) || 0;
  let y = parseInt(s.cropY, 10) || 0;
  let w = parseInt(s.cropW, 10) || sw;
  let h = parseInt(s.cropH, 10) || sh;

  if (w < 16) w = 16;
  if (h < 16) h = 16;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > sw) w = sw - x;
  if (y + h > sh) h = sh - y;

  w = Math.floor(w / 2) * 2;
  h = Math.floor(h / 2) * 2;
  if (w < 16) w = 16;
  if (h < 16) h = 16;

  return { x, y, w, h };
}

// ------------------------------------------------------------------ سلسلة الفلاتر
function buildVideoFilter(s, opts) {
  opts = opts || {};
  const c = effectiveCrop(s);
  let ow = parseInt(s.outW, 10) || 1280;
  let oh = parseInt(s.outH, 10) || 720;
  let fps = parseInt(s.fps, 10) || 30;
  if (ow < 16) ow = 1280;
  if (oh < 16) oh = 720;
  ow = Math.floor(ow / 2) * 2;
  oh = Math.floor(oh / 2) * 2;

  const parts = [];
  if (opts.skipCrop) parts.push(`scale=${c.w}:${c.h}`);   // توحيد الأبعاد فقط
  else parts.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
  parts.push(`fps=${fps}`);
  parts.push(`scale=${ow}:${oh}:force_original_aspect_ratio=decrease`);
  parts.push(`pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:color=black`);
  parts.push('format=yuv420p');
  return parts.join(',');
}

// ------------------------------------------------------------------ مرشح البانر والعنوان
// يُبنى كجزء من filter_complex.
// المدخل [0] هو الشاشة، والمدخل [1] صورة البانر (إن وُجدت)
function buildOverlayChain(s, opts) {
  opts = opts || {};
  const hasBanner = !!(opts.bannerInput);
  const hasTitle = !!(s.titleEnabled && s.streamTitle);
  const parts = [];
  return { hasBanner, hasTitle };
}

// ------------------------------------------------------------------ امر البث الحي
// يعيد { ok, errors, args }
function buildLiveArgs(s, progressPath, server) {
  const errors = [];
  const key = cleanStreamKey(s.youtubeKey);
  const shape = testKeyShape(key);
  if (!shape.ok) errors.push(shape.error);

  const mode = s.captureMode;
  if ((mode === 'window' || mode === 'game') && !String(s.windowTitle || '').trim()) {
    errors.push('اخترت نافذة لكن العنوان فارغ.');
  }
  if (errors.length) return { ok: false, errors, args: [] };

  const fps = parseInt(s.fps, 10) || 30;
  const args = [];

  args.push('-hide_banner', '-loglevel', 'warning', '-nostdin');
  // -re : يقرأ الإطارات بالسرعة الحقيقية. بدونه ينطلق البث بسرعة 200 إطار/ث
  //       ويتقطّع المشاهد على يوتيوب (خصوصاً مع gdigrab البطيء).
  if (testInputMode()) args.push('-re');
  if (progressPath) args.push('-progress', progressPath);

  // ---- مدخل الصورة
  //   desktop = كل الشاشة (قصّ عند الالتقاط للأداء)
  //   window  = نافذة محددة مباشرة (gdigrab title=)
  //   game    = نافذة محددة تُقصّ من الشاشة الكاملة كل إطار (تعمل مع معظم الألعاب والتطبيقات)
  const ti = testInputMode();
  const cropAtCapture = (mode === 'desktop' && !ti);
  if (ti === 'testsrc') {
    // خطاف اختبار: مصدر صناعي بدل الشاشة (لينكس/CI)
    const c = effectiveCrop(s);
    args.push('-f', 'lavfi', '-i', `testsrc2=s=${c.w}x${c.h}:r=${fps}`);
  } else if (cropAtCapture) {
    // ★ مهم جداً للأجهزة الضعيفة: نلتقط منطقة القص فقط.
    //   التقاط 1920×1080 كاملة ثم قصّها يكلّف 3-4 أضعاف على Celeron.
    const c = effectiveCrop(s);
    args.push('-f', 'gdigrab', '-framerate', String(fps),
              '-draw_mouse', s.drawMouse ? '1' : '0',
              '-offset_x', String(c.x), '-offset_y', String(c.y),
              '-video_size', `${c.w}x${c.h}`,
              '-rtbufsize', '128M', '-thread_queue_size', '512',
              '-i', 'desktop');
  } else if (mode === 'window') {
    args.push('-f', 'gdigrab', '-framerate', String(fps),
              '-draw_mouse', s.drawMouse ? '1' : '0',
              '-rtbufsize', '256M', '-thread_queue_size', '512',
              '-i', 'title=' + String(s.windowTitle));
  } else {
    // وضع game: التقاط الشاشة الكاملة بمعدل منخفض ثم قصّ النافذة منها
    args.push('-f', 'gdigrab', '-framerate', String(fps),
              '-draw_mouse', s.drawMouse ? '1' : '0',
              '-rtbufsize', '256M', '-thread_queue_size', '512',
              '-i', 'desktop');
  }

  // ---- مدخل الصوت: صوت النظام فقط
  let hasAudio = false;
  const dev = String(s.audioDevice || '');
  if (!ti && s.audioMode !== 'none' && dev.trim()) {
    args.push('-f', 'dshow', '-rtbufsize', '64M', '-thread_queue_size', '512',
              '-i', 'audio=' + dev);
    hasAudio = true;
  } else {
    // ★ -re إجباري: بدونها يولّد anullsrc الصوت بسرعة لا نهائية ويزاحم المزامن
    args.push('-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    hasAudio = 'silent';
  }

  // ---- البانر (مدخل صورة اختياري)
  const bannerOn = !!(s.bannerEnabled && s.bannerPath);
  let bannerIdx = -1;
  if (bannerOn) {
    // ★ -re إجباري: البانر صورة ثابتة، بدونها تُضخّ آلاف الإطارات فوراً
    args.push('-re', '-loop', '1', '-framerate', String(fps), '-i', s.bannerPath);
    bannerIdx = hasAudio === 'silent' || hasAudio ? 2 : 2; // 0=screen 1=audio 2=banner
  }

  // ---- بناء الفلاتر (بدون crop إن قصّينا عند الالتقاط)
  const vf = buildVideoFilter(s, { skipCrop: cropAtCapture });
  const ow = Math.floor((parseInt(s.outW, 10) || 1280) / 2) * 2;
  const oh = Math.floor((parseInt(s.outH, 10) || 720) / 2) * 2;

  let fc = '';

  if (bannerOn) {
    // 1) البانر يُقاس لملء الإطار، ويظهر في البداية ثم يتلاشى
    const d = Math.max(1, parseFloat(s.bannerDuration) || 10);
    const fade = Math.max(0.2, parseFloat(s.bannerFade) || 1.5);
    const fadeStart = Math.max(0, d - fade);
    fc += `[${bannerIdx}:v]scale=${ow}:${oh}:force_original_aspect_ratio=increase,` +
          `crop=${ow}:${oh},format=rgba,` +
          `fade=in:st=0:d=0.6:alpha=1,fade=out:st=${fadeStart}:d=${fade}:alpha=1[banner];`;
    // الشاشة مع البانر فوقها
    fc += `[0:v]${vf}[scr];`;
    fc += `[scr][banner]overlay=0:0:enable='lte(t,${d})':format=auto[base];`;
  } else {
    fc += `[0:v]${vf}[base];`;
  }

  // 2) العنوان النصي (إن كان الخط متاحاً)
  const wantTitle = !!(s.titleEnabled && String(s.streamTitle || '').trim() && s.titleFont);
  let vlabel = '[base]';
  if (wantTitle) {
    const size = Math.max(14, parseInt(s.titleSize, 10) || 44);
    const color = String(s.titleColor || '#ffffff').replace('#', '0x');
    const box = String(s.titleBoxColor || 'black@0.55');
    let xExpr = '(w-text_w)/2', yExpr = 'h*0.06';
    switch (s.titlePosition) {
      case 'topright':   xExpr = 'w-text_w-w*0.04'; yExpr = 'h*0.06'; break;
      case 'topleft':    xExpr = 'w*0.04';          yExpr = 'h*0.06'; break;
      case 'bottomcenter': xExpr = '(w-text_w)/2';  yExpr = 'h-text_h-h*0.08'; break;
      case 'center':     xExpr = '(w-text_w)/2';    yExpr = '(h-text_h)/2'; break;
      default:           xExpr = '(w-text_w)/2';    yExpr = 'h*0.06';
    }
    const fontArg = String(s.titleFont).replace(/\\/g, '/').replace(/:/g, '\\:');
    const textEsc = String(s.streamTitle).replace(/\\/g, '\\\\').replace(/'/g, "\u2019").replace(/:/g, '\\:');
    fc += `[base]drawtext=fontfile='${fontArg}':text='${textEsc}':` +
          `fontsize=${size}:fontcolor=${color}:box=1:boxcolor=${box}:boxborderw=${Math.round(size * 0.35)}:` +
          `x=${xExpr}:y=${yExpr}[titled];`;
    vlabel = '[titled]';
  }

  // 3) الصوت
  const aIdx = 1;
  if (hasAudio === 'silent') {
    fc += `[${aIdx}:a]anull[aout]`;
  } else {
    fc += `[${aIdx}:a]aresample=48000[aout]`;
  }

  args.push('-filter_complex', fc);
  args.push('-map', vlabel, '-map', '[aout]');

  // ---- المُرمِّز
  let enc = String(s.encoder || 'libx264');
  if (!enc) enc = 'libx264';
  let br = String(s.videoBitrate || '2500k');
  const brN = parseInt(br.replace(/[^0-9]/g, ''), 10) || 2500;
  const buf = (brN * 2) + 'k';

  args.push('-c:v', enc);
  if (enc === 'libx264') {
    const pr = String(s.x264Preset || 'veryfast');
    args.push('-preset', pr, '-tune', 'zerolatency', '-profile:v', 'main');
    // 0 = تلقائي (يستخدم كل الأنوية المتاحة)
    let th = parseInt(s.threads, 10);
    if (isNaN(th) || th < 0) th = 0;
    args.push('-threads', String(th));
  } else if (enc === 'h264_qsv') {
    args.push('-preset', 'veryfast', '-async_depth', '1');
  } else if (enc === 'h264_amf') {
    args.push('-quality', 'speed', '-rc', 'cbr');
  } else if (enc === 'h264_nvenc') {
    args.push('-preset', 'p1', '-tune', 'll', '-rc', 'cbr');
  }
  // CBR: يوتيوب يوصي بمعدل ثابت. minrate = maxrate = b:v مع مخزن مضاعف
  args.push('-b:v', br, '-minrate', br, '-maxrate', br, '-bufsize', buf,
            '-g', String(fps * 2), '-pix_fmt', 'yuv420p');

  // ---- الصوت
  const abr = String(s.audioBitrate || '128k');
  args.push('-c:a', 'aac', '-b:a', abr, '-ar', '48000', '-ac', '2');

  // ---- المخرج
  const eps = youtubeEndpoints(key);
  const outUrl = (server === 'backup' && eps.length > 1) ? eps[1].url : eps[0].url;
  args.push('-f', 'flv', '-flvflags', 'no_duration_filesize', outUrl);

  return { ok: true, errors: [], args, hasAudio, bannerOn };
}

// ------------------------------------------------------------------ امر المعاينة
// معاينة خفيفة: الشاشة كاملة بمعدل منخفض بلا قص ولا زوم ولا صوت.
// القص والزوم يُرسمان في الواجهة فوق الصورة - بلا حمل إضافي.
function buildPreviewArgs(s) {
  let pfps = parseInt(s.previewFps, 10) || 8;
  if (pfps > 15) pfps = 15;
  if (pfps < 2) pfps = 2;
  let pw = parseInt(s.previewWidth, 10) || 720;
  if (pw < 320) pw = 720;
  if (pw > 1280) pw = 1280;

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  if (testInputMode() === 'testsrc') {
    const c = effectiveCrop(s);
    args.push('-f', 'lavfi', '-i', `testsrc2=s=${Math.round(c.w/2)}x${Math.round(c.h/2)}:r=${pfps}`);
  } else {
    args.push('-f', 'gdigrab', '-framerate', String(pfps),
              '-draw_mouse', s.drawMouse ? '1' : '0',
              '-rtbufsize', '64M');
    if (s.captureMode === 'window' && String(s.windowTitle || '').trim()) {
      args.push('-i', 'title=' + String(s.windowTitle));
    } else {
      args.push('-i', 'desktop');
    }
  }

  const out = s._previewOut || 'preview.jpg';
  args.push('-vf', `scale=${pw}:-2,format=yuvj420p`,
            '-c:v', 'mjpeg', '-q:v', '7',
            '-f', 'image2', '-update', '1', '-y', out);
  return args;
}

// ------------------------------------------------------------------ تصفية أجهزة الصوت
const MIC_RE = /(microphone|\bmic\b|line[\s-]?in|\baux\b|headset|webcam|front panel|rear panel|ميكروفون|مدخل خط)/i;
const SYS_RE = /(stereo mix|stereomix|what u hear|what you hear|wave out|waveout|loopback|monitor of|mixage)/i;

function selectSystemAudioDevices(devices) {
  const sys = [], blocked = [];
  for (const d of (devices || [])) {
    if (!d || !String(d).trim()) continue;
    const name = String(d).trim();
    if (MIC_RE.test(name)) { blocked.push(name); continue; }
    sys.push(name);
  }
  sys.sort((a, b) => {
    const sa = SYS_RE.test(a) ? 0 : 1;
    const sb = SYS_RE.test(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });
  return { devices: sys, blocked };
}

// ------------------------------------------------------------------ فحص صورة
function isJpeg(buf) {
  if (!buf || buf.length < 4) return false;
  return buf[0] === 0xFF && buf[1] === 0xD8 &&
         buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9;
}

module.exports = {
  embeddedKey,
  testInputMode,
  cleanStreamKey,
  testKeyShape,
  youtubeEndpoints,
  defaultSettings,
  presetTable,
  applyPreset,
  mergeSettings,
  effectiveCrop,
  buildVideoFilter,
  buildLiveArgs,
  buildPreviewArgs,
  selectSystemAudioDevices,
  isJpeg
};

// ==============================================================================================
// LATCHI STREAM 3.0.0 - واجهة التطبيق
// ==============================================================================================
'use strict';

const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const L  = window.latchi;

let S = null;
let info = null;
let previewOn = false;
let streaming = false;
let pollTimer = null;
let lowFpsWarned = false;
let frameTimer = null;

let box = null;          // منطقة القص بإحداثيات الصورة المعروضة
let dragging = null;
let defaultBanner = '';
let previewStageW = 0, previewStageH = 0;

const PRESETS = {
  saver:    { outW: 854,  outH: 480,  fps: 15, videoBitrate: '800k',  x264Preset: 'ultrafast', threads: 0 },
  balanced: { outW: 1280, outH: 720,  fps: 30, videoBitrate: '2500k', x264Preset: 'veryfast',  threads: 0 },
  high:     { outW: 1280, outH: 720,  fps: 30, videoBitrate: '4000k', x264Preset: 'veryfast',  threads: 0 },
  portrait: { outW: 720,  outH: 1280, fps: 30, videoBitrate: '2500k', x264Preset: 'veryfast',  threads: 0 }
};
const RATIOS = { '16:9': 16/9, '9:16': 9/16, '1:1': 1, '4:3': 4/3 };

// ---------------------------------------------------------------- أدوات
function toast(msg, kind, ms) {
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => { d.style.transition = '.3s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 320); }, ms || 3800);
}
function log(msg, kind) {
  const el = $('#log');
  const t = new Date();
  const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
  const d = document.createElement('div');
  const s1 = document.createElement('span'); s1.className = 't'; s1.textContent = '[' + ts + '] ';
  const s2 = document.createElement('span'); if (kind) s2.className = kind; s2.textContent = msg;
  d.appendChild(s1); d.appendChild(s2);
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 400) el.removeChild(el.firstChild);
}
function setChip(el, state, text) {
  el.className = 'chip ' + (state || '');
  const dot = document.createElement('i'); dot.className = 'dot' + (state === 'ok' ? ' pulse' : '');
  el.innerHTML = ''; el.appendChild(dot); el.appendChild(document.createTextNode(text));
}
function busy(btn, on, label) {
  if (on) {
    btn.dataset.old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + (label || 'جارٍ…');
  } else {
    btn.disabled = false;
    if (btn.dataset.old) { btn.innerHTML = btn.dataset.old; delete btn.dataset.old; }
  }
}
function persist(patch) { Object.assign(S, patch); L.setSettings(patch); }

// ---------------------------------------------------------------- الإقلاع
async function boot() {
  info = await L.info();
  S = await L.getSettings();
  $('#verLine').textContent = 'الإصدار ' + info.version + (info.portable ? ' · محمول' : ' · سطح مكتب');

  setChip($('#chipFfmpeg'), info.ffmpegOk ? 'ok' : 'bad', info.ffmpegOk ? 'ffmpeg جاهز' : 'ffmpeg مفقود');

  defaultBanner = info.bundledBanner || info.bannerPath || '';
  applyBanner(S.bannerPath || defaultBanner, false);

  // خط العنوان الافتراضي
  if (!S.titleFont) {
    const fd = await L.defaultFont();
    if (fd.ok) { S.titleFont = fd.path; persist({ titleFont: fd.path }); }
  }

  // المفتاح
  const ke = await L.keyEmbedded();
  if (ke.hasKey) {
    setChip($('#chipKey'), 'ok', 'المفتاح مدمج');
    $('#keyLine').textContent = 'مفتاح مدمج ومخفي داخل التطبيق: ' + ke.masked;
  } else {
    setChip($('#chipKey'), 'warn', 'أدخل المفتاح');
    $('#keyLine').textContent = 'لا مفتاح مدمج — الصق مفتاحك من YouTube Studio.';
  }

  fillForm();
  bindEvents();

  // أبعاد الشاشة الحقيقية — تُحفظ في الخلفية وإلا بقي القص مقيّداً بـ 1920×1080
  try {
    S.screenW = Math.round(window.screen.width * (window.devicePixelRatio || 1));
    S.screenH = Math.round(window.screen.height * (window.devicePixelRatio || 1));
  } catch (e) { S.screenW = 1920; S.screenH = 1080; }
  const dims = { screenW: S.screenW, screenH: S.screenH };
  if (!S.cropW || S.cropW > S.screenW || !S.cropH || S.cropH > S.screenH) {
    Object.assign(dims, { cropX: 0, cropY: 0, cropW: S.screenW, cropH: S.screenH });
    S.cropX = 0; S.cropY = 0; S.cropW = S.screenW; S.cropH = S.screenH;
  }
  persist(dims);

  await refreshAudio();
  const enc = await L.encodersList();
  log('المُرمِّزات: ' + enc.encoders.join(', '), 'ok');
  if (!enc.encoders.includes(S.encoder)) { S.encoder = enc.encoders[0]; persist({ encoder: S.encoder }); }

  L.windowList().then(r => fillWindows(r.windows));

  // بوابة البداية
  if (!info.ffmpegOk) {
    $('#gateHint').innerHTML = 'ملف <b>ffmpeg.exe</b> غير موجود، ولا يمكن البث بدونه.<br>' +
      '<span style="font-size:11.5px;color:#7b8fb0">ضع ffmpeg.exe بجانب التطبيق أو في مجلد resources\\ffmpeg</span>';
    $('#gateActions').innerHTML = '<button class="btn ghost" id="gateGo">متابعة</button>';
  } else {
    $('#gateHint').innerHTML = 'جاهز للانطلاق.<br><span style="font-size:11.5px;color:#7b8fb0">كل شيء داخل هذه النافذة — لا متصفح.</span>';
    $('#gateActions').innerHTML = '<button class="btn green" id="gateGo">ابدأ</button>';
  }
  $('#gateGo').onclick = () => { $('#gate').style.display = 'none'; };

  frameTimerPre = null;
  startPolling();
  log('التطبيق جاهز — v' + info.version, 'ok');
}
let frameTimerPre = null;

// ---------------------------------------------------------------- النموذج
function fillForm() {
  $('#selRes').value = S.outW + 'x' + S.outH;
  $('#selFps').value = String(S.fps);
  $('#selBitrate').value = String(S.videoBitrate);

  $$('#presetSeg button').forEach(b => b.classList.toggle('on', b.dataset.preset === S.preset));
  $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.captureMode));
  $$('#ratioSeg button').forEach(b => b.classList.toggle('on', b.dataset.ratio === S.ratio));

  $('#selWindow').disabled = S.captureMode === 'desktop';
  $('#chkMouse').checked = !!S.drawMouse;

  $('#chkBanner').checked = !!S.bannerEnabled;
  $('#numBannerDur').value = S.bannerDuration || 10;
  $('#chkTitle').checked = !!S.titleEnabled;
  $('#txtTitle').value = S.streamTitle || 'GTA VI LIVE STREAMING';
  $('#numTitleSize').value = S.titleSize || 44;
  $('#selTitlePos').value = S.titlePosition || 'topcenter';
  $('#txtTitleColor').value = S.titleColor || '#ffffff';
  $('#fontLine').textContent = S.titleFont ? ('الخط: ' + String(S.titleFont).split(/[\\/]/).pop()) : 'الخط: افتراضي';

  $('#rngZoom').value = 100;
  $('#lblZoom').textContent = '1.0×';
  updateModeHint();
  updateKeyField();
  renderBannerOverlay();
  renderTitleOverlay();
}

function updateModeHint() {
  const el = $('#modeHint');
  if (!el || !S) return;
  const m = S.captureMode;
  if (m === 'desktop') {
    el.innerHTML = 'يبثّ شاشتك كاملة — تنقّل في الحاسوب كما تشاء والبث مستمر.';
  } else if (m === 'window') {
    el.innerHTML = '<b>نافذة:</b> تبثّ نافذة واحدة. إن أغلقتها أو صغّرتها يتوقف البث — ' +
      'استعمل «لعبة / تطبيق» إن أردت التنقّل بحرية.';
  } else {
    el.innerHTML = '<b>لعبة / تطبيق:</b> يقتطع النافذة المختارة من الشاشة ويبثّها. ' +
      'تبقى النافذة في المقدّمة أثناء البث، وباقي الحاسوب خارج البث.';
  }
}

function updateKeyField() {
  const t = $('#txtKey');
  t.type = $('#chkKeyMask').checked ? 'password' : 'text';
  t.value = S.youtubeKey || '';
  t.placeholder = S.youtubeKey ? 'مفتاح محفوظ — اكتب لتغييره' : 'أدخل مفتاح البث';
}

// ---------------------------------------------------------------- الربط
let binded = false;
function bindEvents() {
  if (binded) return;
  binded = true;

  /* ---------------- الجودة ---------------- */
  $$('#presetSeg button').forEach(b => b.onclick = () => {
    $$('#presetSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    const t = PRESETS[b.dataset.preset];
    S.preset = b.dataset.preset;
    Object.assign(S, t);
    $('#selRes').value = S.outW + 'x' + S.outH;
    $('#selFps').value = String(S.fps);
    $('#selBitrate').value = String(S.videoBitrate);
    persist({ preset: S.preset, outW: S.outW, outH: S.outH, fps: S.fps,
              videoBitrate: S.videoBitrate, x264Preset: S.x264Preset, threads: S.threads });
    log('الوضع: ' + b.textContent.trim() + ' — ' + S.outW + '×' + S.outH + ' @' + S.fps + ' · ' + S.videoBitrate);
  });
  $('#selRes').onchange = e => { const p = e.target.value.split('x').map(Number); S.outW = p[0]; S.outH = p[1]; persist({ outW: S.outW, outH: S.outH }); };
  $('#selFps').onchange = e => { S.fps = Number(e.target.value); persist({ fps: S.fps }); };
  $('#selBitrate').onchange = e => { S.videoBitrate = e.target.value; persist({ videoBitrate: S.videoBitrate }); };

  /* ---------------- المصدر ---------------- */
  $$('#modeSeg button').forEach(b => b.onclick = () => {
    $$('#modeSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.captureMode = b.dataset.mode;
    $('#selWindow').disabled = S.captureMode === 'desktop';
    persist({ captureMode: S.captureMode });
    updateModeHint();
    log('المصدر: ' + b.textContent.trim());
    if (previewOn) restartPreview();
  });
  $('#selWindow').onchange = e => {
    S.windowTitle = e.target.value;
    persist({ windowTitle: S.windowTitle });
    if (previewOn) restartPreview();
  };
  $('#btnRefreshWin').onclick = async () => {
    const r = await L.windowList();
    fillWindows(r.windows);
    toast('تم تحديث القائمة: ' + (r.windows || []).length + ' نافذة', 'ok', 2400);
  };
  $('#btnPickWinMouse').onclick = async () => {
    openModal('اختيار نافذة بالماوس',
      'سيُخفى التطبيق ثانيتين، ثم يُقرأ اسم النافذة التي تحت مؤشر الفأرة.<br>' +
      '<b style="color:#ffd79a">حرّك مؤشر الفأرة فوق النافذة المطلوبة قبل انتهاء العد.</b>');
    $('#mBody').innerHTML = '<button class="btn blue full" id="pickGo">ابدأ الآن</button>';
    $('#pickGo').onclick = async () => {
      busy($('#pickGo'), true, 'جارٍ الاختيار…');
      $('#modal').classList.remove('on');
      const r = await L.pickWindowMouse();
      if (!r.ok) { toast('تعذّر الاختيار: ' + (r.error || ''), 'bad', 5000); return; }
      S.windowTitle = r.title;
      S.captureMode = 'window';
      persist({ windowTitle: r.title, captureMode: 'window' });
      $$('#modeSeg button').forEach(x => x.classList.toggle('on', x.dataset.mode === 'window'));
      $('#selWindow').disabled = false;
      const sel = $('#selWindow');
      if (!Array.from(sel.options).some(o => o.value === r.title)) {
        const o = document.createElement('option'); o.value = r.title; o.textContent = r.title; sel.appendChild(o);
      }
      sel.value = r.title;
      toast('النافذة: ' + r.title, 'ok', 4200);
      log('اختيار بالماوس: ' + r.title, 'ok');
      if (previewOn) restartPreview();
    };
  };
  $('#chkMouse').onchange = e => { S.drawMouse = e.target.checked; persist({ drawMouse: S.drawMouse }); };

  /* ---------------- الصوت ---------------- */
  $('#btnRefreshAudio').onclick = () => refreshAudio(true);
  $('#selAudio').onchange = e => { S.audioDevice = e.target.value; persist({ audioDevice: S.audioDevice }); };

  /* ---------------- النسبة والزوم ---------------- */
  $$('#ratioSeg button').forEach(b => b.onclick = () => {
    $$('#ratioSeg button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    S.ratio = b.dataset.ratio;
    persist({ ratio: S.ratio });
    applyRatio();
  });
  $('#rngZoom').oninput = e => {
    const z = Number(e.target.value) / 100;
    $('#lblZoom').textContent = z.toFixed(1) + '×';
    applyZoom(z);
  };
  $('#btnResetCrop').onclick = () => {
    box = null;
    $('#rngZoom').value = 100; $('#lblZoom').textContent = '1.0×';
    S.ratio = 'free';
    $$('#ratioSeg button').forEach(x => x.classList.toggle('on', x.dataset.ratio === 'free'));
    S.cropX = 0; S.cropY = 0; S.cropW = S.screenW; S.cropH = S.screenH;
    persist({ cropX: 0, cropY: 0, cropW: S.screenW, cropH: S.screenH, ratio: 'free' });
    renderCropBox(null);
    toast('ملء الشاشة', 'ok', 2000);
  };
  $('#btnSaveCrop').onclick = () => {
    const c = cropToScreen();
    S.cropX = c.x; S.cropY = c.y; S.cropW = c.w; S.cropH = c.h;
    persist({ cropX: c.x, cropY: c.y, cropW: c.w, cropH: c.h, ratio: S.ratio });
    toast('حُفظ الاختيار: ' + c.w + '×' + c.h + ' من النقطة (' + c.x + '، ' + c.y + ')', 'ok', 4200);
    log('حفظ القص: ' + c.w + '×' + c.h + '@' + c.x + ',' + c.y, 'ok');
    box = { x: box ? box.x : 0, y: box ? box.y : 0, w: box ? box.w : 0, h: box ? box.h : 0 };
  };

  /* ---------------- المعاينة ---------------- */
  $('#btnPrevStart').onclick = startPreview;
  $('#btnPrevStop').onclick = stopPreview;
  $('#btnPrevSave').onclick = savePreviewShot;

  /* ---------------- البث ---------------- */
  $('#btnStreamStart').onclick = startStream;
  $('#btnStreamStop').onclick = stopStream;
  $('#btnKeyTest').onclick = testKey;

  /* ---------------- البانر ---------------- */
  $('#bannerBox').onclick = async () => {
    const r = await L.pickImage();
    if (!r.ok) return;
    S.bannerPath = r.path;
    persist({ bannerPath: r.path });
    applyBanner(r.path, true);
    toast('تم تغيير البانر', 'ok');
  };
  $('#btnBannerReset').onclick = () => {
    S.bannerPath = defaultBanner;
    persist({ bannerPath: defaultBanner, bannerEnabled: true });
    applyBanner(defaultBanner, true);
    $('#chkBanner').checked = true;
    renderBannerOverlay();
    toast('استُعيد البانر الرسمي', 'ok');
  };
  $('#chkBanner').onchange = e => { S.bannerEnabled = e.target.checked; persist({ bannerEnabled: S.bannerEnabled }); renderBannerOverlay(); renderTitleOverlay(); };
  $('#numBannerDur').onchange = e => { S.bannerDuration = Number(e.target.value); persist({ bannerDuration: S.bannerDuration }); };

  /* ---------------- العنوان ---------------- */
  $('#chkTitle').onchange = e => { S.titleEnabled = e.target.checked; persist({ titleEnabled: S.titleEnabled }); renderTitleOverlay(); };
  $('#txtTitle').oninput = e => { S.streamTitle = e.target.value; renderTitleOverlay(); };
  $('#txtTitle').onchange = e => { S.streamTitle = e.target.value; persist({ streamTitle: S.streamTitle }); };
  $('#numTitleSize').onchange = e => { S.titleSize = Number(e.target.value); persist({ titleSize: S.titleSize }); renderTitleOverlay(); };
  $('#selTitlePos').onchange = e => { S.titlePosition = e.target.value; persist({ titlePosition: S.titlePosition }); renderTitleOverlay(); };
  $('#txtTitleColor').onchange = e => { S.titleColor = e.target.value; persist({ titleColor: S.titleColor }); renderTitleOverlay(); };
  $('#btnPickFont').onclick = async () => {
    const r = await L.pickFont();
    if (!r.ok) return;
    S.titleFont = r.path;
    persist({ titleFont: r.path });
    $('#fontLine').textContent = 'الخط: ' + String(r.path).split(/[\\/]/).pop();
    toast('تم اختيار الخط', 'ok');
  };

  /* ---------------- المفتاح ---------------- */
  $('#chkKeyMask').onchange = updateKeyField;
  $('#btnSaveKey').onclick = () => {
    const v = $('#txtKey').value.trim();
    if (!v) { toast('المفتاح فارغ', 'warn'); return; }
    S.youtubeKey = v;
    persist({ youtubeKey: v });
    setChip($('#chipKey'), 'ok', 'المفتاح محفوظ');
    toast('تم حفظ المفتاح', 'ok');
    log('حُفظ مفتاح البث (مخفي)', 'ok');
  };

  /* ---------------- المتصفح المدمج ---------------- */
  $('#btnBrowserTop').onclick = openBrowser;
  $('#btnBrowserClose').onclick = closeBrowser;
  $('#btnBrowserGo').onclick = goBrowser;
  $('#browserUrl').onkeydown = e => { if (e.key === 'Enter') goBrowser(); };
  $$('[data-open]').forEach(b => b.onclick = () => {
    $('#browserUrl').value = b.dataset.open;
    openBrowser();
    goBrowser();
  });

  /* ---------------- شاشة كاملة ---------------- */
  $('#btnFull').onclick = async () => {
    const st = await L.setFullscreen(true);
    toast('شاشة كاملة — اضغط Esc للخروج', 'ok', 2600);
  };

  /* ---------------- من الخلفية ---------------- */
  L.onLog(m => log(m));
  L.onStreamEnded(d => {
    streaming = false; reflectStream(false);
    toast('توقف البث: ' + (d.error || ''), 'bad', 8000);
    log('توقف البث — ' + (d.error || ''), 'bad');
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeBrowser();
      $('#modal').classList.remove('on');
      L.setFullscreen(false);
    }
  });

  setupCropDrag();
  window.addEventListener('resize', () => { if (previewOn) sizeStage(); });
}

// ---------------------------------------------------------------- النوافذ
function fillWindows(list) {
  const sel = $('#selWindow');
  const cur = S.windowTitle || '';
  sel.innerHTML = '<option value="">— اختر نافذة —</option>';
  (list || []).forEach(w => {
    const o = document.createElement('option');
    o.value = w; o.textContent = w.length > 60 ? w.slice(0, 60) + '…' : w;
    sel.appendChild(o);
  });
  if (cur) {
    if (!Array.from(sel.options).some(o => o.value === cur)) {
      const o = document.createElement('option'); o.value = cur; o.textContent = cur; sel.appendChild(o);
    }
    sel.value = cur;
  }
}

// ---------------------------------------------------------------- الصوت
async function refreshAudio(notify) {
  const r = await L.audioList();
  const sel = $('#selAudio');
  sel.innerHTML = '';
  if (!r.devices.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '— لا جهاز صوت نظام —'; sel.appendChild(o);
    setChip($('#chipAudio'), 'warn', 'لا صوت نظام');
  } else {
    r.devices.forEach(d => { const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o); });
    let i = r.devices.indexOf(S.audioDevice);
    if (i < 0) i = 0;
    sel.value = r.devices[i];
    if (S.audioDevice !== sel.value) { S.audioDevice = sel.value; persist({ audioDevice: sel.value }); }
    setChip($('#chipAudio'), 'ok', 'صوت النظام');
  }
  if (notify) toast('أجهزة الصوت: ' + r.devices.length + (r.blocked.length ? ' · حُجب ' + r.blocked.length + ' ميكروفون' : ''), 'ok', 3000);
  if (r.blocked.length) log('ميكروفونات محجوبة: ' + r.blocked.join(' · '), 'warn');
}

// ---------------------------------------------------------------- البانر
function applyBanner(p, bust) {
  const img = $('#bannerImg');
  const layer = $('#prevBannerLayer');
  if (!p) { img.removeAttribute('src'); if (layer) layer.style.backgroundImage = 'none'; return; }
  let url = 'file:///' + String(p).replace(/\\/g, '/');
  if (bust) url += '?t=' + Date.now();
  img.src = url;
  if (layer) layer.style.backgroundImage = 'url("' + url + '")';
  renderBannerOverlay();
}

// ---------------------------------------------------------------- طبقة البانر/العنوان في المعاينة
function renderTitleOverlay() {
  const el = $('#prevTitleLayer');
  if (!el) return;
  const on = previewOn && S && S.titleEnabled && String(S.streamTitle || '').trim();
  el.style.display = on ? 'block' : 'none';
  el.textContent = S ? (S.streamTitle || '') : '';
  if (!S) return;
  const base = previewStageW || 640;
  const fs = Math.max(10, Math.round((S.titleSize || 44) * (base / (S.outW || 1280))));
  el.style.fontSize = fs + 'px';
  el.style.color = S.titleColor || '#fff';
  el.style.background = /^#?[0-9a-f]{6}$/i.test((S.titleBoxColor || '').replace('black@', ''))
    ? 'rgba(0,0,0,.55)' : 'rgba(0,0,0,.55)';
  const pos = S.titlePosition || 'topcenter';
  el.style.left = pos.includes('left') ? '4%' : (pos.includes('right') ? 'auto' : '50%');
  el.style.right = pos.includes('right') ? '4%' : 'auto';
  el.style.transform = pos.includes('left') || pos.includes('right') ? 'none' : 'translateX(-50%)';
  el.style.top = pos.startsWith('top') ? '6%' : (pos === 'center' ? '50%' : 'auto');
  el.style.bottom = pos === 'bottomcenter' ? '8%' : 'auto';
  if (pos === 'center') el.style.transform = 'translate(-50%,-50%)';
}

function renderBannerOverlay() {
  const b = $('#prevBannerLayer');
  if (!b) return;
  const on = previewOn && S && S.bannerEnabled && $('#bannerImg').getAttribute('src');
  b.style.display = on ? 'block' : 'none';
}

// ---------------------------------------------------------------- المعاينة
async function startPreview() {
  if (previewOn) return;
  const btn = $('#btnPrevStart');
  busy(btn, true, 'جارٍ البدء…');
  const r = await L.previewStart({
    captureMode: S.captureMode, windowTitle: S.windowTitle,
    drawMouse: S.drawMouse, previewFps: 8, previewWidth: 720
  });
  busy(btn, false);
  if (!r.ok) {
    toast('فشل المعاينة: ' + (r.error || ''), 'bad', 7000);
    log('فشل المعاينة: ' + (r.error || ''), 'bad');
    return;
  }
  previewOn = true;
  $('#prevIdle').style.display = 'none';
  $('#prevImg').style.display = 'block';
  showLivePanel(false);
  renderBannerOverlay();
  renderTitleOverlay();
  $('#btnPrevStop').disabled = false;
  log('بدأت المعاينة (8 إطارات · مخففة)', 'ok');
  startFrames();
}

async function stopPreview() {
  await L.previewStop();
  previewOn = false;
  stopFrames();
  $('#btnPrevStop').disabled = true;
  const img = $('#prevImg');
  img.style.display = 'none';
  img.removeAttribute('src');
  img.style.width = ''; img.style.height = '';
  $('#prevIdle').style.display = 'grid';
  $('#cropLayer').classList.remove('on');
  renderBannerOverlay();
  renderTitleOverlay();
  showLivePanel(false);
  log('أُوقفت المعاينة', 'ok');
  toast('تم إيقاف المعاينة', 'ok', 2400);
}

async function restartPreview() {
  if (!previewOn) return;
  await L.previewStop();
  await new Promise(r => setTimeout(r, 300));
  await L.previewStart({ captureMode: S.captureMode, windowTitle: S.windowTitle,
                         drawMouse: S.drawMouse, previewFps: 8, previewWidth: 720 });
  log('أُعيد تشغيل المعاينة بالمصدر الجديد', 'ok');
}

function startFrames() {
  stopFrames();
  let fails = 0;
  frameTimer = setInterval(async () => {
    if (!previewOn) return;
    const r = await L.previewFrame();
    if (!r.on) {
      if (++fails > 10) { stopPreview(); toast('توقفت المعاينة من المصدر', 'warn', 5000); }
      return;
    }
    fails = 0;
    if (!r.frame) return;
    const img = $('#prevImg');
    img.onload = () => { sizeStage(); };
    img.src = r.frame;
    $('#cropLayer').classList.add('on');
  }, 250);
}
function stopFrames() { if (frameTimer) { clearInterval(frameTimer); frameTimer = null; } }

function sizeStage() {
  const img = $('#prevImg');
  const wrap = $('#prevImgWrap');
  const host = document.querySelector('.previewWrap');
  if (!img.naturalWidth) return;
  const maxW = host.clientWidth - 18;
  const maxH = host.clientHeight - 18;
  const k = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  previewStageW = Math.round(img.naturalWidth * k);
  previewStageH = Math.round(img.naturalHeight * k);
  img.style.width = previewStageW + 'px';
  img.style.height = previewStageH + 'px';
  wrap.style.width = previewStageW + 'px';
  wrap.style.height = previewStageH + 'px';
  renderCropBox(box);
  renderBannerOverlay();
  renderTitleOverlay();
}

// ---------------------------------------------------------------- حفظ صورة المعاينة
async function savePreviewShot() {
  if (!previewOn) { toast('شغّل المعاينة أولاً', 'warn'); return; }
  // نرسم الصورة + البانر + العنوان على canvas ونحفظها
  const img = $('#prevImg');
  if (!img.src) { toast('لا إطار بعد', 'warn'); return; }
  const cv = document.createElement('canvas');
  const W = (S.cropW || S.screenW), H = (S.cropH || S.screenH);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const sx = (img.naturalWidth || 1) / (S.screenW || 1);
  const sy = (img.naturalHeight || 1) / (S.screenH || 1);
  try {
    ctx.drawImage(img, (S.cropX || 0) * sx, (S.cropY || 0) * sy,
                  W * sx, H * sy, 0, 0, W, H);
  } catch (e) {
    ctx.drawImage(img, 0, 0, W, H);
  }
  // البانر
  if (S.bannerEnabled) {
    const src = $('#bannerImg');
    if (src && src.complete && src.naturalWidth) {
      ctx.drawImage(src, 0, 0, W, H);
    }
  }
  // العنوان
  if (S.titleEnabled && S.streamTitle) {
    const fs = (S.titleSize || 44) * (W / (S.outW || 1280));
    ctx.font = '700 ' + Math.round(fs) + 'px "Segoe UI",Tahoma,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(S.streamTitle).width;
    let cx = W / 2, cy = H * 0.06 + fs / 2;
    const pos = S.titlePosition || 'topcenter';
    if (pos === 'center') cy = H / 2;
    if (pos === 'bottomcenter') cy = H - H * 0.08;
    if (pos === 'topleft') { ctx.textAlign = 'left'; cx = W * 0.04; }
    if (pos === 'topright') { ctx.textAlign = 'right'; cx = W * 0.96; }
    const pad = fs * 0.35;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const bx = ctx.textAlign === 'center' ? cx - tw / 2 - pad : (ctx.textAlign === 'left' ? cx - pad : cx - tw - pad);
    ctx.fillRect(bx, cy - fs / 2 - pad, tw + pad * 2, fs + pad * 2);
    ctx.fillStyle = S.titleColor || '#fff';
    ctx.fillText(S.streamTitle, cx, cy);
  }
  const a = document.createElement('a');
  a.download = 'latchi-preview-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
  a.href = cv.toDataURL('image/png');
  a.click();
  toast('حُفظت صورة المعاينة مع البانر والعنوان', 'ok', 4200);
}

// ---------------------------------------------------------------- القص
function cropToScreen() {
  const img = $('#prevImg');
  if (!box || !img.naturalWidth) return { x: 0, y: 0, w: S.screenW, h: S.screenH };
  const fx = (S.screenW || img.naturalWidth) / img.naturalWidth;
  const fy = (S.screenH || img.naturalHeight) / img.naturalHeight;
  return {
    x: Math.max(0, Math.round(box.x * fx)),
    y: Math.max(0, Math.round(box.y * fy)),
    w: Math.max(16, Math.round(box.w * fx)),
    h: Math.max(16, Math.round(box.h * fy))
  };
}

function renderCropBox(b) {
  const el = $('#cropBox');
  const layer = $('#cropLayer');
  if (!b) { el.style.display = 'none'; return; }
  layer.classList.add('on');
  el.style.display = 'block';
  el.style.left = b.x + 'px';
  el.style.top = b.y + 'px';
  el.style.width = b.w + 'px';
  el.style.height = b.h + 'px';
}

function applyRatio() {
  const img = $('#prevImg');
  if (!img.naturalWidth) { toast('شغّل المعاينة لتحديد النسبة', 'warn'); return; }
  const rr = RATIOS[S.ratio];
  if (!rr) return;
  const iw = previewStageW, ih = previewStageH;
  let h = Math.min(ih, iw / rr), w = h * rr;
  if (w > iw) { w = iw; h = w / rr; }
  box = { x: Math.round((iw - w) / 2), y: Math.round((ih - h) / 2), w: Math.round(w), h: Math.round(h) };
  renderCropBox(box);
}

function applyZoom(z) {
  const img = $('#prevImg');
  if (!img.naturalWidth) { toast('شغّل المعاينة أولاً', 'warn'); return; }
  const iw = previewStageW, ih = previewStageH;
  if (z <= 1.001) { applyRatio(); if (!box) return; return; }
  const rr = box ? box.w / box.h : 16 / 9;
  let w = iw / z, h = ih / z;
  if (w / h > rr) w = h * rr; else h = w / rr;
  const cx = box ? box.x + box.w / 2 : iw / 2;
  const cy = box ? box.y + box.h / 2 : ih / 2;
  let x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
  x = Math.max(0, Math.min(iw - Math.round(w), x));
  y = Math.max(0, Math.min(ih - Math.round(h), y));
  box = { x, y, w: Math.round(w), h: Math.round(h) };
  renderCropBox(box);
}

function setupCropDrag() {
  const layer = $('#cropLayer');
  const el = $('#cropBox');
  const wrap = $('#prevImgWrap');

  const pt = (ev) => {
    const r = wrap.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  el.addEventListener('mousedown', e => {
    if (!box) return;
    const h = e.target.dataset && e.target.dataset.h;
    const p = pt(e);
    dragging = { mode: h || 'move', sx: p.x, sy: p.y, box: Object.assign({}, box) };
    e.stopPropagation(); e.preventDefault();
  });

  layer.addEventListener('mousedown', e => {
    if (e.target !== layer && e.target !== wrap) return;
    const p = pt(e);
    dragging = { mode: 'new', sx: p.x, sy: p.y, box: null };
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const p = pt(e);
    const W = previewStageW, H = previewStageH;
    const dx = p.x - dragging.sx, dy = p.y - dragging.sy;

    if (dragging.mode === 'new') {
      let x = Math.max(0, Math.min(dragging.sx, p.x));
      let y = Math.max(0, Math.min(dragging.sy, p.y));
      let w = Math.abs(p.x - dragging.sx), h = Math.abs(p.y - dragging.sy);
      const rr = RATIOS[S.ratio];
      if (rr) { h = w / rr; if (y + h > H) { h = H - y; w = h * rr; } }
      w = Math.min(w, W - x); h = Math.min(h, H - y);
      if (w < 20 || h < 20) return;
      box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      renderCropBox(box);
      return;
    }

    const b = dragging.box;
    let nx = b.x, ny = b.y, nw = b.w, nh = b.h;
    if (dragging.mode === 'move') {
      nx = Math.max(0, Math.min(W - b.w, b.x + dx));
      ny = Math.max(0, Math.min(H - b.h, b.y + dy));
    } else {
      if (dragging.mode.includes('w')) { nx = Math.max(0, b.x + dx); nw = b.w - (nx - b.x); }
      if (dragging.mode.includes('e')) { nw = Math.max(24, b.w + dx); }
      if (dragging.mode.includes('n')) { ny = Math.max(0, b.y + dy); nh = b.h - (ny - b.y); }
      if (dragging.mode.includes('s')) { nh = Math.max(24, b.h + dy); }
      nx = Math.max(0, Math.min(W - 24, nx));
      ny = Math.max(0, Math.min(H - 24, ny));
      nw = Math.min(nw, W - nx); nh = Math.min(nh, H - ny);
    }
    box = { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
    renderCropBox(box);
  });

  window.addEventListener('mouseup', () => { dragging = null; });
}

// ---------------------------------------------------------------- البث
async function startStream() {
  if (streaming) return;
  const btn = $('#btnStreamStart');

  if (!S.youtubeKey) { toast('لا مفتاح بث — أدخله في اللوحة اليمنى', 'bad', 6000); return; }
  if (S.captureMode !== 'desktop' && !String(S.windowTitle || '').trim()) {
    toast('اختر نافذة، أو بدّل المصدر إلى «كل الشاشة»', 'bad', 6000); return;
  }

  if (box) {
    const c = cropToScreen();
    S.cropX = c.x; S.cropY = c.y; S.cropW = c.w; S.cropH = c.h;
    persist({ cropX: c.x, cropY: c.y, cropW: c.w, cropH: c.h });
  }

  busy(btn, true, 'جارٍ الاتصال والتحقق…');
  log('بدء البث — ' + S.outW + '×' + S.outH + ' @' + S.fps + ' · ' + S.videoBitrate +
      ' · قص ' + S.cropW + '×' + S.cropH + ' من (' + S.cropX + ',' + S.cropY + ')');
  log('سأتحقق من معدل الإطارات بعد 12 ثانية قبل أن أعلن النجاح…');

  const r = await L.streamStart(S);
  busy(btn, false);

  if (!r.ok) {
    toast('فشل بدء البث: ' + (r.error || 'سبب غير معروف'), 'bad', 10000);
    log('فشل البث: ' + (r.error || ''), 'bad');
    return;
  }
  streaming = true;
  reflectStream(true);
  previewOn = false; stopFrames();
  $('#prevIdle').style.display = 'none';
  $('#prevImg').style.display = 'none';
  $('#prevImg').removeAttribute('src');
  $('#cropLayer').classList.remove('on');
  $('#btnPrevStop').disabled = true;
  renderBannerOverlay();
  renderTitleOverlay();
  showLivePanel(true);
  toast('البث انطلق على يوتيوب ✓ — ' + (r.fps ? r.fps.toFixed(1) : S.fps) + ' إطار/ث مُتحقَّق منه', 'ok', 6000);
  log('البث يعمل — pid ' + r.pid + ' · الخادم ' + r.server +
      ' · معدل مُتحقَّق منه ' + (r.fps ? r.fps.toFixed(1) : '?'), 'ok');
}

async function stopStream() {
  await L.streamStop();
  streaming = false;
  reflectStream(false);
  showLivePanel(false);
  if (!previewOn) $('#prevIdle').style.display = 'grid';
  toast('أُوقف البث', 'ok', 2600);
  log('أُوقف البث بطلبك', 'ok');
}

// لوحة البث: تُعرض في مساحة المعاينة أثناء البث
function showLivePanel(on) {
  const el = $('#livePanel');
  if (!el) return;
  el.classList.toggle('on', !!on);
  $('#cropLayer').classList.toggle('on', !on && previewOn && !!$('#prevImg').src);
  if (on) {
    $('#liveStatTitle').textContent = S.streamTitle || 'GTA VI LIVE STREAMING';
    $('#liveStatRes').textContent = S.outW + ' × ' + S.outH + ' @ ' + S.fps;
    $('#liveStatBr').textContent = S.videoBitrate;
  }
}

function reflectStream(on) {
  $('#liveBadge').classList.toggle('on', on);
  $('#btnStreamStop').disabled = !on;
  $('#btnStreamStart').disabled = on;
  $('#btnPrevStart').disabled = on;
}

async function testKey() {
  const btn = $('#btnKeyTest');
  busy(btn, true, 'اختبار…');
  log('اختبار مفتاح يوتيوب…');
  const r = await L.keyTest(S.youtubeKey);
  busy(btn, false);
  if (r.ok) {
    setChip($('#chipKey'), 'ok', 'المفتاح مقبول');
    toast('✓ ' + r.message, 'ok', 5200);
    log('نجح الاختبار: ' + r.message, 'ok');
  } else {
    setChip($('#chipKey'), 'bad', 'المفتاح مرفوض');
    toast('✗ ' + r.error, 'bad', 9000);
    log('فشل الاختبار: ' + r.error, 'bad');
  }
}

// ---------------------------------------------------------------- الاستعلام
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const st = await L.state();
    $('#stFps').textContent = st.fps ? st.fps.toFixed(1) : '—';
    $('#stDrop').textContent = st.dropped || 0;
    $('#stTime').textContent = st.elapsed;
    $('#liveTime').textContent = st.elapsed;
    if (st.streaming !== streaming) { streaming = st.streaming; reflectStream(streaming); showLivePanel(streaming); }
    if (st.streaming) {
      const f = $('#liveStatFps'), tm = $('#liveStatTime');
      if (f) f.textContent = (st.fps ? st.fps.toFixed(1) : '—') + ' / ' + (S ? S.fps : '');
      if (tm) tm.textContent = st.elapsed;
      // ★ تحذير حي: معدل منخفض = يوتيوب لا يعرض البث
      const want = (S && S.fps) || 30;
      if (st.fps > 0 && st.fps < Math.max(3, want / 3)) {
        if (!lowFpsWarned) {
          lowFpsWarned = true;
          log('⚠ معدل الإطارات منخفض جداً (' + st.fps.toFixed(1) + '/' + want +
              ') — يوتيوب لن يعرض البث. بدّل إلى «موفّر» أو قلّل القص.', 'bad');
          toast('⚠ الجهاز عاجز عن هذه الجودة — بدّل إلى وضع «موفّر»', 'bad', 9000);
        }
        if (f) f.style.color = '#fca5a5';
      } else {
        lowFpsWarned = false;
        if (f) f.style.color = '';
      }
    }
  }, 1000);
}

// ---------------------------------------------------------------- المتصفح المدمج
function openBrowser() {
  $('#browserArea').classList.add('on');
  if (!$('#browserUrl').value) $('#browserUrl').value = 'https://studio.youtube.com';
  $('#browserUrl').focus();
}
function closeBrowser() {
  $('#browserArea').classList.remove('on');
  const wv = document.querySelector('#browserStage webview');
  if (wv) wv.remove();
  $('#browserHint').style.display = 'grid';
}
function goBrowser() {
  let url = $('#browserUrl').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const stage = $('#browserStage');
  let wv = stage.querySelector('webview');
  if (!wv) {
    wv = document.createElement('webview');
    wv.setAttribute('allowpopups', 'true');
    wv.setAttribute('partition', 'persist:latchi');
    wv.style.width = '100%';
    wv.style.height = '100%';
    stage.appendChild(wv);
  }
  $('#browserHint').style.display = 'none';
  wv.src = url;
  S.platformUrl = url;
  persist({ platformUrl: url });
  log('المتصفح المدمج: ' + url);
}

// ---------------------------------------------------------------- منبثق
function openModal(title, hint) {
  $('#mTitle').textContent = title;
  $('#mHint').innerHTML = hint || '';
  $('#mBody').innerHTML = '';
  $('#modal').classList.add('on');
  $('#mClose').onclick = () => $('#modal').classList.remove('on');
}

// ---------------------------------------------------------------- بدء
window.addEventListener('DOMContentLoaded', () => {
  boot().catch(e => {
    console.error(e);
    $('#gateHint').textContent = 'خطأ في التحميل: ' + (e && e.message);
  });
});

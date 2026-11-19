'use strict';
// ==============================================================================================
// LATCHI STREAM 4.0.1 — واجهة بث الفيديوهات المحلية
// لا معاينة، لا التقاط شاشة، لا متصفح مدمج. كل زر مربوط بوظيفة حقيقية في العملية الرئيسية.
// ==============================================================================================

const L = window.latchi;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

let S = null;            // آخر حالة من العملية الرئيسية
let channels = [];
let logCount = 0;

// ------------------------------------------------------------------ أدوات
function toast(msg, bad) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('bad', !!bad);
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 3400);
}
function showErr(title, msg) {
  $('#errTitle').textContent = title;
  $('#errMsg').textContent = msg;
  $('#errBox').classList.add('on');
}
function hideErr() { $('#errBox').classList.remove('on'); }
function hms(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(q).padStart(2, '0');
}
function addLog(text) {
  const box = $('#logbox');
  if (logCount === 0) box.innerHTML = '';
  logCount++;
  const d = document.createElement('div');
  let cls = '';
  if (/^\[ok\]/.test(text)) cls = 'ok';
  else if (/^\[err\]/.test(text)) cls = 'err';
  else if (/^\[warn\]/.test(text)) cls = 'warn';
  d.className = cls;
  d.textContent = text.replace(/^\[(ok|err|warn)\]\s*/, p => '');
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 300) box.removeChild(box.firstChild);
}

// ------------------------------------------------------------------ رسم الحالة
function render(st) {
  S = st;
  $('#verBadge').textContent = 'v' + st.version;

  // ---- 1) الحساب ----
  const authOk = st.auth && st.auth.connected;
  $('#stAuth').textContent = authOk ? 'مربوط' : (st.clientConfigured ? 'غير مربوط' : 'يحتاج إعداد OAuth');
  $('#stAuth').className = 'st ' + (authOk ? 'ok' : (st.clientConfigured ? 'warn' : 'bad'));
  $('#authOff').style.display = authOk ? 'none' : 'block';
  $('#authOn').style.display = authOk ? 'block' : 'none';
  if (authOk) {
    $('#acctName').textContent = st.auth.name || 'حساب Google';
    $('#acctEmail').textContent = st.auth.email || '';
    const av = $('#acctAvatar');
    av.innerHTML = st.auth.picture ? `<img src="${esc(st.auth.picture)}">` : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.7"/><path d="M5 20c0-3.5 3.1-5.6 7-5.6s7 2.1 7 5.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  }
  $('#cardChannel').classList.toggle('gray', !authOk);
  $('#btnRefreshCh').disabled = !authOk;
  $('#chHint').textContent = authOk ? '' : 'اربط حساب Google أولاً لجلب قنواتك.';

  // ---- 2) القناة ----
  const ch = st.channel;
  $('#stChannel').textContent = ch ? 'مختارة' : 'لم تُختر';
  $('#stChannel').className = 'st ' + (ch ? 'ok' : 'warn');
  $('#btnChangeCh').disabled = !authOk;

  // ---- 3) الفيديو ----
  const v = st.video;
  $('#cardVideo').classList.toggle('gray', !authOk);
  if (v && v.ok) {
    $('#videoEmpty').style.display = 'none';
    $('#videoBox').style.display = 'block';
    $('#stVideo').textContent = 'جاهز';
    $('#stVideo').className = 'st ok';
    $('#vName').textContent = v.fileName || '';
    $('#vDur').textContent = v.durationHMS || hms(v.duration);
    $('#vRes').textContent = v.video.width + '×' + v.video.height;
    $('#vSize').textContent = (v.sizeMB || 0) + ' MB';
    $('#vFps').textContent = String(v.video.fps || '—');
    $('#vCodec').textContent = String(v.video.codec || '').toUpperCase() + (v.video.profile ? ' / ' + v.video.profile : '');
    $('#vAudio').textContent = v.hasAudio ? (String(v.audio.codec).toUpperCase() + ' ' + v.audio.channels + 'ch') : 'بلا صوت';
    const strat = $('#vStrat');
    strat.className = 'strat' + (v.copySafe ? '' : ' tc');
    strat.textContent = (v.copySafe ? '● ' : '⟳ ') + (v.strategy || '') +
      (v.hasAudio ? '' : ' — سيُرسل صمت بدل الصوت (لا ميكروفون)');
  } else {
    $('#videoEmpty').style.display = 'block';
    $('#videoBox').style.display = 'none';
    $('#stVideo').textContent = 'لم يُختر';
    $('#stVideo').className = 'st warn';
  }

  // ---- 4) الإعدادات ----
  const m = st.settings;
  if (document.activeElement !== $('#inTitle')) $('#inTitle').value = m.title || '';
  if (document.activeElement !== $('#inDesc')) $('#inDesc').value = m.description || '';
  $('#titleCount').textContent = ($('#inTitle').value || '').length + ' / 100';
  const pr = document.querySelector(`input[name=priv][value="${m.privacy || 'unlisted'}"]`);
  if (pr) pr.checked = true;
  $('#inKids').checked = !!m.madeForKids;
  if (m.categoryId) $('#inCategory').value = m.categoryId;
  $('#thumbName').textContent = m.thumbnail ? m.thumbnail.split(/[\\/]/).pop() : 'لم تُختر';

  // ---- 5) التشغيل ----
  const phase = st.phase || 'idle';
  const phaseMap = {
    idle: ['جاهز', ''], preparing: ['تجهيز البث…', 'warn'], connecting: ['جارٍ الاتصال بـ YouTube…', 'warn'],
    ready: ['YouTube جاهز', 'ok'], live: ['مباشر الآن', 'ok'], stopping: ['جارٍ الإيقاف…', 'warn'],
    done: ['انتهى البث', 'ok'], error: ['خطأ', 'bad']
  };
  const pm = phaseMap[phase] || ['جاهز', ''];
  $('#stLive').textContent = pm[0];
  $('#stLive').className = 'st ' + pm[1];

  const running = ['preparing', 'connecting', 'ready', 'live', 'stopping'].includes(phase);
  $('#liveBox').classList.toggle('on', ['connecting', 'ready', 'live', 'stopping', 'done'].includes(phase));
  $('#btnStop').style.display = (running && phase !== 'stopping') ? 'inline-flex' : 'none';
  $('#btnStart').style.display = (running || phase === 'error') ? 'none' : 'inline-flex';
  $('#btnStart').disabled = !(authOk && ch && v && st.tools.ffmpeg && st.tools.ffprobe);

  // مؤشر الحالة
  const dot = $('#lvDot');
  dot.className = 'dot' + (phase === 'live' ? ' live' : phase === 'ready' ? ' ready'
    : (phase === 'connecting' || phase === 'preparing') ? ' conn' : '');
  $('#lvPhase').textContent = pm[0];

  // التقدم
  const dur = st.duration || 0;
  const cur = (st.progress && st.progress.outTimeMs ? st.progress.outTimeMs / 1000000 : st.elapsed) || 0;
  $('#lvTime').textContent = hms(cur) + ' / ' + hms(dur);
  $('#lvBar').style.width = dur > 0 ? Math.min(100, (cur / dur) * 100) + '%' : '0%';
  $('#stFrame').textContent = (st.progress && st.progress.frame) || 0;
  $('#stFps').textContent = (st.progress && st.progress.fps) || 0;
  $('#stRate').textContent = (st.progress && st.progress.bitrate) || '—';
  $('#stSpeed').textContent = (st.progress && st.progress.speed) || '—';
  $('#stDrop').textContent = (st.progress && st.progress.dropFrames) || 0;

  // روابط
  const hasBr = !!st.broadcast;
  $('#btnWatch').disabled = !hasBr;
  $('#btnStudio').disabled = !hasBr;

  // تلميح البدء
  const missing = [];
  if (!authOk) missing.push('ربط الحساب');
  if (!ch) missing.push('اختيار القناة');
  if (!v) missing.push('اختيار الفيديو');
  if (!st.tools.ffmpeg) missing.push('ffmpeg');
  if (!st.tools.ffprobe) missing.push('ffprobe');
  $('#startHint').textContent = missing.length ? ('ينقص: ' + missing.join(' · ')) : 'كل شيء جاهز — اضغط START LIVE STREAM';

  // أخطاء
  if (st.error && phase === 'error') showErr('فشل البث', st.error);
  else hideErr();
}

// ------------------------------------------------------------------ القنوات
async function loadChannels() {
  const r = await L.listChannels();
  if (!r.ok) { toast(r.error || 'تعذّر جلب القنوات', true); return; }
  channels = r.channels || [];
  renderChannels(r.selected);
  if (channels.length === 0) toast('لا توجد قناة YouTube في هذا الحساب', true);
  else if (channels.length === 1) toast('تم اختيار قناتك تلقائياً: ' + channels[0].title);
}

function renderChannels(selectedId) {
  const box = $('#chList');
  if (!channels.length) { box.innerHTML = ''; return; }
  box.innerHTML = channels.map(c => {
    const sel = c.id === selectedId ? ' sel' : '';
    const av = c.thumbnail ? `<img src="${esc(c.thumbnail)}">` : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><rect x="3" y="7" width="18" height="12" rx="2.5" stroke="currentColor" stroke-width="1.7"/><path d="M8 3.5 12 7l4-3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
    return `<div class="ch${sel}" data-id="${esc(c.id)}">
      <div class="av">${av}</div>
      <div class="t"><b>${esc(c.title)}</b><span>${c.subscribers.toLocaleString('en')} مشترك · ${c.videos} فيديو</span></div>
      ${c.id === selectedId ? '<span class="tick">✓</span>' : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.ch').forEach(el => {
    el.addEventListener('click', async () => {
      const r = await L.selectChannel(el.dataset.id);
      if (r.ok) {
        renderChannels(el.dataset.id);
        toast('تم اختيار القناة: ' + r.channel.title);
        refresh();
      } else toast(r.error || 'تعذّر اختيار القناة', true);
    });
  });
}

// ------------------------------------------------------------------ الأحداث
async function refresh() { render(await L.state()); }

function wire() {
  // OAuth
  $('#btnConnect').addEventListener('click', async () => {
    hideErr();
    const st = await L.state();
    if (!st.clientConfigured) { $('#modalOauth').classList.add('on'); return; }
    toast('فُتح متصفح النظام — اختر حسابك واسمح بالوصول');
    $('#btnConnect').disabled = true;
    const r = await L.connect();
    $('#btnConnect').disabled = false;
    if (r.ok) {
      toast('تم ربط الحساب ✓');
      await refresh();
      await loadChannels();
      loadCategories();
    } else showErr('فشل ربط الحساب', r.error || 'خطأ غير معروف');
  });
  $('#btnDisconnect').addEventListener('click', async () => {
    await L.disconnect();
    channels = []; renderChannels('');
    toast('تم قطع الربط');
    refresh();
  });

  // إعداد OAuth
  $('#btnSetupOauth').addEventListener('click', () => $('#modalOauth').classList.add('on'));
  $('#btnSettings').addEventListener('click', () => $('#modalOauth').classList.add('on'));
  $('#btnOauthCancel').addEventListener('click', () => $('#modalOauth').classList.remove('on'));
  $('#btnOauthSave').addEventListener('click', async () => {
    const id = $('#inClientId').value.trim();
    const r = await L.setClientId(id);
    if (r.ok) { $('#modalOauth').classList.remove('on'); toast('حُفظ Client ID ✓'); refresh(); }
    else toast(r.error || 'معرّف غير صالح', true);
  });

  // القنوات
  $('#btnRefreshCh').addEventListener('click', loadChannels);
  $('#btnChangeCh').addEventListener('click', () => {
    if (channels.length <= 1) { loadChannels(); return; }
    $('#chList').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('اختر القناة من القائمة');
  });

  // الفيديو
  const pick = async () => {
    hideErr();
    toast('جارٍ فحص الملف…');
    const r = await L.pickVideo();
    if (r.canceled) return;
    if (!r.ok) { showErr('تعذّر فحص الفيديو', r.error || 'ملف غير مدعوم'); return; }
    toast('تم فحص الفيديو ✓ ' + (r.video.copySafe ? '(نسخ مباشر بلا ترميز)' : '(ترميز خفيف)'));
    refresh();
  };
  $('#btnSelectVideo').addEventListener('click', pick);
  $('#btnChangeVideo').addEventListener('click', pick);
  $('#dropZone').addEventListener('click', pick);

  // الصورة المصغّرة
  $('#btnThumb').addEventListener('click', async () => {
    const r = await L.pickThumbnail();
    if (r.canceled) return;
    if (!r.ok) { toast(r.error || 'تعذّر اختيار الصورة', true); return; }
    toast('حُفظت الصورة المصغّرة');
    refresh();
  });

  // العنوان
  $('#inTitle').addEventListener('input', e => {
    $('#titleCount').textContent = e.target.value.length + ' / 100';
  });

  // البدء / الإيقاف
  $('#btnStart').addEventListener('click', async () => {
    hideErr();
    $('#btnStart').disabled = true;
    const meta = {
      title: $('#inTitle').value.trim() || 'LATCHI STREAM',
      description: $('#inDesc').value,
      privacy: (document.querySelector('input[name=priv]:checked') || {}).value || 'unlisted',
      madeForKids: $('#inKids').checked,
      categoryId: $('#inCategory').value || ''
    };
    toast('جارٍ تجهيز البث على YouTube…');
    const r = await L.startLive(meta);
    if (!r.ok) showErr('تعذّر بدء البث', r.error || 'خطأ غير معروف');
    else toast('بدأ البث — راقب الحالة');
    refresh();
  });
  $('#btnStop').addEventListener('click', async () => {
    $('#btnStop').disabled = true;
    toast('جارٍ إيقاف البث…');
    const r = await L.stopLive();
    $('#btnStop').disabled = false;
    if (r.ok) toast('تم إيقاف البث وإنهاؤه على YouTube');
    refresh();
  });

  // الروابط
  $('#btnWatch').addEventListener('click', () => { if (S && S.broadcast) L.openUrl(S.broadcast.watchUrl); });
  $('#btnStudio').addEventListener('click', () => { if (S && S.broadcast) L.openUrl(S.broadcast.studioUrl); });

  // السجل
  $('#btnClearLog').addEventListener('click', () => {
    $('#logbox').innerHTML = '<div style="color:#5f7392">لا سجلات بعد.</div>';
    logCount = 0;
  });

  // سحب ملف على الواجهة
  document.addEventListener('dragover', e => { e.preventDefault(); $('#dropZone') && $('#dropZone').classList.add('hot'); });
  document.addEventListener('dragleave', () => $('#dropZone') && $('#dropZone').classList.remove('hot'));
  document.addEventListener('drop', async e => {
    e.preventDefault();
    $('#dropZone') && $('#dropZone').classList.remove('hot');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    // في Electron نحتاج المسار الحقيقي — نحصل عليه من webUtils عند الحاجة؛ هنا نعتمد زر الاختيار
    toast('استخدم زر SELECT VIDEO لاختيار الملف');
  });

  L.onState(render);
  L.onLog(addLog);
}

async function loadCategories() {
  const r = await L.categories();
  if (!r.ok || !r.categories) return;
  const sel = $('#inCategory');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— تلقائي —</option>' +
    r.categories.map(c => `<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');
  if (cur) sel.value = cur;
}

// ------------------------------------------------------------------ الإقلاع
(async function boot() {
  wire();
  await refresh();
  if (S && S.auth && S.auth.connected) { await loadChannels(); loadCategories(); }
  else if (S && S.clientConfigured === false) {
    toast('ابدأ بـ «إعداد OAuth» لإضافة Google Client ID');
  }
})();

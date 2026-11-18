const { app, BrowserWindow } = require('electron');
const fs = require('fs');
require(require('path').join(__dirname,'..','main.js'));

let pass = 0, fail = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const os = require('os');
const OUT = (n) => path_join(os.tmpdir(), n);
const path_join = require('path').join;

app.whenReady().then(async () => {
  await sleep(3200);
  const w = BrowserWindow.getAllWindows()[0];
  const errs = [];
  w.webContents.on('console-message', (e, l, m) => { if (l >= 2) errs.push(m); });
  const ev = (js) => w.webContents.executeJavaScript(js);

  console.log('\n=== 0) الافتتاح ===');
  const boot = await ev(`(async () => ({
    hasApi: typeof window.latchi === 'object',
    gate: getComputedStyle(document.querySelector('#gate')).display !== 'none',
    ffmpeg: document.querySelector('#chipFfmpeg').className,
    key: document.querySelector('#chipKey').textContent,
    ver: document.querySelector('#verLine').textContent,
    banner: !!document.querySelector('#bannerImg').getAttribute('src'),
    title: document.querySelector('#txtTitle').value,
    font: document.querySelector('#fontLine').textContent
  }))()`);
  t('جسر window.latchi موجود', boot.hasApi);
  t('بوابة البداية ظاهرة', boot.gate);
  t('ffmpeg جاهز', boot.ffmpeg.includes('ok'), boot.ffmpeg);
  t('المفتاح مدمج', boot.key.includes('مدمج'), boot.key);
  t('رقم الإصدار 3.0.0', boot.ver.includes('3.0.0'), boot.ver);
  t('البانر محمّل', boot.banner);
  t('العنوان الافتراضي', boot.title === 'GTA VI LIVE STREAMING', boot.title);
  t('خط العنوان موجود', boot.font.includes('.ttf') || boot.font.includes('.otf'), boot.font);

  await ev(`document.querySelector('#gateGo').click()`);
  t('البوابة تُغلق', await ev(`getComputedStyle(document.querySelector('#gate')).display === 'none'`));

  console.log('\n=== 1) المعاينة ===');
  await ev(`document.querySelector('#btnPrevStart').click()`);
  let ok = false;
  for (let i = 0; i < 40; i++) { if (await ev(`document.querySelector('#prevImg').src.length > 5000`)) { ok = true; break; } await sleep(300); }
  t('المعاينة تعرض إطاراً', ok);
  const pv = await ev(`(async () => ({
    on: (await window.latchi.state()).previewOn,
    stopEnabled: !document.querySelector('#btnPrevStop').disabled,
    startDisabled: document.querySelector('#btnPrevStart').disabled,
    cropLayer: document.querySelector('#cropLayer').classList.contains('on'),
    bannerLayer: document.querySelector('#prevBannerLayer').style.display,
    titleLayer: document.querySelector('#prevTitleLayer').style.display,
    titleText: document.querySelector('#prevTitleLayer').textContent
  }))()`);
  t('الحالة: المعاينة شغّالة', pv.on);
  t('زر الإيقاف مفعّل', pv.stopEnabled);
  t('طبقة البانر ظاهرة', pv.bannerLayer === 'block', pv.bannerLayer);
  t('طبقة العنوان ظاهرة', pv.titleLayer === 'block', pv.titleLayer);
  t('نص العنوان صحيح', pv.titleText === 'GTA VI LIVE STREAMING', pv.titleText);
  await w.webContents.capturePage().then(i => fs.writeFileSync(OUT('ui_preview.png'), i.toPNG()));

  console.log('\n=== 2) زر الإيقاف يوقف فعلاً ===');
  await ev(`document.querySelector('#btnPrevStop').click()`);
  await sleep(1500);
  const stop = await ev(`(async () => ({
    on: (await window.latchi.state()).previewOn,
    hidden: document.querySelector('#prevImg').style.display === 'none',
    cleared: !document.querySelector('#prevImg').getAttribute('src'),
    disabled: document.querySelector('#btnPrevStop').disabled,
    idle: getComputedStyle(document.querySelector('#prevIdle')).display !== 'none',
    bannerGone: document.querySelector('#prevBannerLayer').style.display === 'none',
    toast: document.querySelector('#toasts').textContent.includes('إيقاف')
  }))()`);
  t('الحالة: المعاينة متوقفة', !stop.on);
  t('الصورة مخفية', stop.hidden);
  t('مصدر الصورة محذوف', stop.cleared);
  t('زر الإيقاف معطّل', stop.disabled);
  t('شاشة الانتظار ظاهرة', stop.idle);
  t('طبقة البانر مخفية', stop.bannerGone);
  t('إشعار الإيقاف ظهر', stop.toast);

  console.log('\n=== 3) القص والزوم والحفظ ===');
  await ev(`document.querySelector('#btnPrevStart').click()`);
  for (let i = 0; i < 30; i++) { if (await ev(`document.querySelector('#prevImg').src.length > 5000`)) break; await sleep(300); }
  await ev(`document.querySelector('#ratioSeg button[data-ratio="16:9"]').click()`);
  await sleep(300);
  const r169 = await ev(`(() => { const b = document.querySelector('#cropBox').style; return {w:parseFloat(b.width),h:parseFloat(b.height)}; })()`);
  t('نسبة 16:9 مطبقة', Math.abs(r169.w / r169.h - 16/9) < 0.06, r169);
  await ev(`document.querySelector('#rngZoom').value=250; document.querySelector('#rngZoom').dispatchEvent(new Event('input'));`);
  await sleep(300);
  const zoom = await ev(`({lbl: document.querySelector('#lblZoom').textContent, w: parseFloat(document.querySelector('#cropBox').style.width)})`);
  t('الزوم 2.5×', zoom.lbl === '2.5×', zoom.lbl);
  t('منطقة القص صغرت', zoom.w < r169.w, { before: r169.w, after: zoom.w });
  await ev(`document.querySelector('#btnSaveCrop').click()`);
  await sleep(600);
  const saved = await ev(`window.latchi.getSettings()`);
  t('حُفظ القص في الإعدادات', saved.cropW > 0 && saved.cropH > 0 && saved.cropW < saved.screenW, { w: saved.cropW, h: saved.cropH, sw: saved.screenW });
  t('النسبة محفوظة', saved.ratio === '16:9', saved.ratio);
  t('إشعار الحفظ', await ev(`document.querySelector('#toasts').textContent.includes('حُفظ الاختيار')`));
  await ev(`document.querySelector('#btnResetCrop').click()`);
  await sleep(400);
  const reset = await ev(`window.latchi.getSettings()`);
  t('زر ملء الشاشة يعيد القص', reset.cropW === reset.screenW && reset.cropH === reset.screenH, { w: reset.cropW, sw: reset.screenW });

  console.log('\n=== 4) البانر والعنوان ===');
  await ev(`document.querySelector('#chkBanner').checked=false; document.querySelector('#chkBanner').dispatchEvent(new Event('change'));`);
  await sleep(400);
  t('إخفاء البانر يعمل', await ev(`document.querySelector('#prevBannerLayer').style.display === 'none'`));
  await ev(`document.querySelector('#chkBanner').checked=true; document.querySelector('#chkBanner').dispatchEvent(new Event('change'));`);
  await sleep(400);
  t('إظهار البانر يعمل', await ev(`document.querySelector('#prevBannerLayer').style.display === 'block'`));
  await ev(`document.querySelector('#txtTitle').value='بث تجريبي 2026'; document.querySelector('#txtTitle').dispatchEvent(new Event('input')); document.querySelector('#txtTitle').dispatchEvent(new Event('change'));`);
  await sleep(400);
  t('تغيير العنوان يظهر فوراً', await ev(`document.querySelector('#prevTitleLayer').textContent === 'بث تجريبي 2026'`));
  t('العنوان محفوظ', (await ev(`window.latchi.getSettings()`)).streamTitle === 'بث تجريبي 2026');
  await ev(`document.querySelector('#txtTitle').value='GTA VI LIVE STREAMING'; document.querySelector('#txtTitle').dispatchEvent(new Event('change'));`);
  await ev(`document.querySelector('#selTitlePos').value='bottomcenter'; document.querySelector('#selTitlePos').dispatchEvent(new Event('change'));`);
  await sleep(300);
  const pos = await ev(`document.querySelector('#prevTitleLayer').style.bottom`);
  t('موضع العنوان (أسفل)', pos === '8%', pos);
  await ev(`document.querySelector('#selTitlePos').value='topcenter'; document.querySelector('#selTitlePos').dispatchEvent(new Event('change'));`);

  console.log('\n=== 5) الجودة والأوضاع ===');
  for (const [p, exp] of [['saver',[854,480,'15','900k']],['high',[1280,720,'30','4000k']],['portrait',[720,1280,'30','2500k']],['balanced',[1280,720,'30','2500k']]]) {
    await ev(`document.querySelector('#presetSeg button[data-preset="${p}"]').click()`);
    await sleep(250);
    const s = await ev(`window.latchi.getSettings()`);
    t('الوضع ' + p, s.outW === exp[0] && s.outH === exp[1] && String(s.fps) === exp[2] && s.videoBitrate === exp[3],
      [s.outW, s.outH, s.fps, s.videoBitrate]);
  }
  await ev(`document.querySelector('#selRes').value='1920x1080'; document.querySelector('#selRes').dispatchEvent(new Event('change'));`);
  await sleep(250);
  t('تغيير الدقة', (await ev(`window.latchi.getSettings()`)).outW === 1920);
  await ev(`document.querySelector('#selRes').value='1280x720'; document.querySelector('#selRes').dispatchEvent(new Event('change'));`);

  console.log('\n=== 6) المصدر ===');
  await ev(`document.querySelector('#modeSeg button[data-mode="window"]').click()`);
  await sleep(300);
  t('التبديل إلى نافذة', (await ev(`window.latchi.getSettings()`)).captureMode === 'window');
  t('قائمة النوافذ مفعّلة', await ev(`!document.querySelector('#selWindow').disabled`));
  await ev(`document.querySelector('#modeSeg button[data-mode="desktop"]').click()`);
  await sleep(300);
  t('العودة إلى كل الشاشة', (await ev(`window.latchi.getSettings()`)).captureMode === 'desktop');
  t('قائمة النوافذ معطّلة', await ev(`document.querySelector('#selWindow').disabled`));

  console.log('\n=== 7) مفتاح البث ===');
  t('المفتاح مخفي (password)', await ev(`document.querySelector('#txtKey').type === 'password'`));
  await ev(`document.querySelector('#chkKeyMask').checked=false; document.querySelector('#chkKeyMask').dispatchEvent(new Event('change'));`);
  t('إظهار المفتاح يعمل', await ev(`document.querySelector('#txtKey').type === 'text'`));
  await ev(`document.querySelector('#chkKeyMask').checked=true; document.querySelector('#chkKeyMask').dispatchEvent(new Event('change'));`);

  console.log('\n=== 8) المتصفح المدمج ===');
  await ev(`document.querySelector('#btnBrowserTop').click()`);
  await sleep(300);
  t('المتصفح يُفتح داخل التطبيق', await ev(`document.querySelector('#browserArea').classList.contains('on')`));
  t('لا نافذة متصفح جديدة', BrowserWindow.getAllWindows().length === 1, BrowserWindow.getAllWindows().length);
  await ev(`document.querySelector('#browserUrl').value='https://studio.youtube.com'; document.querySelector('#btnBrowserGo').click();`);
  await sleep(2500);
  const wv = await ev(`(() => { const w=document.querySelector('#browserStage webview'); return { exists: !!w, src: w ? w.src : '' }; })()`);
  t('webview أُنشئ بلا أخطاء', wv.exists, wv);
  await ev(`document.querySelector('#btnBrowserClose').click()`);
  await sleep(300);
  t('المتصفح يُغلق', await ev(`!document.querySelector('#browserArea').classList.contains('on')`));

  console.log('\n=== 9) البث الحي (خادم RTMP محلي) ===');
  await ev(`document.querySelector('#txtTitle').value='GTA VI LIVE STREAMING'; document.querySelector('#txtTitle').dispatchEvent(new Event('change'));`);
  await ev(`document.querySelector('#btnStreamStart').click()`);
  let started = null;
  for (let i = 0; i < 70; i++) {
    const st = await ev(`window.latchi.state()`);
    if (st.streaming) { started = st; break; }
    const tx = await ev(`document.querySelector('#toasts').textContent`);
    if (tx.includes('فشل')) { started = { fail: tx.trim() }; break; }
    await sleep(400);
  }
  t('البث بدأ فعلياً', started && started.streaming === true, started);
  t('زر البث معطّل أثناء البث', await ev(`document.querySelector('#btnStreamStart').disabled`));
  t('زر الإيقاف مفعّل', await ev(`!document.querySelector('#btnStreamStop').disabled`));
  t('شارة «مباشر» ظاهرة', await ev(`document.querySelector('#liveBadge').classList.contains('on')`));
  await sleep(4000);
  const live = await ev(`window.latchi.state()`);
  t('معدل الإطارات في البث', live.fps > 20 && live.fps < 45, live.fps);
  t('لا إطارات مسقطة', live.dropped === 0, live.dropped);
  t('البِتريت ~2500k', /^2[0-9]{3}/.test(live.bitrate), live.bitrate);
  t('الخادم يُذكر', !!live.server, live.server);
  await w.webContents.capturePage().then(i => fs.writeFileSync(OUT('ui_live.png'), i.toPNG()));
  await ev(`document.querySelector('#btnStreamStop').click()`);
  await sleep(1500);
  const stopped = await ev(`window.latchi.state()`);
  t('إيقاف البث يعمل', !stopped.streaming);
  t('شارة «مباشر» اختفت', await ev(`!document.querySelector('#liveBadge').classList.contains('on')`));

  console.log('\n=== 10) أخطاء الواجهة ===');
  t('لا أخطاء JavaScript', errs.length === 0, errs);

  if (process.env.LATCHI_SKIP_LIVE === '1') {
    console.log('\n(تخطّي اختبار البث الحي — LATCHI_SKIP_LIVE=1)');
  }
  console.log('\n======== ' + pass + ' نجح · ' + fail + ' فشل ========');
  if (fails.length) console.log('FAILS:\n' + fails.map(f => ' - ' + f).join('\n'));
  fs.writeFileSync(OUT('uitest_result.json'), JSON.stringify({ pass, fail, fails }, null, 2));
  app.exit(fail ? 1 : 0);
});

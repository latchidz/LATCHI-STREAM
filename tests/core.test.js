const core = require(require('path').join(__dirname,'..','core','LatchiCore.js'));
let pass=0, fail=0;
function t(name, cond, extra){ if(cond){pass++;console.log('  ✓ '+name);} else {fail++;console.log('  ✗ '+name+(extra!==undefined?'  → '+extra:''));} }

console.log('--- المفتاح المدمج ---');
const k = core.embeddedKey();
t('المفتاح ليس فارغاً', k.length>10, k.length);
t('طول المفتاح 16+', k.length>=16, k.length);
t('بلا مسافات', !/\s/.test(k));
// الأمان: لا يُطبع المفتاح الصريح أبداً — اللوج عام
console.log('  المفتاح (مقنَّع):', k.slice(0,2)+'***'+k.slice(-2), '· الطول', k.length);

console.log('--- تنظيف المفتاح ---');
t('تنظيف رابط كامل', core.cleanStreamKey('rtmp://a.rtmp.youtube.com/live2/abcd-1234-efgh-5678')==='abcd-1234-efgh-5678');
t('تنظيف الاحتياطي', core.cleanStreamKey('rtmp://b.rtmp.youtube.com/live2?backup=1/abcd-1234-efgh-5678')==='abcd-1234-efgh-5678');
t('تنظيف مسافات', core.cleanStreamKey('  abcd-1234-efgh-5678  ')==='abcd-1234-efgh-5678');

console.log('--- فحص الشكل ---');
t('مفتاح صالح', core.testKeyShape('abcd-1234-efgh-5678').ok);
t('فارغ مرفوض', !core.testKeyShape('').ok);
t('قصير مرفوض', !core.testKeyShape('abc').ok);
t('بمسافة مرفوض', !core.testKeyShape('abcd 1234 efgh 5678').ok);

console.log('--- نقاط النهاية ---');
const eps = core.youtubeEndpoints('X1Y2-Z3W4');
t('نقطتان', eps.length===2);
t('الرئيسي a.rtmp', eps[0].url==='rtmp://a.rtmp.youtube.com/live2/X1Y2-Z3W4', eps[0].url);
t('الاحتياطي b.rtmp + backup=1', eps[1].url==='rtmp://b.rtmp.youtube.com/live2?backup=1/X1Y2-Z3W4', eps[1].url);

console.log('--- الإعدادات ---');
const d = core.defaultSettings(1920,1080);
t('العنوان افتراضي', d.streamTitle==='GTA VI LIVE STREAMING', d.streamTitle);
t('البانر مفعّل', d.bannerEnabled===true);
t('العنوان مفعّل', d.titleEnabled===true);
t('القص = الشاشة', d.cropW===1920&&d.cropH===1080);
t('صوت النظام فقط', d.audioMode==='system');

console.log('--- الدمج (سياسة الصوت) ---');
const m = core.mergeSettings({audioMode:'mic', streamTitle:'X'}, core.defaultSettings());
t('الميكروفون يُلغى', m.audioMode==='system', m.audioMode);
t('العنوان يُحفظ', m.streamTitle==='X');

console.log('--- الأوضاع ---');
const t2 = core.presetTable();
t('4 أوضاع', Object.keys(t2).length===4);
const b = core.applyPreset(core.defaultSettings(), 'balanced');
t('متوازن 1280x720', b.outW===1280&&b.outH===720);
t('متوازن 2500k', b.videoBitrate==='2500k');

console.log('--- القص ---');
t('قص افتراضي كامل', JSON.stringify(core.effectiveCrop(d))==='{"x":0,"y":0,"w":1920,"h":1080}');
const c2 = core.effectiveCrop({screenW:1920,screenH:1080,cropX:1900,cropY:1000,cropW:500,cropH:500});
t('قص يتجاوز الحد يُقلَّم', c2.x===1900&&c2.y===1000&&c2.x+c2.w<=1920&&c2.y+c2.h<=1080, JSON.stringify(c2));
const c3 = core.effectiveCrop({screenW:1920,screenH:1080,cropW:1921,cropH:1081});
t('أبعاد زوجية', c3.w%2===0&&c3.h%2===0, JSON.stringify(c3));

console.log('--- سلسلة الفلاتر ---');
const vf = core.buildVideoFilter(b);
t('تحتوي crop', vf.includes('crop=1920:1080:0:0'), vf);
t('تحتوي fps', vf.includes('fps=30'));
t('تحتوي scale', vf.includes('scale=1280:720'));
t('تحتوي pad', vf.includes('pad=1280:720'));
t('تحتوي yuv420p', vf.includes('format=yuv420p'));

console.log('--- أمر البث ---');
const live = core.buildLiveArgs(Object.assign({}, b, {audioDevice:'Stereo Mix', youtubeKey:'X1Y2-Z3W4-ABCD-5678'}), '/tmp/p.txt');
t('نجح البناء', live.ok===true, JSON.stringify(live.errors));
const a = live.args;
t('به gdigrab', a.includes('gdigrab'));
t('به desktop', a.includes('desktop'));
t('به dshow للصوت', a.includes('dshow'));
t('به filter_complex', a.includes('-filter_complex'));
t('به map للفيديو', a[a.indexOf('-map')+1]==='[base]', a[a.indexOf('-map')+1]);
t('به map للصوت', a[a.indexOf('-map', a.indexOf('-map')+1)+1]==='[aout]');
t('به libx264', a.includes('libx264'));
t('به zerolatency', a.includes('zerolatency'));
t('به threads تلقائي (0)', a[a.indexOf('-threads')+1]==='0', a[a.indexOf('-threads')+1]);
t('به flv', a.includes('flv'));
t('به رابط a.rtmp', a[a.length-1].startsWith('rtmp://a.rtmp.youtube.com/live2/'));
t('به progress', a.includes('-progress'));
t('الصوت aac', a.includes('aac'));

console.log('--- البث الاحتياطي ---');
const liveB = core.buildLiveArgs(Object.assign({}, b, {audioDevice:'Stereo Mix', youtubeKey:'X1Y2-Z3W4-ABCD-5678'}), '/tmp/p.txt', 'backup');
t('رابط b.rtmp', liveB.args[liveB.args.length-1].startsWith('rtmp://b.rtmp.youtube.com/live2?backup=1/'));

console.log('--- بلا جهاز صوت (صمت) ---');
const liveS = core.buildLiveArgs(Object.assign({}, b, {audioDevice:'', youtubeKey:'X1Y2-Z3W4-ABCD-5678'}), '/tmp/p.txt');
t('anullsrc', liveS.args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
t('لا dshow', !liveS.args.includes('dshow'));

console.log('--- نافذة بلا عنوان = خطأ ---');
const liveW = core.buildLiveArgs(Object.assign({}, b, {captureMode:'window', windowTitle:'', youtubeKey:'X1Y2-Z3W4-ABCD-5678'}), '/tmp/p.txt');
t('يرفض نافذة فارغة', liveW.ok===false, JSON.stringify(liveW.errors));

console.log('--- مفتاح خاطئ = خطأ ---');
const liveK = core.buildLiveArgs(Object.assign({}, b, {youtubeKey:'', audioDevice:'x'}), '/tmp/p.txt');
t('يرفض مفتاحاً فارغاً', liveK.ok===false);

console.log('--- البانر في الفلاتر ---');
const liveBa = core.buildLiveArgs(Object.assign({}, b, {
  youtubeKey:'X1Y2-Z3W4-ABCD-5678', audioDevice:'Stereo Mix',
  bannerEnabled:true, bannerPath:'C:/b.png', titleEnabled:true, titleFont:'C:/Windows/Fonts/segoeuib.ttf'
}), '/tmp/p.txt');
const fc = liveBa.args[liveBa.args.indexOf('-filter_complex')+1];
t('البانر في الفلاتر', fc.includes('[banner]') && fc.includes('overlay=0:0'));
t('العنوان drawtext', fc.includes('drawtext='));
t('fade out', fc.includes('fade=out'));
t('map إلى [titled]', liveBa.args[liveBa.args.indexOf('-map')+1]==='[titled]');
console.log('  fc =', fc.slice(0,320));

console.log('--- المعاينة ---');
const pv = core.buildPreviewArgs(b);
t('mjpeg', pv.includes('mjpeg'));
t('image2', pv.includes('image2'));
t('update 1', pv.includes('-update') && pv[pv.indexOf('-update')+1]==='1');
t('preview 8 إطارات', pv[pv.indexOf('-framerate')+1]==='8');
t('scale 720', pv.some(x=>String(x).includes('scale=720')));

console.log('--- تصفية الصوت ---');
const sel = core.selectSystemAudioDevices(['Microphone (Realtek)','Stereo Mix (Realtek)','Line In','Headset Mic','Speakers (Realtek)']);
t('حُجب الميكروفون', sel.blocked.some(x=>x.includes('Microphone')), JSON.stringify(sel.blocked));
t('حُجب الهيدست', sel.blocked.some(x=>x.includes('Headset')));
t('حُجب Line In', sel.blocked.some(x=>x.includes('Line In')));
t('بقي Stereo Mix', sel.devices.some(x=>x.includes('Stereo Mix')));
t('Stereo Mix أولاً', sel.devices[0].includes('Stereo Mix'), sel.devices[0]);

console.log('--- jpeg ---');
const jpg = Buffer.from([0xFF,0xD8,0x11,0x22,0xFF,0xD9]);
t('jpeg صالح', core.isJpeg(jpg));
t('غير jpeg مرفوض', !core.isJpeg(Buffer.from([0x00,0x01,0x02,0x03])));


console.log('--- -re على كل المدخلات (سبب FPS=0.1) ---');
t('anum re على anullsrc', (()=>{const i=liveS.args.indexOf('anullsrc=channel_layout=stereo:sample_rate=48000'); return i>0 && liveS.args.slice(Math.max(0,i-8),i).includes('-re');})(), liveS.args.slice(Math.max(0,liveS.args.indexOf('anullsrc=channel_layout=stereo:sample_rate=48000')-3), liveS.args.indexOf('anullsrc=channel_layout=stereo:sample_rate=48000')+1));
const banArgs = core.buildLiveArgs(Object.assign({}, b, {
  youtubeKey:'X1Y2-Z3W4-ABCD-5678', audioDevice:'Stereo Mix',
  bannerEnabled:true, bannerPath:'/banner.png', titleEnabled:false
}), '/tmp/p.txt').args;
const bi = banArgs.findIndex(x => String(x).endsWith('/banner.png'));
t('re قبل البانر', bi > 1 && banArgs.slice(Math.max(0,bi-8), bi).includes('-re'), banArgs.slice(Math.max(0,bi-8), bi+1));
t('loop 1 للبانر', bi > 0 && banArgs.includes('-loop') && banArgs[banArgs.indexOf('-loop')+1]==='1');

console.log('--- القص عند الالتقاط (أداء) ---');
const cap = core.buildLiveArgs(Object.assign({}, b, {
  youtubeKey:'X1Y2-Z3W4-ABCD-5678', audioDevice:'',
  cropX:30, cropY:55, cropW:1150, cropH:624
}), '/tmp/p.txt');
t('gdigrab بـ offset_x', cap.args.includes('-offset_x') && cap.args[cap.args.indexOf('-offset_x')+1]==='30', cap.args[cap.args.indexOf('-offset_x')+1]);
t('gdigrab بـ offset_y', cap.args[cap.args.indexOf('-offset_y')+1]==='55');
t('video_size = القص', cap.args.includes('-video_size') && cap.args[cap.args.indexOf('-video_size')+1]==='1150x624', cap.args[cap.args.indexOf('-video_size')+1]);
const capfc = cap.args[cap.args.indexOf('-filter_complex')+1];
t('لا crop مزدوج في الفلاتر', !capfc.includes('crop=1150:624:30:55'), capfc.slice(0,140));
t('scale للتوحيد موجود', capfc.includes('scale=1150:624'));

console.log('--- وضع النافذة لا يستخدم القص عند الالتقاط ---');
const wcap = core.buildLiveArgs(Object.assign({}, b, {
  captureMode:'window', windowTitle:'Notepad', youtubeKey:'X1Y2-Z3W4-ABCD-5678', audioDevice:''
}), '/tmp/p.txt');
t('لا offset_x في وضع النافذة', !wcap.args.includes('-offset_x'));

console.log('\n======== '+pass+' نجح · '+fail+' فشل ========');
process.exit(fail?1:0);

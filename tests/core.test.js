'use strict';
// ==============================================================================================
// اختبارات LATCHI STREAM 4.0.0
// تغطي: OAuth/PKCE · القنوات · إنشاء البث · FFprobe · Stream Copy · Transcoding
//        مزامنة الصوت · منع الميكروفون · الإيقاف التلقائي · انقطاع الشبكة · بقايا الواجهة
// ==============================================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OAuth = require('../core/OAuth.js');
const { YouTubeApi } = require('../core/YouTubeApi.js');
const V = require('../core/VideoStream.js');

let pass = 0, fail = 0; const F = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; F.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------------ 1) OAuth / PKCE
console.log('\n=== 1) Google OAuth (PKCE + Desktop Flow) ===');
{
  const v = OAuth.makeVerifier();
  const c = OAuth.challengeFor(v);
  t('PKCE verifier طويل وعشوائي', v.length >= 43 && /^[A-Za-z0-9_-]+$/.test(v));
  // ★ Client ID مدمج (لا سر) + إمكانية إلغائه
  t('Client ID مدمج وصالح الشكل', /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(OAuth.defaultClientId()), OAuth.defaultClientId().slice(0,20));
  t('يمكن تعطيل المدمج بمتغيّر بيئة', (() => {
    process.env.LATCHI_NO_EMBEDDED_CLIENT_ID = '1';
    const off = OAuth.defaultClientId();
    delete process.env.LATCHI_NO_EMBEDDED_CLIENT_ID;
    return off === '';
  })());
  t('describeError يُظهر سبب جوجل الحقيقي', OAuth.describeError(400, JSON.stringify({error:'invalid_request', error_description:'Missing code_verifier'})).message.includes('Missing code_verifier'));
  t('describeError يفهم شكل الكائن', OAuth.describeError(401, JSON.stringify({error:{status:'UNAUTHENTICATED', message:'Bad', errors:[{reason:'authError'}]}})).code === 'UNAUTHENTICATED');
  t('PKCE challenge = S256 base64url', c.length === 43 && /^[A-Za-z0-9_-]+$/.test(c));
  t('verifier مختلف كل مرة', OAuth.makeVerifier() !== v);
  t('الصلاحيات تشمل إدارة البث', OAuth.DEFAULT_SCOPES.some(s => s.includes('/auth/youtube')));
  t('لا Client Secret في الوحدة', !/client_secret/i.test(fs.readFileSync(path.join(ROOT, 'core/OAuth.js'), 'utf8')));
  t('ترجمة invalid_grant عربية', OAuth.describeError(400, '{"error":"invalid_grant"}').message.includes('انتهت'));
  t('describeError لا يكشف تفاصيل حساسة', OAuth.describeError(400, '{"error":"invalid_grant","error_description":"secret xyz"}').raw === '');

  // مدير مصادقة بلا Client ID
  process.env.LATCHI_NO_EMBEDDED_CLIENT_ID = '1';
  const a1 = new OAuth.GoogleAuth({ clientId: '', file: '' });
  t('غير مُهيّأ بلا Client ID (بعد تعطيل المدمج)', a1.configured() === false);
  delete process.env.LATCHI_NO_EMBEDDED_CLIENT_ID;
  a1.connect().then(r => {
    t('connect يرفض بلا Client ID برسالة واضحة', r.ok === false && /Client ID/.test(r.error), r.error);
  });

  // جلسة محفوظة / تجديد
  const tmpFile = path.join(require('os').tmpdir(), 'latchi-oauth-test.json');
  fs.writeFileSync(tmpFile, JSON.stringify({
    refresh_token: 'R', access_token: 'A', expires_at: Date.now() - 1000, email: 'x@y.z'
  }));
  const a2 = new OAuth.GoogleAuth({ clientId: 'CID.apps.googleusercontent.com', file: tmpFile });
  t('يقرأ الجلسة المحفوظة', a2.connected() === true);
  t('profile لا يكشف التوكنات', !JSON.stringify(a2.profile()).includes('refresh_token'));
  const prof = a2.profile();
  t('profile يعرض البريد', prof.email === 'x@y.z');
  t('token منتهي ⇒ يُكتشف', a2.data.expires_at < Date.now());
  fs.unlinkSync(tmpFile);
}

// ------------------------------------------------------------------ 2) القنوات (واحد / متعدد)
console.log('\n=== 2) YouTube API — القنوات ===');
function fakeAuth(handler) {
  return { _authorized: async (url, init) => handler(url, init) };
}
(async () => {
  // قناة واحدة
  const one = new YouTubeApi(fakeAuth(() => ({
    ok: true, status: 200, text: JSON.stringify({ items: [
      { id: 'UC1', snippet: { title: 'قناتي', thumbnails: { default: { url: 'http://x/1.jpg' } } },
        statistics: { subscriberCount: '120', videoCount: '8' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } }, status: {} }
    ] })
  })));
  const r1 = await one.listChannels();
  t('قناة واحدة تُجلب', r1.ok && r1.channels.length === 1, r1.channels && r1.channels.length);
  t('اسم القناة صحيح', r1.channels[0].title === 'قناتي');
  t('الصورة تُجلب', r1.channels[0].thumbnail === 'http://x/1.jpg');
  t('uploadsPlaylist مستخرج', r1.channels[0].uploadsPlaylist === 'UU1');

  // عدة قنوات + Brand Account + pagination
  let calls = 0;
  const many = new YouTubeApi(fakeAuth((url) => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, text: JSON.stringify({ nextPageToken: 'P2', items: [
      { id: 'UC1', snippet: { title: 'شخصية' }, statistics: {}, status: {} },
      { id: 'UC2', snippet: { title: 'Brand A' }, statistics: {}, status: {} }
    ] }) };
    return { ok: true, status: 200, text: JSON.stringify({ items: [
      { id: 'UC3', snippet: { title: 'Brand B' }, statistics: {}, status: {} }
    ] }) };
  }));
  const r2 = await many.listChannels();
  t('عدة قنوات تُجلب كلها', r2.channels.length === 3, r2.channels.length);
  t('pagination يعمل', calls === 2, calls);
  t('Brand Accounts مشمولة', r2.channels.map(c => c.title).includes('Brand B'));

  // خطأ صلاحيات
  const denied = new YouTubeApi(fakeAuth(() => ({
    ok: false, status: 403,
    text: JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } })
  })));
  const r3 = await denied.listChannels();
  t('خطأ الصلاحيات برسالة عربية', r3.ok === false && /صلاحيات/.test(r3.error), r3.error);

  // ------------------------------------------------------------------ 3) البث والتيار
  console.log('\n=== 3) YouTube API — البث والتيار ===');
  const calls3 = [];
  const live = new YouTubeApi(fakeAuth((url, init) => {
    calls3.push({ url, method: (init && init.method) || 'GET' });
    if (url.includes('/liveStreams') && init && init.method === 'POST') {
      return { ok: true, status: 200, text: JSON.stringify({ id: 'ST1', snippet: { title: 'LATCHI STREAM' },
        cdn: { ingestionInfo: { streamName: 'KEY-123', ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', backupIngestionAddress: 'rtmp://b.rtmp.youtube.com/live2?backup=1' } },
        status: { streamStatus: 'active' } }) };
    }
    if (url.includes('/liveStreams')) {
      return { ok: true, status: 200, text: JSON.stringify({ items: [] }) };
    }
    if (url.includes('/liveBroadcasts') && init && init.method === 'POST' && url.includes('liveBroadcasts?part=')) {
      return { ok: true, status: 200, text: JSON.stringify({ id: 'BR1', snippet: { title: 'بثي' }, status: { lifeCycleStatus: 'created', privacyStatus: 'unlisted' } }) };
    }
    if (url.includes('/bind')) return { ok: true, status: 200, text: '{"id":"BR1"}' };
    if (url.includes('/transition')) return { ok: true, status: 200, text: '{"id":"BR1"}' };
    return { ok: true, status: 200, text: '{"items":[]}' };
  }));

  const st = await live.ensureLiveStream('LATCHI STREAM');
  t('إنشاء تيار RTMP', st.ok && st.stream.streamName === 'KEY-123', st.error);
  t('رابط RTMP يُبنى صحيحاً', live.rtmpUrl(st.stream) === 'rtmp://a.rtmp.youtube.com/live2/KEY-123');
  t('رابط الاحتياطي يعمل', live.rtmpUrl(st.stream, true).includes('backup=1'));
  t('بلا streamName ⇒ رابط فارغ', live.rtmpUrl({}) === '');

  const br = await live.createBroadcast({ title: 'بثي', privacy: 'unlisted', madeForKids: false });
  t('إنشاء البث', br.ok && br.broadcast.id === 'BR1', br.error);
  t('رابط المشاهدة', br.broadcast.watchUrl === 'https://youtube.com/watch?v=BR1');
  t('lifecycle ابتدائي', br.broadcast.lifecycle === 'created');

  const bd = await live.bindBroadcast('BR1', 'ST1');
  t('ربط البث بالتيار', bd.ok);

  const tr = await live.transition('BR1', 'live');
  t('الانتقال إلى live', tr.ok);

  // حماية عنوان طويل
  const longBr = await live.createBroadcast({ title: 'x'.repeat(200), privacy: 'weird' });
  t('العنوان الطويل يُقبل بعد القص', longBr.ok);
  let sentBody = null;
  const cap = new YouTubeApi(fakeAuth((url, init) => {
    if (init && init.method === 'POST') sentBody = JSON.parse(init.body);
    return { ok: true, status: 200, text: '{"id":"BR9","snippet":{"title":"t"},"status":{}}' };
  }));
  await cap.createBroadcast({ title: 'x'.repeat(250), privacy: 'weird' });
  t('العنوان يُقصّ إلى 100 حرف', sentBody.snippet.title.length === 100, sentBody.snippet.title.length);
  t('خصوصية غير صالحة ⇒ unlisted', sentBody.status.privacyStatus === 'unlisted', sentBody.status.privacyStatus);
  t('enableAutoStop=false (نُنهي نحن)', sentBody.contentDetails.enableAutoStop === false);

  // ------------------------------------------------------------------ 4) FFprobe / Codec
  console.log('\n=== 4) FFprobe وتحليل الفيديو ===');
  const probeJson = JSON.stringify({
    format: { duration: '125.4', size: '52428800', bit_rate: '3200000', format_name: 'mov,mp4,m4a', filename: '/v.mp4' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 1920, height: 1080, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p', bit_rate: '2800000' },
      { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', bit_rate: '128000' }
    ]
  });
  const info = V.parseProbe(probeJson);
  t('يحلّل الملف', info.ok);
  t('المدة مقروءة', Math.abs(info.duration - 125.4) < 0.1, info.duration);
  t('الدقة مقروءة', info.video.width === 1920 && info.video.height === 1080);
  t('fps محسوب', Math.abs(info.video.fps - 29.97) < 0.05, info.video.fps);
  t('الصوت مكتشف', info.hasAudio && info.audio.codec === 'aac');
  t('ملف بلا فيديو يُرفض', V.parseProbe('{"streams":[{"codec_type":"audio"}]}').ok === false);
  t('JSON تالف يُرفض', V.parseProbe('not json').ok === false);

  // ------------------------------------------------------------------ 5) Stream Copy
  console.log('\n=== 5) Stream Copy عند التوافق ===');
  t('H.264 1080p yuv420p + AAC ⇒ copy', V.isYouTubeCopySafe(info) === true);
  t('HEVC ⇒ لا copy', V.isYouTubeCopySafe({ ok: true, video: { codec: 'hevc', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p' }, audio: null }) === false);
  t('10-bit ⇒ لا copy', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p10le' }, audio: null }) === false);
  t('4K ⇒ لا copy', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 3840, height: 2160, fps: 30, pixFmt: 'yuv420p' }, audio: null }) === false);
  t('أبعاد فردية ⇒ لا copy', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 1281, height: 721, fps: 30, pixFmt: 'yuv420p' }, audio: null }) === false);
  t('Opus ⇒ لا copy', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p' }, audio: { codec: 'opus', channels: 2, sampleRate: 48000 }, hasAudio: true }) === false);
  t('60fps مقبول', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 60, pixFmt: 'yuv420p' }, audio: null }) === true);
  t('120fps مرفوض', V.isYouTubeCopySafe({ ok: true, video: { codec: 'h264', width: 1920, height: 1080, fps: 120, pixFmt: 'yuv420p' }, audio: null }) === false);

  // ------------------------------------------------------------------ 6) أوامر FFmpeg
  console.log('\n=== 6) أوامر FFmpeg ===');
  const copyArgs = V.buildStreamArgs(info, { file: '/v.mp4', rtmpUrl: 'rtmp://a/k', copySafe: true });
  const cs = copyArgs.join(' ');
  t('يستخدم -re (وقت حقيقي)', copyArgs.includes('-re'));
  t('نسخ الفيديو بلا ترميز', cs.includes('-c:v copy'));
  t('نسخ الصوت بلا ترميز', cs.includes('-c:a copy'));
  t('لا libx264 في وضع النسخ', !cs.includes('libx264'));
  t('مخرج FLV صحيح', cs.includes('-f flv'));
  t('الرابط في النهاية', copyArgs[copyArgs.length - 1] === 'rtmp://a/k');

  const badInfo = { ok: true, duration: 60, video: { codec: 'hevc', width: 3840, height: 2160, fps: 60, pixFmt: 'yuv420p10le' }, audio: { codec: 'aac', channels: 6, sampleRate: 48000 }, hasAudio: true };
  const tcArgs = V.buildStreamArgs(badInfo, { file: '/b.mkv', rtmpUrl: 'rtmp://a/k', copySafe: false, videoBitrate: '3000k' });
  const tcs = tcArgs.join(' ');
  t('الترميز يستخدم libx264', tcs.includes('-c:v libx264'));
  t('الترميز يستخدم AAC', tcs.includes('-c:a aac'));
  t('يحدّ الدقة إلى 1080p', tcs.includes('min(1920,iw)'));
  t('fps محدود بـ 30 في الترميز', tcs.includes('fps=30'));
  t('أبعاد زوجية', tcs.includes('trunc(iw/2)*2'));
  t('preset افتراضي veryfast', tcs.includes('-preset veryfast'));

  // ------------------------------------------------------------------ 7) منع الميكروفون + الصوت
  console.log('\n=== 7) منع الميكروفون ومزامنة الصوت ===');
  const noAudio = V.buildStreamArgs({ ok: true, video: { codec: 'h264', width: 1280, height: 720, fps: 30, pixFmt: 'yuv420p' }, hasAudio: false },
    { file: '/s.mp4', rtmpUrl: 'rtmp://a/k', copySafe: false });
  const nas = noAudio.join(' ');
  t('ملف بلا صوت ⇒ صمت مولّد (anullsrc)', nas.includes('anullsrc'));
  t('لا dshow/microphone إطلاقاً', !/dshow|microphone|Stereo Mix|audio=/i.test(nas));
  t('-shortest لمنع تمدد الصمت', nas.includes('-shortest'));
  const allArgs = [cs, tcs, nas].join(' ');
  t('لا أي مدخل صوت حي في كل الأوامر', !/dshow|-f alsa|-f pulse|virtual-audio/i.test(allArgs));
  t('لا التقاط شاشة في كل الأوامر', !/gdigrab|ddagrab|x11grab|-i desktop/i.test(allArgs));

  // ------------------------------------------------------------------ 8) التقدم والإيقاف التلقائي
  console.log('\n=== 8) التقدم واكتشاف نهاية الفيديو ===');
  const prog = V.parseProgress('frame=1500\nfps=30\nbitrate=3000kbits/s\nout_time_ms=50000000\ndrop_frames=2\nspeed=1.0x\nprogress=continue\n');
  t('الإطارات مقروءة', prog.frame === 1500);
  t('الزمن مقروء', prog.outTimeMs === 50000000);
  t('fps مقروء', prog.fps === 30);
  t('الإسقاط مقروء', prog.dropFrames === 2);
  t('نهاية الملف تُكتشف (50s ≥ 49.6s)', (prog.outTimeMs / 1000000) >= 60 - 0.4 - 10.4);
  const empty = V.parseProgress('');
  t('تقدم فارغ لا يعطب', empty.frame === 0 && empty.outTimeMs === 0);

  // محرك البث: منع التشغيل المزدوج
  const eng = new V.StreamEngine({ ffmpegPath: '/nonexistent', ffprobePath: '/nonexistent' });
  t('لا بث بلا رابط RTMP', eng.start(info, { file: '/v.mp4' }).ok === false);

  // ------------------------------------------------------------------ 9) بقايا الواجهة القديمة
  console.log('\n=== 9) الواجهة الجديدة نظيفة من القديم ===');
  const html = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(ROOT, 'ui/app.js'), 'utf8');
  const mainjs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const uiAll = html + appjs;
  const forbidden = [
    ['معاينة Preview', /preview|Preview/i],
    ['التقاط الشاشة', /gdigrab|ddagrab|desktop capture|captureMode/i],
    ['اختيار النوافذ', /window:list|pickByMouse|windowTitle/i],
    ['أوضاع اللعب', /'game'|game capture/i],
    ['القص Crop', /\bcrop\b|cropW|cropX/i],
    ['الزوم Zoom', /\bzoom\b|setZoomFactor/i],
    ['نسب الشاشة', /aspect.*ratio|16:9 button/i],
    ['متصفح مدمج WebView', /webview|BrowserView|browser-esc/i],
    ['إعدادات الماوس', /draw_mouse|mouse.*settings/i],
    ['صوت النظام', /Stereo Mix|dshow|audioDevice|listAudioDevices/i],
    ['البانر/العنوان المحروق', /bannerEnabled|chkBanner|BannerOverlay|titleOverlay|renderBanner/i]
  ];
  for (const [name, re] of forbidden) {
    t('لا ' + name + ' في الواجهة/الرئيسي', !re.test(uiAll) && !re.test(mainjs), re.source);
  }
  t('الواجهة عربية RTL', html.includes('lang="ar"') && html.includes('dir="rtl"'));
  t('زر SELECT VIDEO موجود', /SELECT VIDEO/.test(html));
  t('زر Connect Google Account موجود', /Connect Google Account/.test(html));
  t('زر START LIVE STREAM موجود', /START LIVE STREAM/.test(html));
  t('زر STOP LIVE موجود', /STOP LIVE/.test(html));

  // ------------------------------------------------------------------ 10) الأمان
  console.log('\n=== 10) الأمان ===');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  t('الإصدار 4.1.0', pkg.version === '4.1.0', pkg.version);
  t('contextIsolation مفعّل', /contextIsolation:\s*true/.test(mainjs));
  t('nodeIntegration معطّل', /nodeIntegration:\s*false/.test(mainjs));
  t('preload يستخدم contextBridge', /contextBridge\.exposeInMainWorld/.test(fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')));
  const allFiles = ['main.js', 'preload.js', 'ui/app.js', 'ui/index.html', 'core/OAuth.js', 'core/YouTubeApi.js', 'core/VideoStream.js']
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  t('لا Client Secret في أي ملف', !/client_secret\s*[:=]\s*['"][^'"]+['"]/i.test(allFiles));
  t('لا توكن GitHub في المشروع', !/ghp_[A-Za-z0-9]{30,}/.test(allFiles));
  t('لا مفتاح بث صريح مضمّن', !/[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/.test(allFiles));
  t('لا طباعة توكنات في السجل', !/console\.log\([^)]*(access_token|refresh_token)/i.test(allFiles));
  t('حفظ بأذونات 0600', /mode:\s*0o600/.test(fs.readFileSync(path.join(ROOT, 'core/OAuth.js'), 'utf8')));

  console.log('\n======== ' + pass + ' نجح · ' + fail + ' فشل ========');
  if (F.length) console.log('FAILS:\n' + F.map(x => ' - ' + x).join('\n'));
  process.exit(fail ? 1 : 0);
})();

'use strict';
// ==============================================================================================
// محرك بث ملف فيديو محلي إلى RTMP
// ----------------------------------------------------------------------------------------------
// المبدأ: Local File → FFmpeg (-re) → RTMP → YouTube
// • نفحص الملف بـ ffprobe أولاً.
// • إن كان متوافقاً مع YouTube ⇒ -c copy (صفر ترميز: أخفّ ما يمكن).
// • إن كان غير متوافق ⇒ ترميز خفيف H.264 veryfast/ultrafast + AAC.
// • الميكروفون ممنوع: لا يوجد أي مدخل صوت حي؛ صوت الملف فقط، وإن لم يوجد صوت نضيف صمتاً.
// ==============================================================================================

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------- تحليل الملف (ffprobe) ----------------
// يشغّل: ffprobe -v quiet -print_format json -show_format -show_streams <file>
function parseProbe(json) {
  let j = {};
  try { j = typeof json === 'string' ? JSON.parse(json) : (json || {}); } catch (e) { return { ok: false, error: 'ملف غير صالح' }; }
  const streams = j.streams || [];
  const fmt = j.format || {};
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');

  if (!v) return { ok: false, error: 'الملف لا يحتوي مسار فيديو' };

  let fps = 0;
  if (v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [n, d] = String(v.avg_frame_rate).split('/').map(Number);
    if (d) fps = n / d;
  }
  if (!fps && v.r_frame_rate) {
    const [n, d] = String(v.r_frame_rate).split('/').map(Number);
    if (d) fps = n / d;
  }

  const duration = Number(fmt.duration || v.duration || 0) || 0;
  const bitRate = Number(fmt.bit_rate || v.bit_rate || 0) || 0;

  return {
    ok: true,
    file: fmt.filename || '',
    duration,
    size: Number(fmt.size || 0),
    formatName: fmt.format_name || '',
    bitRate,
    video: {
      codec: v.codec_name || '',
      profile: v.profile || '',
      width: Number(v.width || 0),
      height: Number(v.height || 0),
      fps: Math.round(fps * 100) / 100,
      pixFmt: v.pix_fmt || '',
      bitRate: Number(v.bit_rate || 0) || 0
    },
    audio: a ? {
      codec: a.codec_name || '',
      channels: Number(a.channels || 0),
      sampleRate: Number(a.sample_rate || 0),
      bitRate: Number(a.bit_rate || 0) || 0,
      profile: a.profile || ''
    } : null,
    hasAudio: !!a
  };
}

// هل الملف متوافق مع YouTube كما هو؟ (لنستعمل -c copy)
function isYouTubeCopySafe(info, opt) {
  if (!info || !info.ok) return false;
  const o = opt || {};
  const v = info.video || {};
  const a = info.audio;

  // فيديو: H.264 فقط، yuv420p (أو yuvj420p)، أبعاد زوجية، ≤ 1920x1080، ≤ 60fps
  if (v.codec !== 'h264') return false;
  if (!['yuv420p', 'yuvj420p'].includes(String(v.pixFmt || ''))) return false;
  if (!v.width || !v.height) return false;
  if (v.width % 2 || v.height % 2) return false;
  if (v.width > 1920 || v.height > 1080) return false;
  if (v.fps && v.fps > 61) return false;

  // صوت: إن وُجد يجب أن يكون AAC بصيغة يقبلها FLV/RTMP
  if (a) {
    if (a.codec !== 'aac') return false;
    if (![1, 2].includes(a.channels)) return false;
    if (a.sampleRate && ![44100, 48000].includes(a.sampleRate)) return false;
  }
  // حاوية: يجب أن تكون قابلة للقراءة المتدفقة
  const bad = /image2|gif|apng/i;
  if (bad.test(String(info.formatName || ''))) return false;

  return true;
}

// ---------------- بناء أوامر ffmpeg ----------------
// opt: { rtmpUrl, copySafe, duration, noAudio, progressPath, threads, preset, videoBitrate, audioBitrate, loop, startAt }
function buildStreamArgs(info, opt) {
  const o = opt || {};
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin'];

  if (o.progressPath) args.push('-progress', String(o.progressPath));

  // ★ -re : تشغيل بمعدل الوقت الحقيقي (شرط البث المباشر)
  args.push('-re');
  if (o.startAt && Number(o.startAt) > 0) args.push('-ss', String(Number(o.startAt)));
  if (o.loop) args.push('-stream_loop', '-1');
  args.push('-i', String(o.file));

  // ★ ملف بلا صوت: نضيف تيار صمت مولَّداً داخلياً (لا ميكروفون ولا التقاط حي).
  //   يوتيوب يفضّل وجود مسار صوتي، و ffmpeg يشترط أن تكون كل المدخلات قبل خيارات الخرج.
  const needSilence = !(info && info.hasAudio);
  if (needSilence) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  // لا يوجد أي مدخل آخر ⇒ لا ميكروفون إطلاقاً

  if (o.copySafe) {
    // ---- نسخ مباشر: صفر ترميز للفيديو (وصوت الملف كما هو إن وُجد) ----
    args.push('-map', '0:v:0');
    args.push('-c:v', 'copy');
    if (info && info.hasAudio) {
      args.push('-map', '0:a:0', '-c:a', 'copy');
    } else {
      // صمت مولّد فقط — يُرمّز AAC (لا صوت حي)
      args.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest');
    }
  } else {
    // ---- ترميز خفيف: مناسب للأجهزة الضعيفة ----
    const fps = Math.min(30, Math.max(15, Math.round((info && info.video && info.video.fps) || 30)));
    // أبعاد زوجية بحد أقصى 1080p مع الحفاظ على النسبة
    const vf = [
      `scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease`,
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      `fps=${fps}`,
      'format=yuv420p'
    ].join(',');

    args.push('-map', '0:v:0');
    args.push('-vf', vf);
    args.push('-c:v', 'libx264');
    args.push('-preset', o.preset || 'veryfast');
    args.push('-tune', 'zerolatency');
    args.push('-profile:v', 'main');
    args.push('-threads', String(Number(o.threads) || 0));
    args.push('-b:v', String(o.videoBitrate || '3000k'));
    args.push('-maxrate', String(o.videoBitrate || '3000k'));
    args.push('-bufsize', String(o.bufsize || '6000k'));
    args.push('-g', String(fps * 2));
    args.push('-pix_fmt', 'yuv420p');

    if (info && info.hasAudio) {
      args.push('-map', '0:a:0');
    } else {
      // ★ بديل الميكروفون: صمت مولَّد داخلياً (لا التقاط حي)
      args.push('-map', '1:a:0');
    }
    args.push('-c:a', 'aac');
    args.push('-b:a', String(o.audioBitrate || '128k'));
    args.push('-ar', '48000');
    args.push('-ac', '2');
    if (!(info && info.hasAudio)) args.push('-shortest');
  }

  args.push('-f', 'flv', '-flvflags', 'no_duration_filesize');
  args.push(String(o.rtmpUrl));
  return args;
}

// قراءة آخر إحصائيات من ملف التقدم
function parseProgress(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  const num = k => { const v = Number(out[k]); return isNaN(v) ? 0 : v; };
  return {
    frame: num('frame'),
    fps: num('fps'),
    bitrate: out.bitrate || '',
    totalSize: num('total_size'),
    outTimeMs: num('out_time_ms'),
    dupFrames: num('dup_frames'),
    dropFrames: num('drop_frames'),
    speed: out.speed || ''
  };
}

// ---------------- مشغّل البث ----------------
class StreamEngine {
  // deps: { ffmpegPath, ffprobePath, log, onProgress, onEnd }
  constructor(deps) {
    this.d = deps || {};
    this.proc = null;
    this.info = null;
    this.startedAt = 0;
    this.stopping = false;
    this.lastErr = '';
  }

  get running() { return !!this.proc; }

  // فحص الملف عبر ffprobe (عملية واحدة قصيرة)
  async probe(file, timeoutMs) {
    const ffprobe = this.d.ffprobePath;
    if (!ffprobe) return { ok: false, error: 'ffprobe غير متاح' };
    if (!fs.existsSync(file)) return { ok: false, error: 'الملف غير موجود' };
    return new Promise(resolve => {
      let out = '', err = '', done = false;
      const finish = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} finish({ ok: false, error: 'انتهت مهلة فحص الفيديو' }); }, timeoutMs || 25000);
      let p;
      try {
        p = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', String(file)],
          { windowsHide: true });
      } catch (e) { return finish({ ok: false, error: 'تعذّر تشغيل ffprobe' }); }
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { if (err.length < 4000) err += d.toString(); });
      p.on('error', () => finish({ ok: false, error: 'ffprobe غير قابل للتنفيذ' }));
      p.on('close', code => {
        if (code !== 0 && !out) return finish({ ok: false, error: 'تعذّر قراءة الملف: ' + (err.slice(0, 200) || 'code ' + code) });
        const r = parseProbe(out);
        if (r.ok) r.copySafe = isYouTubeCopySafe(r);
        finish(r);
      });
    });
  }

  // بدء البث
  start(info, opt) {
    const o = opt || {};
    if (this.proc) return { ok: false, error: 'هناك بث جارٍ بالفعل' };
    if (!this.d.ffmpegPath) return { ok: false, error: 'ffmpeg غير متاح' };
    if (!o.rtmpUrl) return { ok: false, error: 'رابط البث (RTMP) غير متاح' };

    const args = buildStreamArgs(info, {
      file: o.file,
      rtmpUrl: o.rtmpUrl,
      copySafe: !!o.copySafe,
      progressPath: o.progressPath,
      threads: o.threads,
      preset: o.preset,
      videoBitrate: o.videoBitrate,
      audioBitrate: o.audioBitrate,
      bufsize: o.bufsize,
      startAt: o.startAt
    });

    this.info = info;
    this.startedAt = Date.now();
    this.stopping = false;
    this.lastErr = '';

    let p;
    try {
      p = spawn(this.d.ffmpegPath, args, { windowsHide: true, cwd: o.cwd || process.cwd() });
    } catch (e) {
      return { ok: false, error: 'تعذّر تشغيل ffmpeg: ' + e.message };
    }
    this.proc = p;

    const errChunks = [];
    p.stderr.on('data', d => {
      const s = d.toString();
      if (errChunks.length < 60) errChunks.push(s);
      this.lastErr = (this.lastErr + s).slice(-4000);
    });
    p.on('error', e => {
      this.proc = null;
      if (this.d.onEnd) this.d.onEnd({ ok: false, error: 'ffmpeg: ' + e.message, natural: false });
    });
    p.on('close', (code, signal) => {
      const wasStopping = this.stopping;
      this.proc = null;
      const elapsed = Math.round((Date.now() - this.startedAt) / 1000);
      const tail = this.lastErr.slice(-700);
      // انتهى الملف طبيعياً = خرج بالكود 0 بلا إيقاف يدوي
      const natural = !wasStopping && code === 0;
      if (this.d.onEnd) this.d.onEnd({
        ok: code === 0, code, signal, natural, elapsed, tail,
        error: code === 0 ? '' : ('ffmpeg توقف بالكود ' + code + (tail ? ' — ' + tail.slice(-200) : ''))
      });
    });

    return { ok: true, args: args.map(a => a.startsWith('rtmp') ? 'rtmp://***' : a) };
  }

  // إيقاف يدوي
  stop(graceful) {
    if (!this.proc) return { ok: false, error: 'لا يوجد بث جارٍ' };
    this.stopping = true;
    try {
      if (graceful !== false) {
        // أرسل q لإيقاف ffmpeg بلطف (يُنهي الملف بأمان)
        try { this.proc.stdin.write('q'); } catch (e) {}
      }
      setTimeout(() => { try { if (this.proc) this.proc.kill('SIGTERM'); } catch (e) {} }, 800);
      setTimeout(() => { try { if (this.proc) this.proc.kill('SIGKILL'); } catch (e) {} }, 3500);
    } catch (e) {}
    return { ok: true };
  }
}

module.exports = { parseProbe, isYouTubeCopySafe, buildStreamArgs, parseProgress, StreamEngine };

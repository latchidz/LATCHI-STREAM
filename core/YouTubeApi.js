'use strict';
// ==============================================================================================
// YouTube Data API v3 — القنوات + البث المباشر
// ----------------------------------------------------------------------------------------------
// الإجراءات الرسمية للبث:
//   1) liveBroadcasts.insert            → إنشاء بث
//   2) liveStreams.insert               → إنشاء تيار RTMP (يُعاد استعماله من الإعدادات)
//   3) liveBroadcasts.bind              → ربط البث بالتيار
//   4) ffmpeg → RTMP ingestion
//   5) liveBroadcasts.transition(→ live) بعد رصد حالة ready
//   6) عند انتهاء الملف: transition(→ complete)
// ==============================================================================================

const API = 'https://www.googleapis.com/youtube/v3';

function qs(params) {
  const u = new URLSearchParams();
  for (const k of Object.keys(params || {})) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  }
  return u.toString();
}

function parseJson(t) {
  try { return JSON.parse(t || '{}'); } catch (e) { return {}; }
}

// ترجمة أخطاء Google إلى رسائل عربية واضحة (بلا أسرار)
function describeApiError(status, payload) {
  const err = (payload && payload.error) || {};
  const first = (err.errors && err.errors[0]) || {};
  const reason = first.reason || err.status || ('http_' + status);
  const map = {
    quotaExceeded: 'انتهت حصة YouTube API اليومية — أعد المحاولة غداً',
    insufficientPermissions: 'صلاحيات الحساب لا تكفي — اربط الحساب من جديد واسمح بإدارة البث',
    forbidden: 'العملية ممنوعة لهذا الحساب أو القناة',
    unauthorized: 'انتهت المصادقة — اعد ربط الحساب',
    liveStreamingNotEnabled: 'البث المباشر غير مُفعّل في هذه القناة (فعّله من YouTube Studio: تحقّق ثم انتظر 24 ساعة)',
    livePermissionBlocked: 'القناة محظورة من البث المباشر',
    liveBroadcastNotFound: 'لم يُعثر على البث',
    channelClosed: 'القناة مغلقة',
    rateLimitExceeded: 'طلبات كثيرة جداً — انتظر قليلاً',
    invalidTags: 'كلمات مفتاحية غير صالحة',
    invalidTitle: 'العنوان غير صالح (الحد 100 حرف)',
    invalidDescription: 'الوصف غير صالح (الحد 5000 حرف)'
  };
  return {
    message: map[reason] || (err.message || 'خطأ غير معروف من YouTube API'),
    reason, status
  };
}

class YouTubeApi {
  // auth: كائن GoogleAuth
  constructor(auth) { this.auth = auth; }

  async _json(url, init) {
    const r = await this.auth._authorized(url, init);
    const j = parseJson(r.text);
    if (!r.ok) {
      const e = describeApiError(r.status, j);
      return { ok: false, status: r.status, error: e.message, reason: e.reason, data: j };
    }
    return { ok: true, status: r.status, data: j };
  }

  // ---------------- الحساب والقنوات ----------------
  // يجلب كل القنوات التي يديرها الحساب (بما فيها Brand Accounts) عبر pagination
  async listChannels() {
    const out = [];
    let pageToken = '';
    let guard = 0;
    do {
      const url = `${API}/channels?${qs({ part: 'snippet,contentDetails,statistics,status', mine: 'true', maxResults: 50, pageToken })}`;
      const r = await this._json(url);
      if (!r.ok) return { ok: false, error: r.error, reason: r.reason, channels: out };
      for (const c of (r.data.items || [])) {
        out.push({
          id: c.id,
          title: (c.snippet && c.snippet.title) || '(بلا اسم)',
          description: (c.snippet && c.snippet.description) || '',
          thumbnail: (c.snippet && c.snippet.thumbnails && (c.snippet.thumbnails.default || c.snippet.thumbnails.medium || {}).url) || '',
          customUrl: (c.snippet && c.snippet.customUrl) || '',
          country: (c.snippet && c.snippet.country) || '',
          subscribers: (c.statistics && Number(c.statistics.subscriberCount || 0)) || 0,
          videos: (c.statistics && Number(c.statistics.videoCount || 0)) || 0,
          uploadsPlaylist: (c.contentDetails && c.contentDetails.relatedPlaylists && c.contentDetails.relatedPlaylists.uploads) || '',
          privacyStatus: (c.status && c.status.privacyStatus) || '',
          madeForKids: !!(c.status && c.status.madeForKids)
        });
      }
      pageToken = r.data.nextPageToken || '';
    } while (pageToken && ++guard < 10);
    return { ok: true, channels: out };
  }

  // التحقق من إمكانية البث المباشر لهذه القناة
  async checkLiveEligibility(channelId) {
    const url = `${API}/liveBroadcasts?${qs({ part: 'id,status', mine: 'true', maxResults: 1 })}`;
    const r = await this._json(url);
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
    return { ok: true, eligible: true };
  }

  // ---------------- التيارات (RTMP) ----------------
  // يعيد استخدام تيار موجود بنفس الاسم إن وُجد، وإلا يُنشئ واحداً
  async ensureLiveStream(title) {
    const name = String(title || 'LATCHI STREAM').slice(0, 120);
    const listUrl = `${API}/liveStreams?${qs({ part: 'id,snippet,cdn,status', mine: 'true', maxResults: 50 })}`;
    const list = await this._json(listUrl);
    if (list.ok) {
      const found = (list.data.items || []).find(s => (s.snippet && s.snippet.title) === name);
      if (found) return { ok: true, stream: this._mapStream(found), reused: true };
    }
    const body = {
      snippet: { title: name },
      cdn: {
        frameRate: 'variable',
        ingestionType: 'rtmp',
        resolution: 'variable'
      },
      contentDetails: { isReusable: true }
    };
    const r = await this._json(`${API}/liveStreams?${qs({ part: 'id,snippet,cdn,status' })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
    return { ok: true, stream: this._mapStream(r.data), reused: false };
  }

  _mapStream(s) {
    const ing = (s.cdn && s.cdn.ingestionInfo) || {};
    return {
      id: s.id,
      title: (s.snippet && s.snippet.title) || '',
      streamName: ing.streamName || '',
      ingestionAddress: ing.ingestionAddress || '',
      backupAddress: ing.backupIngestionAddress || '',
      status: (s.status && s.status.streamStatus) || 'unknown',
      health: (s.status && s.status.healthStatus && s.status.healthStatus.status) || ''
    };
  }

  // رابط RTMP الكامل: العنوان + مفتاح البث
  rtmpUrl(stream, useBackup) {
    if (!stream || !stream.streamName) return '';
    const base = (useBackup && stream.backupAddress) ? stream.backupAddress : stream.ingestionAddress;
    if (!base) return '';
    return base.replace(/\/+$/, '') + '/' + stream.streamName;
  }

  // ---------------- البث ----------------
  // ★★★ وضع مفتاح البث اليدوي — بديل كامل لـ OAuth
  // المستخدم ينسخ من YouTube Studio ← بث مباشر ← إعدادات ← «مفتاح البث»،
  // ويُدخل رابط الاستقبال (rtmp://a.rtmp.youtube.com/live2) + المفتاح.
  // لا يحتاج OAuth ولا API ولا انتظار. مفيد إن كان ربط Google معطّلاً لأي سبب.
  static buildManualRtmp(address, key) {
    const a = String(address || '').trim();
    const k = String(key || '').trim();
    if (!a || !k) return '';
    // لو المستخدم لصق الرابط كاملاً (يشمل المفتاح) نستعمله كما هو
    if (/\/[^/]+$/.test(a) && !a.endsWith('/live2') && !a.endsWith('/live2/')) {
      if (a.split('/').pop() === k) return a;
    }
    return a.replace(/\/+$/, '') + '/' + k.replace(/^\/+/, '');
  }

  // تحقّق سريع من الشكل قبل محاولة الاتصال (رسائل أوضح من فشل ffmpeg الغامض)
  static validateManualRtmp(address, key) {
    const a = String(address || '').trim();
    const k = String(key || '').trim();
    if (!a) return { ok: false, error: 'رابط الاستقبال (RTMP) مطلوب — مثال: rtmp://a.rtmp.youtube.com/live2' };
    if (!/^rtmps?:\/\//i.test(a)) return { ok: false, error: 'رابط الاستقبال يجب أن يبدأ بـ rtmp:// أو rtmps://' };
    if (!k) return { ok: false, error: 'مفتاح البث (Stream Key) مطلوب' };
    if (/\s/.test(k)) return { ok: false, error: 'مفتاح البث لا يحتوي مسافات — أعد نسخه كاملاً' };
    if (k.length < 8) return { ok: false, error: 'مفتاح البث يبدو ناقصاً (أقل من 8 أحرف)' };
    return { ok: true };
  }

  async createBroadcast(opt) {
    const o = opt || {};
    const title = String(o.title || 'LATCHI STREAM').slice(0, 100);
    const desc = String(o.description || '').slice(0, 4900);
    const privacy = ['public', 'unlisted', 'private'].includes(o.privacy) ? o.privacy : 'unlisted';

    const body = {
      snippet: {
        title,
        description: desc,
        scheduledStartTime: new Date(Date.now() + 60000).toISOString(),
        ...(o.categoryId ? { categoryId: String(o.categoryId) } : {})
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: !!o.madeForKids
      },
      contentDetails: {
        enableAutoStart: false,
        enableAutoStop: false,        // نُنهي نحن عبر API عند نهاية الملف
        enableDvr: true,
        recordFromStart: true,
        latencyPreference: 'normal',
        monitorStream: { enableMonitorStream: false }
      }
    };

    const r = await this._json(`${API}/liveBroadcasts?${qs({ part: 'id,snippet,status,contentDetails' })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };

    const b = r.data;
    return {
      ok: true,
      broadcast: {
        id: b.id,
        title: (b.snippet && b.snippet.title) || title,
        watchUrl: 'https://youtube.com/watch?v=' + b.id,
        studioUrl: 'https://studio.youtube.com/video/' + b.id + '/livestreaming',
        lifecycle: (b.status && b.status.lifeCycleStatus) || 'created',
        privacy: (b.status && b.status.privacyStatus) || privacy
      }
    };
  }

  async bindBroadcast(broadcastId, streamId) {
    const r = await this._json(
      `${API}/liveBroadcasts/bind?${qs({ id: broadcastId, streamId, part: 'id,status,contentDetails' })}`,
      { method: 'POST' }
    );
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason };
    return { ok: true };
  }

  // 200 = no-op (نفس الحالة)، ونقبلها
  async transition(broadcastId, status) {
    const r = await this._json(
      `${API}/liveBroadcasts/transition?${qs({ broadcastStatus: status, id: broadcastId, part: 'id,status' })}`,
      { method: 'POST' }
    );
    if (!r.ok) {
      if (r.status === 403 && /invalidTransition|redundant/i.test(r.error || '')) return { ok: true, note: 'already' };
      return { ok: false, error: r.error, reason: r.reason, status: r.status };
    }
    return { ok: true };
  }

  // حالة البث الحقيقية (لا نعتمد على نجاح RTMP)
  async broadcastStatus(broadcastId) {
    const r = await this._json(`${API}/liveBroadcasts?${qs({ id: broadcastId, part: 'id,status,snippet,statistics' })}`);
    if (!r.ok) return { ok: false, error: r.error };
    const b = (r.data.items || [])[0];
    if (!b) return { ok: false, error: 'لم يُعثر على البث' };
    return {
      ok: true,
      lifeCycleStatus: (b.status && b.status.lifeCycleStatus) || 'unknown',
      streamStatus: (b.status && b.status.streamStatus) || 'unknown',
      recordingStatus: (b.status && b.status.recordingStatus) || '',
      privacy: (b.status && b.status.privacyStatus) || '',
      watchUrl: 'https://youtube.com/watch?v=' + b.id,
      views: (b.statistics && b.statistics.viewCount) || '0'
    };
  }

  async streamHealth(streamId) {
    const r = await this._json(`${API}/liveStreams?${qs({ id: streamId, part: 'id,status' })}`);
    if (!r.ok) return { ok: false, error: r.error };
    const s = (r.data.items || [])[0];
    if (!s) return { ok: false, error: 'لم يُعثر على التيار' };
    const st = s.status || {};
    return {
      ok: true,
      streamStatus: st.streamStatus || 'unknown',
      health: (st.healthStatus && st.healthStatus.status) || 'unknown',
      configurationIssues: (st.healthStatus && st.healthStatus.configurationIssues) || []
    };
  }

  // رفع صورة مصغّرة (اختياري) — يقرأ الملف ويحوّله base64
  async setThumbnail(videoId, filePath) {
    const fs = require('fs');
    try {
      const data = fs.readFileSync(filePath);
      const r = await this.auth._authorized(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?${qs({ videoId })}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/*' },
        body: data
      });
      if (!r.ok) {
        const e = describeApiError(r.status, parseJson(r.text));
        return { ok: false, error: e.message, reason: e.reason };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: 'تعذّر قراءة ملف الصورة المصغّرة' }; }
  }

  // فئات الفيديو (للقائمة المنسدلة)
  async categories() {
    const url = `${API}/videoCategories?${qs({ part: 'snippet', regionCode: 'US' })}`;
    const r = await this._json(url);
    if (!r.ok) return { ok: false, categories: [] };
    const list = (r.data.items || []).map(c => ({ id: c.id, title: c.snippet && c.snippet.title }))
      .filter(c => c.title);
    return { ok: true, categories: list };
  }
}

module.exports = { YouTubeApi, describeApiError, API };

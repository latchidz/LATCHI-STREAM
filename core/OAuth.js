'use strict';
// ==============================================================================================
// Google OAuth 2.0 — Desktop Flow مع PKCE (بلا Client Secret في الحزمة)
// ----------------------------------------------------------------------------------------------
// • التصادق يتم في متصفح النظام الخارجي (لا متصفح مدمج) — حسب المذكرة.
// • PKCE: code_verifier عشوائي 64 بايت + code_challenge S256.
// • الحفظ: userData/oauth.json بصلاحيات 0600. لا يُطبع أي توكن في السجلات.
// ==============================================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL, URLSearchParams } = require('url');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

// صلاحيات يوتيوب المطلوبة (إدارة البث المباشر + قراءة القناة + رفع الصورة المصغرة)
// ★ معرّف عميل Google OAuth المدمج (Desktop app) — ليس سراً ولا يمكن استعماله وحده للدخول.
//   يمكن استبداله من الواجهة (الإعدادات) أو بالمتغيّر LATCHI_GOOGLE_CLIENT_ID.
//   إن رغبت بإزالة الدمج لأي سبب: LATCHI_NO_EMBEDDED_CLIENT_ID=1
const EMBEDDED_CLIENT_ID = '949640728249-tbb0is4a3d441817nee7eeuuhe24ebbn.apps.googleusercontent.com';

function defaultClientId() {
  if (process.env.LATCHI_NO_EMBEDDED_CLIENT_ID === '1') return '';
  return String(process.env.LATCHI_GOOGLE_CLIENT_ID || EMBEDDED_CLIENT_ID || '').trim();
}

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// ---- PKCE ----
function makeVerifier() {
  return crypto.randomBytes(64).toString('base64url').slice(0, 96);
}
function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ---- تحليل استجابة الخطأ من Google (بلا أسرار) ----
function describeError(status, body) {
  let j = {};
  try { j = JSON.parse(body || '{}'); } catch (e) {}

  // ★ بعض أخطاء Google تأتي كسلسلة نصية (error = "invalid_request")،
  //   وبعضها ككائن: { error: { code, message, errors:[{reason,message}] } }
  //   كان الكود القديم يقرأ الحالة الأولى فقط فيقول «طلب غير صالح» بلا سبب ⇒ يُخفي المشكل الحقيقي.
  let code = '', desc = '', reason = '';
  if (typeof j.error === 'string') {
    code = j.error;
    desc = String(j.error_description || '');
  } else if (j.error && typeof j.error === 'object') {
    code = String(j.error.status || j.error.code || '');
    desc = String(j.error.message || '');
    const first = (j.error.errors && j.error.errors[0]) || {};
    reason = String(first.reason || '');
    if (!desc && first.message) desc = String(first.message);
  }
  if (!code) code = status ? ('http_' + status) : 'unknown_error';

  const map = {
    invalid_grant: 'انتهت صلاحية التصريح أو أُلغي — أعد ربط الحساب',
    invalid_client: 'معرّف العميل (Client ID) غير مقبول — تأكد أنه من نوع Desktop app',
    redirect_uri_mismatch: 'عنوان الإرجاع غير مطابق لإعدادات OAuth في Google Cloud',
    access_denied: 'رُفض الوصول من حساب Google',
    invalid_request: 'طلب غير صالح — السبب من Google: ' + (desc || reason || 'غير محدّد'),
    unauthorized_client: 'هذا التطبيق غير مسموح له بهذا النوع من التصادق',
    unsupported_grant_type: 'نوع المنح غير مدعوم',
    invalid_scope: 'صلاحية غير صالحة: ' + (desc || ''),
    admin_policy_enforced: 'سياسة مؤسستك تمنع هذا التطبيق — استعمل حساباً شخصياً'
  };

  return {
    code,
    message: map[code] || (desc || reason || code),
    detail: desc || reason || '',   // تفاصيل جوجل (نص فقط — لا تحوي أي سر)
    raw: ''
  };
}

// ---- مدير المصادقة ----
class GoogleAuth {
  constructor(opts) {
    const o = opts || {};
    this.clientId = String(o.clientId || defaultClientId() || '').trim();
    this.scopes = Array.isArray(o.scopes) && o.scopes.length ? o.scopes : DEFAULT_SCOPES;
    this.file = o.file;                        // مسار oauth.json
    this.openExternal = o.openExternal || (() => {});
    this.log = o.log || (() => {});
    this.data = null;                          // { access_token, refresh_token, expires_at, email, scope }
    this.pending = null;
    this._load();
  }

  // ---------------- التخزين ----------------
  _load() {
    try {
      if (!this.file || !fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && (raw.refresh_token || raw.access_token)) this.data = raw;
    } catch (e) { this.data = null; }
  }
  _save() {
    try {
      if (!this.file) return;
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data || {}), { mode: 0o600 });
      try { fs.chmodSync(this.file, 0o600); } catch (e) {}
    } catch (e) {}
  }

  configured() { return !!this.clientId; }
  connected() { return !!(this.data && (this.data.refresh_token || this.data.access_token)); }
  hasScope(scope) { return !!(this.data && String(this.data.scope || '').includes(scope)); }
  // معلومات غير حساسة للواجهة
  profile() {
    if (!this.connected()) return { connected: false };
    return {
      connected: true,
      email: this.data.email || '',
      name: this.data.name || '',
      picture: this.data.picture || '',
      hasRefresh: !!this.data.refresh_token,
      expiresAt: this.data.expires_at || 0,
      scope: this.data.scope || ''
    };
  }

  async disconnect() {
    const t = this.data && (this.data.refresh_token || this.data.access_token);
    if (t) {
      try {
        await fetch(REVOKE_ENDPOINT + '?token=' + encodeURIComponent(t), { method: 'POST' });
      } catch (e) {}
    }
    this.data = null;
    try { if (this.file && fs.existsSync(this.file)) fs.unlinkSync(this.file); } catch (e) {}
    this._save();
    return { ok: true };
  }

  // ---------------- تدفق التصادق ----------------
  // يفتح متصفح النظام على شاشة اختيار حساب Google، وينتظر رمز الإرجاع على منفذ محلي.
  async connect(timeoutMs) {
    if (!this.clientId) {
      return { ok: false, error: 'لم يُضبط Google OAuth Client ID بعد. افتح الإعدادات وألصق المعرّف.' };
    }
    if (this.pending) return { ok: false, error: 'عملية تصادق جارية بالفعل' };

    const verifier = makeVerifier();
    const challenge = challengeFor(verifier);

    // 1) نافذة استقبال محلية على منفذ عشوائي (loopback — مناسب لتطبيق Desktop)
    const server = http.createServer();
    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(0, '127.0.0.1', res);
    });
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}`;

    const authUrl = AUTH_ENDPOINT + '?' + new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',       // للحصول على refresh_token
      prompt: 'consent select_account',
      include_granted_scopes: 'true'
    }).toString();

    this.pending = { verifier, redirectUri, server };

    const codePromise = new Promise((resolve) => {
      const done = (v) => { try { server.close(); } catch (e) {} resolve(v); };
      const timer = setTimeout(() => done({ error: 'انتهت مهلة الانتظار (5 دقائق) — أعد المحاولة' }), timeoutMs || 300000);

      server.on('request', (req, res) => {
        try {
          const u = new URL(req.url, redirectUri);
          // ★ Google قد تُرجع الرمز بترميز مختلف أو بمسافات/علامات زائدة — نُطبّعه قبل التبديل
          let code = u.searchParams.get('code');
          if (code) code = decodeURIComponent(code).replace(/\s+/g, '');
          const err = u.searchParams.get('error');
          if (err) log('Google أعاد خطأ: ' + err);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          if (code || err) {
            res.end(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
              <title>LATCHI STREAM</title><style>body{background:#0f1520;color:#e8eefc;font-family:Segoe UI,Tahoma;
              display:grid;place-items:center;height:100vh;margin:0;text-align:center}h1{font-size:20px}
              p{color:#8ba0c4;font-size:14px;line-height:2}</style></head><body><div>
              <h1>${code ? '✓ تم ربط الحساب' : '✗ لم يكتمل الربط'}</h1>
              <p>${code ? 'يمكنك إغلاق هذه النافذة والعودة إلى LATCHI STREAM.' : 'رُفض الوصول أو أُلغي. أعد المحاولة من التطبيق.'}</p>
              </div></body></html>`);
            clearTimeout(timer);
            done(code ? { code } : { error: 'رُفض التصريح من Google' });
          } else {
            res.end('waiting');
          }
        } catch (e) {
          try { res.writeHead(500); res.end(); } catch (e2) {}
        }
      });
    });

    // 2) افتح متصفح النظام
    this.openExternal(authUrl);
    this.log('فُتح متصفح النظام لاختيار حساب Google…');

    const got = await codePromise;
    this.pending = null;
    if (got.error) return { ok: false, error: got.error };

    // 3) استبدل الرمز بتوكنات
    const ex = await this._exchangeCode(got.code, verifier, redirectUri);
    if (!ex.ok) return ex;

    // 4) اجلب بريد/اسم/صورة الحساب للعرض فقط
    await this._fetchProfile();
    this._save();
    return { ok: true, profile: this.profile() };
  }

  async _exchangeCode(code, verifier, redirectUri) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    });
    try {
      const r = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const text = await r.text();
      if (!r.ok) {
        const e = describeError(r.status, text);
        this.log('تبديل الرمز فشل: ' + e.code + (e.detail ? ' — ' + e.detail : '') + ' (HTTP ' + r.status + ')');
        return { ok: false, error: e.message, code: e.code, detail: e.detail };
      }
      const j = JSON.parse(text);
      this.data = Object.assign({}, this.data || {}, {
        access_token: j.access_token,
        refresh_token: j.refresh_token || (this.data && this.data.refresh_token) || '',
        expires_at: Date.now() + (Number(j.expires_in || 3600) * 1000) - 60000,
        scope: j.scope || ''
      });
      this._save();
      return { ok: true };
    } catch (e) {
      // خطأ شبكة حقيقي (DNS/بروكسي/جدار) — نُظهره بدل رسالة عامة
      const msg = 'تعذّر الاتصال بخادم Google: ' + ((e && (e.cause && e.cause.code)) || (e && e.code) || (e && e.message) || 'network');
      this.log(msg);
      return { ok: false, error: msg, code: 'network' };
    }
  }

  async _fetchProfile() {
    try {
      const r = await this._authorized('https://www.googleapis.com/oauth2/v2/userinfo');
      if (!r.ok) return;
      const j = JSON.parse(r.text);
      this.data.email = j.email || this.data.email || '';
      this.data.name = j.name || this.data.name || '';
      this.data.picture = j.picture || this.data.picture || '';
    } catch (e) {}
  }

  // تجديد آمن للتوكن
  async _refresh() {
    if (!this.data || !this.data.refresh_token) return false;
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: this.data.refresh_token,
      grant_type: 'refresh_token'
    });
    try {
      const r = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const text = await r.text();
      if (!r.ok) {
        const e = describeError(r.status, text);
        if (e.code === 'invalid_grant') { this.data = null; this._save(); }
        return false;
      }
      const j = JSON.parse(text);
      this.data.access_token = j.access_token;
      this.data.expires_at = Date.now() + (Number(j.expires_in || 3600) * 1000) - 60000;
      if (j.scope) this.data.scope = j.scope;
      this._save();
      return true;
    } catch (e) { return false; }
  }

  // طلب مُصادق عليه يعيد { ok, status, text }
  async _authorized(url, init) {
    if (!this.connected()) return { ok: false, status: 401, text: '{"error":"not_connected"}' };
    if (!this.data.access_token || (this.data.expires_at && Date.now() > this.data.expires_at)) {
      const ok = await this._refresh();
      if (!ok) return { ok: false, status: 401, text: '{"error":"auth_expired"}' };
    }
    const doFetch = async (tok) => {
      const opts = Object.assign({}, init || {});
      opts.headers = Object.assign({}, (init && init.headers) || {}, { Authorization: 'Bearer ' + tok });
      const r = await fetch(url, opts);
      return { ok: r.ok, status: r.status, text: await r.text() };
    };
    let out = await doFetch(this.data.access_token);
    if (out.status === 401) {
      const ok = await this._refresh();
      if (ok) out = await doFetch(this.data.access_token);
    }
    return out;
  }
}

module.exports = { GoogleAuth, makeVerifier, challengeFor, describeError, defaultClientId, EMBEDDED_CLIENT_ID, DEFAULT_SCOPES, AUTH_ENDPOINT, TOKEN_ENDPOINT };

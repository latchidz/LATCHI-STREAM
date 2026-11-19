# LATCHI STREAM v4.0.0 — بث فيديوهات محلية إلى YouTube

**تحوّل كامل:** من التقاط الشاشة إلى **بث ملف فيديو محلي** على قناتك في YouTube،
باستخدام **Google OAuth** و**FFmpeg** و**RTMP**. بلا معاينة، بلا التقاط شاشة، **بلا ميكروفون**.

```
Local Video File  →  FFmpeg (-re)  →  RTMP  →  YouTube Live
```

---

## الميزات

### 1) تسجيل دخول Google (OAuth 2.0 + PKCE)
- زر **Connect Google Account** يفتح **متصفح النظام** (لا متصفح مدمج).
- تدفق Desktop مع PKCE (S256) واستقبال محلي على `127.0.0.1` بمنفذ عشوائي.
- **لا Client Secret في الحزمة** ولا في الكود — يُطلب **Client ID** فقط.
- الجلسة تُحفظ في `%APPDATA%\latchi-stream\oauth.json` بأذونات `0600`.
- تجديد تلقائي للتوكن عند الانتهاء، وقطع ربط نهائي (revoke) عند الطلب.
- **لا يُطبع أي توكن في السجلات** إطلاقاً.

### 2) إدارة القنوات
- يجلب **كل** القنوات التي يديرها الحساب عبر `channels?mine=true` مع pagination.
- يدعم **Brand Accounts** والقنوات المتعددة فعلياً.
- قناة واحدة ⇒ اختيار تلقائي · عدة قنوات ⇒ قائمة اختيار + زر **Change Channel**.

### 3) بث فيديو محلي
- زر **SELECT VIDEO** يفتح نافذة ويندوز الأصلية لاختيار الملف.
- الصيغ المدعومة: MP4 · MKV · MOV · AVI · FLV · WEBM · TS · M4V · MPG · WMV (كل ما يقرأه FFmpeg).
- يعرض: الاسم · المدة · الدقة · الحجم · FPS · الكودك · الصوت — **بلا تشغيل أو معاينة**.

### 4) محرك البث (الأداء أولاً)
- **فحص بـ ffprobe** قبل أي ترميز.
- إن كان الملف متوافقاً (H.264 + AAC + yuv420p + ≤1080p + ≤60fps) ⇒ **`-c copy` بلا ترميز إطلاقاً**.
- إن لم يكن ⇒ ترميز خفيف `libx264 -preset veryfast -tune zerolatency` + AAC، بحد 1080p و30fps.
- `-re` لتشغيل الملف بمعدل الوقت الحقيقي، ومزامنة صوت/صورة تلقائية.
- **ميكروفون ممنوع**: لا يوجد أي مدخل صوت حي. ملف بلا صوت ⇒ **صمت مولَّد داخلياً** (`anullsrc`).

### 5) الإيقاف التلقائي
- يكتشف **نهاية الفيديو الفعلية** من `-progress` (لا مؤقت ثابت).
- يُنهي ffmpeg بلطف ثم ينادي `liveBroadcasts.transition → complete` ⇒ **لا بث عالق**.
- زر **STOP LIVE** للإيقاف اليدوي، وإغلاق التطبيق أثناء البث يُنهي البث على يوتيوب.

### 6) إعدادات البث
العنوان · الوصف · الصورة المصغّرة (≤2MB) · الفئة · Made for Kids · الخصوصية (عام/غير مدرج/خاص).

---

## الإعداد المطلوب مرة واحدة (OAuth)

التطبيق لا يحتوي بيانات اعتماد. تحتاج **Client ID** واحداً:

1. `console.cloud.google.com` ← مشروع جديد.
2. مكتبة الـ APIs ← فعّل **YouTube Data API v3**.
3. شاشة الموافقة (OAuth consent screen) ← External ← أضف حسابك كـ **Test user**.
4. بيانات الاعتماد ← **OAuth client ID** ← النوع: **Desktop app**.
5. انسخ **Client ID** والصقه في التطبيق ← **الإعدادات** ← حفظ.

> ⚠️ لا تضع Client Secret — التطبيق لا يطلبه ولا يقبله.
> ⚠️ لتشغيل البث المباشر يجب أن تكون القناة **مُفعّلة للبث** (تحقّق في YouTube Studio، وقد يستغرق حتى 24 ساعة).

---

## التطوير

```bash
npm install
npm start
npm test          # 98 اختباراً
```

## البناء

عبر GitHub Actions: **Actions → Build LATCHI STREAM → Run workflow**.

المخرجات: `LATCHI-STREAM-4.0.0-Setup.exe` و`LATCHI-STREAM-4.0.0-Portable.exe`.

---

## البنية

```
main.js                 العملية الرئيسية (IPC · ffmpeg · دورة حياة البث)
preload.js              جسور contextBridge
core/OAuth.js           OAuth 2.0 + PKCE · تخزين آمن · تجديد
core/YouTubeApi.js      القنوات · liveStreams · liveBroadcasts · transition
core/VideoStream.js     ffprobe · قرار copy/transcode · بناء أوامر ffmpeg · StreamEngine
ui/index.html           الواجهة (عربية RTL، داكنة)
ui/app.js               ربط الأزرار بالوظائف الحقيقية
tests/core.test.js      98 اختباراً
```

## الأمان
`contextIsolation: true` · `nodeIntegration: false` · `sandbox` · preload + contextBridge ·
لا أسرار في الحزمة · لا تسجيل توكنات · فتح الروابط الخارجية في متصفح النظام فقط.

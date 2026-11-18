# الاختبارات

```bash
# 1) اختبار النواة (سريع، بلا واجهة)
node tests/core.test.js

# 2) اختبار الواجهة الكامل — يحتاج شاشة + ffmpeg + خادم RTMP محلي
node tests/ui.test.js
```

على لينكس/CI استخدم:

```bash
LATCHI_RTMP_BASE="rtmp://127.0.0.1:1935/live" \
LATCHI_TEST_INPUT=testsrc \
xvfb-run -a electron --no-sandbox tests/ui.test.js
```

- `LATCHI_TEST_INPUT=testsrc` يستبدل `gdigrab`/`dshow` بمصدر صناعي (لا يوجد gdigrab إلا على ويندوز).
- `LATCHI_RTMP_BASE` يوجّه البث إلى خادم RTMP محلي بدل يوتيوب.
- كلاهما **خطافات اختبار فقط** ولا يعملان في النسخة الموزّعة (لا متغيرات بيئة عند المستخدم).

## النتائج الحالية

| المجموعة | النتيجة |
|---|---|
| `core.test.js` | **66 / 66** |
| `ui.test.js` (Electron حقيقي + Xvfb + خادم RTMP) | **60 / 60** |

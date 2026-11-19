@echo off
chcp 65001 >nul
title LATCHI STREAM - تنظيف النسخة القديمة
echo.
echo  ============================================
echo    LATCHI STREAM - تنظيف النسخة القديمة
echo  ============================================
echo.
echo  سيُغلق أي نسخة قديمة ويحذفها من الجهاز.
echo  ملف ربط حساب Google (oauth.json) يُحفظ احتياطياً.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0CleanOldLatchi.ps1" %*
if errorlevel 1 (
  echo.
  echo  [i] إن فشل شيء: انقر بالزر الأيمن على هذا الملف واختر
  echo      "Run as administrator"  ثم أعد المحاولة.
  echo.
  pause
)

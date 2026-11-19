#Requires -Version 5.1
<#
  LATCHI STREAM — تنظيف شامل للنسخة القديمة (3.x) قبل استعمال النسخة المحمولة الجديدة (4.0.0)
  ------------------------------------------------------------------------------------------
  ما يفعله:
   1) يُغلق أي نسخة قديمة تعمل (LATCHI STREAM.exe) — وهي سبب «فتحت الجديدة فظهرت القديمة»
   2) يوقف ويحذف أيام الخدمة/المهام المجدولة إن وُجدت
   3) يحذف مثبّتات NSIS القديمة (Uninstall LATCHI STREAM)
   4) يحذف مجلدات البرنامج في LOCALAPPDATA / PROGRAMFILES / APPDATA
   5) يحذف بيانات الإصدار 3.x (settings.json · cache · bin · ffmpeg المنسوخ) مع الإبقاء على oauth.json
   6) ينظّف اختصارات سطح المكتب وقائمة ابدأ و Tray القديمة
   7) يمسح سجل بدء التشغيل التلقائي (Run key) و مهام Update
   8) يُظهر تقريراً نهائياً بما تم حذفه وما تبقّى

  الاستعمال:
   - انقر عليه بالزر الأيمن ← "Run with PowerShell"
   - أو من PowerShell:  powershell -ExecutionPolicy Bypass -File "تنظيف-وإزالة-النسخة-القديمة.ps1"
   - لإضافة -WhatIf لمعاينة ما سيُحذف بلا حذف:  ... -File "..." -WhatIf
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$KeepOAuth,          # احتفظ بـ oauth.json (افتراضي: نعم نحتفظ دائماً)
  [switch]$Force               # بلا أسئلة تأكيد
)

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Head($t) { Write-Host ''; Write-Host ('═' * 66) -ForegroundColor DarkCyan; Write-Host "  $t" -ForegroundColor Cyan; Write-Host ('═' * 66) -ForegroundColor DarkCyan }

$removed = New-Object System.Collections.Generic.List[string]
$kept    = New-Object System.Collections.Generic.List[string]
$failed  = New-Object System.Collections.Generic.List[string]

function TryRemove($path, $label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ($PSCmdlet.ShouldProcess($path, 'حذف')) {
    try {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      $removed.Add($label + '  →  ' + $path)
      Say ("  ✓ حُذف: $path") 'Green'
    } catch {
      $failed.Add($label + '  →  ' + $path + '  (' + $_.Exception.Message + ')')
      Say ("  ✗ تعذّر: $path") 'Yellow'
    }
  } else {
    Say ("  (معاينة) سيُحذف: $path") 'DarkGray'
  }
}

Head 'LATCHI STREAM — تنظيف النسخة القديمة'

if (-not $Force) {
  Say 'سيتم إغلاق أي نسخة قديمة وحذف مثبّتاتها وبياناتها من هذا الجهاز.' 'Yellow'
  Say 'ملاحظة: ملف oauth.json (ربط حساب Google) سيُحفظ إن وُجد.' 'DarkGray'
  $ans = Read-Host 'هل تريد المتابعة؟ اكتب  Y  للموافقة'
  if ($ans -notmatch '^(y|yes|نعم|o|oui)$') { Say 'أُلغيت العملية.' 'Red'; return }
}

# ---------------------------------------------------------------- 1) إغلاق العمليات
Head '1) إغلاق النسخ التي تعمل'
$names = @('LATCHI STREAM', 'latchi-stream', 'latchi stream', 'LATCHI-STREAM')
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  ($names -contains $_.ProcessName) -or
  ($_.Path -and ($_.Path -match 'latchi.?stream|LATCHI STREAM')) -or
  ($_.Description -and $_.Description -match 'LATCHI')
}
if (-not $procs) {
  Say '  لا توجد نسخة تعمل.' 'DarkGray'
} else {
  foreach ($p in ($procs | Sort-Object Id -Unique)) {
    $pp = $p.Path
    if ($PSCmdlet.ShouldProcess("$($p.ProcessName) ($($p.Id))", 'إغلاق')) {
      try {
        # إغلاق لطيف أولاً كي يُنهي البث على YouTube
        $null = $p.CloseMainWindow()
        Start-Sleep -Milliseconds 900
        if (-not $p.HasExited) { $p | Stop-Process -Force -ErrorAction Stop }
        $removed.Add('عملية: ' + $p.ProcessName + ' (' + $p.Id + ')  ' + $pp)
        Say ("  ✓ أُغلقت: $($p.ProcessName) (PID $($p.Id))") 'Green'
      } catch {
        $failed.Add('عملية: ' + $p.ProcessName + ' — ' + $_.Exception.Message)
        Say ("  ! لم أستطع إغلاق PID $($p.Id) — جرّب تشغيل السكربت كمسؤول") 'Yellow'
      }
    }
  }
  Start-Sleep -Milliseconds 600
  # 🔑 سبب المشكل: نسخة في الخلفية (Tray) تمسك قفل النسخة الواحدة
  $still = Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.Path -and $_.Path -match 'latchi.?stream') -or ($names -contains $_.ProcessName) }
  if ($still) {
    Say '  ⚠ ما زالت نسخة تعمل — تشغيل السكربت كمسؤول (Run as administrator) ضروري.' 'Red'
    foreach ($s in $still) { Say ("     • PID $($s.Id) · $($s.Path)") 'DarkGray' }
  }
}

# ---------------------------------------------------------------- 2) مثبّتات NSIS
Head '2) إزالة المثبّتات (NSIS)'
$uninstallRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
$foundInstaller = $false
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    $dn = [string]$props.DisplayName
    if ($dn -match 'LATCHI\s*STREAM') {
      $foundInstaller = $true
      $un = [string]$props.UninstallString
      Say ("  وُجد مثبّت: $dn  ←  $un") 'Cyan'
      if ($un -and $PSCmdlet.ShouldProcess($dn, 'إلغاء التثبيت')) {
        try {
          if ($un -match '^"([^"]+)"(.*)$') { $exe = $matches[1]; $argl = $matches[2].Trim() }
          elseif ($un -match '^(\S+\.exe)(.*)$') { $exe = $matches[1]; $argl = $matches[2].Trim() }
          else { $exe = $un; $argl = '' }
          if ($argl -notmatch '\/S') { $unArgs = ($argl + ' /S').Trim() } else { $unArgs = $argl }
          if (Test-Path -LiteralPath $exe) {
            Start-Process -FilePath $exe -ArgumentList $unArgs -Wait -ErrorAction Stop
            Say '  ✓ اكتمل إلغاء التثبيت (صامت)' 'Green'
            $removed.Add('مثبّت NSIS: ' + $dn + '  (' + $exe + ')')
          } else {
            Say "  ! ملف الإزالة غير موجود: $exe — سأحذف المجلد يدوياً" 'Yellow'
          }
        } catch {
          $failed.Add('إلغاء تثبيت: ' + $dn + ' — ' + $_.Exception.Message)
          Say ("  ! فشل إلغاء التثبيت: " + $_.Exception.Message) 'Yellow'
        }
      }
      # تنظيف مفتاح السجل
      if ($PSCmdlet.ShouldProcess($_.PSPath, 'حذف مفتاح السجل')) {
        Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        Say '  ✓ حُذف مفتاح السجل' 'Green'
      }
    }
  }
}
if (-not $foundInstaller) { Say '  لا يوجد مثبّت مسجّل (النسخة القديمة كانت محمولة).' 'DarkGray' }

# ---------------------------------------------------------------- 3) مجلدات البرنامج
Head '3) حذف مجلدات البرنامج'
$dirs = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\latchi-stream'),
  (Join-Path $env:LOCALAPPDATA 'Programs\LATCHI STREAM'),
  (Join-Path $env:LOCALAPPDATA 'latchi-stream'),
  (Join-Path $env:LOCALAPPDATA 'LATCHI STREAM'),
  (Join-Path $env:PROGRAMFILES 'LATCHI STREAM'),
  (Join-Path ${env:ProgramFiles(x86)} 'LATCHI STREAM'),
  (Join-Path $env:APPDATA 'LATCHI STREAM'),
  'C:\LATCHI', 'C:\LATCHI-STREAM', 'D:\LATCHI', 'D:\LATCHI-STREAM', 'D:\LATCHI_BROWSER'
)
foreach ($d in $dirs) {
  if ($d -and (Test-Path -LiteralPath $d)) {
    # لا نحذف مجلد النسخة المحمولة الجديدة تلقائياً إن كان يحوي 4.0.0
    $isV4 = $false
    Get-ChildItem -LiteralPath $d -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -match '4\.0\.0') { $isV4 = $true }
    }
    if ($isV4) { $kept.Add('مجلد النسخة الجديدة: ' + $d); Say ("  ⏭ تجاهلت (يحوي 4.0.0): $d") 'DarkGray'; continue }
    TryRemove $d 'مجلد برنامج'
  }
}

# ---------------------------------------------------------------- 4) بيانات الإصدار 3.x
Head '4) بيانات التطبيق (الإصدار 3.x)'
$dataDirs = @(
  (Join-Path $env:APPDATA 'latchi-stream'),
  (Join-Path $env:APPDATA 'LATCHI STREAM'),
  (Join-Path $env:LOCALAPPDATA 'latchi-stream'),
  (Join-Path $env:LOCALAPPDATA 'LATCHI STREAM')
)
foreach ($d in ($dataDirs | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  # احتفظ بربط الحساب (oauth.json / oauth-client.json) إن طُلب
  $oauthFiles = @()
  Get-ChildItem -LiteralPath $d -Filter 'oauth*.json' -ErrorAction SilentlyContinue | ForEach-Object {
    $oauthFiles += $_
  }
  if ($oauthFiles.Count -gt 0) {
    $backup = Join-Path $env:APPDATA 'LATCHI-STREAM-OAUTH-BACKUP'
    if (-not (Test-Path $backup)) { New-Item -ItemType Directory -Path $backup -Force | Out-Null }
    foreach ($f in $oauthFiles) {
      Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $backup $f.Name) -Force -ErrorAction SilentlyContinue
      $kept.Add('نسخة احتياطية من oauth: ' + (Join-Path $backup $f.Name))
      Say ("  ⏭ حُفظ احتياطياً: $($f.Name) → $backup") 'DarkGray'
    }
  }
  TryRemove $d 'بيانات التطبيق'
}

# ---------------------------------------------------------------- 5) مجلدات Temp
Head '5) ملفات مؤقتة'
$tmpDirs = @(
  (Join-Path $env:TEMP 'latchi-stream'),
  (Join-Path $env:TEMP 'LATCHI STREAM'),
  (Join-Path $env:LOCALAPPDATA 'Temp\latchi-stream')
)
foreach ($d in ($tmpDirs | Select-Object -Unique)) { TryRemove $d 'مؤقتات' }

# ---------------------------------------------------------------- 6) الاختصارات
Head '6) الاختصارات'
$lnkDirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
)
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in ($lnkDirs | Select-Object -Unique)) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -notmatch 'LATCHI') { return }
    try {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      # لا نحذف اختصار النسخة المحمولة الجديدة
      if ($t -and $t -match 'LATCHI.?STREAM' -and $t -notmatch 'LATCHI.?BROWSER') {
        if ($t -notmatch '4\.0\.0' -and (Test-Path -LiteralPath $t) -eq $false) {
          TryRemove $_.FullName 'اختصار ميت'
        } elseif ($_.Name -match 'LATCHI') {
          # اختصار يشير إلى مسار غير موجود أو نسخة قديمة
          if (-not (Test-Path -LiteralPath $t)) { TryRemove $_.FullName 'اختصار ميت' }
        }
      }
    } catch {}
  }
}
try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($sh) } catch {}

# ---------------------------------------------------------------- 7) بدء التشغيل التلقائي والمهام
Head '7) بدء التشغيل التلقائي والمهام المجدولة'
$runKeys = @(
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce'
)
foreach ($k in $runKeys) {
  if (-not (Test-Path $k)) { continue }
  $item = Get-ItemProperty $k -ErrorAction SilentlyContinue
  if (-not $item) { continue }
  $item.PSObject.Properties | Where-Object { $_.Value -is [string] -and $_.Value -match 'latchi.?stream' } | ForEach-Object {
    if ($PSCmdlet.ShouldProcess($k + ' → ' + $_.Name, 'حذف قيمة بدء التشغيل')) {
      Remove-ItemProperty -Path $k -Name $_.Name -Force -ErrorAction SilentlyContinue
      $removed.Add('بدء تشغيل تلقائي: ' + $_.Name)
      Say ("  ✓ حُذف من بدء التشغيل: $($_.Name)") 'Green'
    }
  }
}
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'LATCHI' } | ForEach-Object {
  if ($PSCmdlet.ShouldProcess($_.TaskName, 'حذف مهمة مجدولة')) {
    Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    $removed.Add('مهمة مجدولة: ' + $_.TaskName)
    Say ("  ✓ حُذفت المهمة: $($_.TaskName)") 'Green'
  }
}

# ---------------------------------------------------------------- 8) البحث عن بقايا exe
Head '8) بحث سريع عن بقايا LATCHI STREAM.exe'
$searchRoots = @("$env:LOCALAPPDATA", "$env:APPDATA", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop", 'C:\', 'D:\') |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
$hits = @()
foreach ($r in $searchRoots) {
  try {
    $hits += Get-ChildItem -LiteralPath $r -Filter 'LATCHI STREAM.exe' -Recurse -ErrorAction SilentlyContinue -Depth 4 |
      Where-Object { $_.FullName -notmatch 'LATCHI.?BROWSER' }
  } catch {}
  if ($hits.Count -ge 12) { break }
}
if ($hits.Count -eq 0) {
  Say '  لا بقايا تنفيذية.' 'DarkGray'
} else {
  foreach ($h in $hits) {
    $ver = ''
    try { $ver = (Get-Item $h.FullName).VersionInfo.FileVersion } catch {}
    Say ("  • $($h.FullName)  [الإصدار: $ver]") 'DarkGray'
    if ($ver -and $ver -notmatch '^4\.') {
      TryRemove (Split-Path $h.FullName -Parent) 'مجلد نسخة قديمة'
    }
  }
}

# ---------------------------------------------------------------- التقرير
Head 'التقرير النهائي'
if ($removed.Count) { Say 'حُذف:' 'Green'; $removed | ForEach-Object { Say ('   • ' + $_) 'Gray' } } else { Say 'لم يُحذف شيء.' 'DarkGray' }
if ($kept.Count)    { Say 'أُبقي:' 'Cyan';  $kept    | ForEach-Object { Say ('   • ' + $_) 'Gray' } }
if ($failed.Count)  { Say 'فشل (شغّل كمسؤول):' 'Yellow'; $failed | ForEach-Object { Say ('   • ' + $_) 'Yellow' } }

Write-Host ''
Say '✔ انتهى. الآن شغّل النسخة المحمولة الجديدة (LATCHI-STREAM-4.0.0-Portable.exe).' 'Green'
Say '   إن ظهرت القديمة مرة أخرى: أعد تشغيل الجهاز ثم شغّل السكربت مرة ثانية.' 'DarkGray'
Write-Host ''
Say 'للمتابعة اضغط Enter…' 'DarkGray'
try { $null = Read-Host } catch {}

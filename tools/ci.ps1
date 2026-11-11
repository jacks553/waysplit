# Waysplit: проверка и сборка выпуска. Его запускает GitHub Actions при новом теге версии
# (.github/workflows/release.yml), а можно и у себя:
#   powershell -ExecutionPolicy Bypass -File tools\ci.ps1 -Tag v1.0.0
#
#  1. тег vX.Y.Z = версия расширения (extension/manifest.json) = версия компаньона (host/main.go);
#  2. тесты утилит (tools);
#  3. ядра sing-box и Xray в dist\cores (tools\cores.ps1, версии и SHA-256 — tools\cores.json):
#     уже лежащие с верной SHA-256 не трогаются, подходящие берутся из host\bin — у себя
#     интернет не нужен; остального — скачать официальный выпуск и сверить SHA-256;
#  4. архивы: dist\Waysplit-companion.zip (ядра внутри), dist\Waysplit-extension.zip (расширение
#     для ручной установки, с полем key) — оба с .sha256 — и store\waysplit-<версия>.zip (для
#     магазина, без key; в выпуск не идёт);
#  5. установщик из собранного архива — как у пользователя, но во временную папку вместо
#     %LOCALAPPDATA% (ваши настоящие данные не трогаются): испорченный архив он не ставит,
#     нормальный ставит (без интернета: ничего не скачивает), при обновлении убирает файлы
#     прежних версий; удаление — тоже проверяется;
#  6. компаньон для тестов (host\bin\waysplit-host.exe, ядра — из dist\cores) и его регистрация в Chrome;
#  7. тесты компаньона (с ядрами — и сквозные), расширения (npm test), проверка в Chrome
#     (tools/chrome-check.js; -SkipChrome — без неё) — на распакованном Waysplit-extension.zip:
#     проверяется именно то, что люди ставят вручную;
#  8. -Sources: архивы исходного кода ядер этих версий в dist\sources (их прикладываем к выпуску:
#     GPL-3.0 у sing-box, MPL-2.0 у Xray);
#  9. текст выпуска dist\release-notes.md: раздел версии из CHANGELOG.md, как установить (разделы
#     README.md «Как установить», «Ручная установка (запасной вариант)» и «Переход с ручной версии
#     на версию из магазина»), SHA-256 архивов, ядра и где их исходный код.
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [switch]$SkipChrome,
  [switch]$Sources
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'cores.ps1')

# В GitHub Actions: журнал — в UTF-8 (иначе русские буквы в нём — вопросительные знаки), а вывод
# программ запоминается: если шаг не пройдёт, Fail покажет строки с ошибками заметкой у запуска
# (::error::) — сам журнал запуска без входа на GitHub не посмотреть.
$inActions = $env:GITHUB_ACTIONS -eq 'true'
if ($inActions) { try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch { } }
$script:seen = New-Object System.Collections.Generic.List[string]

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ''
  Write-Host "ОШИБКА: $text" -ForegroundColor Red
  if ($inActions) {
    $lines = @($script:seen)
    $bad = @($lines | Where-Object { $_ -match '^(ОШИБКА|--- FAIL|FAIL|not ok|panic:)|_test\.go:\d+:' } | Select-Object -First 25)
    $last = @($lines | Select-Object -Last 15)
    $msg = (@("$text") + $bad + @('--- конец вывода:') + $last) -join "`n"
    # В заметке перевод строки — %0A, сам знак % — %25.
    Write-Host ('::error title=tools/ci.ps1::' + (($msg -replace '%', '%25') -replace "`r", '' -replace "`n", '%0A'))
  }
  exit 1
}

# Exec — программа (go, npm, node, cmd); не ноль на выходе — ошибка. Вывод в stderr ошибкой не
# считается (go и git пишут туда обычные сообщения), смотрим только код возврата.
function Exec([string]$what, [scriptblock]$cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $script:seen.Clear()
  try {
    if ($inActions) { & $cmd | ForEach-Object { Write-Host $_; $script:seen.Add("$_") } }
    else { & $cmd }
  } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Fail "$what — код $LASTEXITCODE" }
  $script:seen.Clear()
}

function Find($name, $fallback) {
  $p = (Get-Command $name -ErrorAction SilentlyContinue).Source
  if (-not $p -and $fallback -and (Test-Path $fallback)) { $p = $fallback }
  if (-not $p) { Fail "не найден $name" }
  return $p
}
$go = Find 'go' (Join-Path $env:LOCALAPPDATA 'Programs\go\bin\go.exe')
$node = Find 'node' $null
$npm = Find 'npm.cmd' $null
$bin = Join-Path $root 'host\bin'
$cores = Join-Path $root 'dist\cores'

# --- 1. Версии ---
Step "Версии ($Tag)"
if ($Tag -notmatch '^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$') { Fail "тег $Tag — нужен вид v1.2.3 (или v1.2.3-rc1)" }
$version = $Matches[1]
$manifest = Get-Content (Join-Path $root 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$hostVersion = [regex]::Match((Get-Content (Join-Path $root 'host\main.go') -Raw -Encoding UTF8), '(?m)^const version = "([^"]+)"').Groups[1].Value
Write-Host "тег $version, расширение $($manifest.version), компаньон $hostVersion"
if ($manifest.version -ne $version -or $hostVersion -ne $version) {
  Fail 'версии не совпадают: поднимите version в extension/manifest.json и host/main.go до версии тега'
}

# --- 2. Тесты утилит ---
Step 'Тесты утилит (tools)'
Push-Location (Join-Path $root 'tools')
try {
  Exec 'go vet (tools)' { & $go vet ./... }
  Exec 'go test (tools)' { & $go test ./... }
} finally { Pop-Location }

# --- 3. Ядра ---
Step 'Ядра sing-box и Xray (dist\cores)'
try { Install-Cores -Dest $cores -Reuse $bin } catch { Fail $_.Exception.Message }

# --- 4. Архивы ---
Step 'Архивы для выпуска и магазина'
Push-Location (Join-Path $root 'tools')
try {
  Exec 'архив компаньона' { & $go run ./release companion -cores $cores }
  Exec 'расширение для ручной установки' { & $go run ./release extension }
  Exec 'архив для магазина' { & $go run ./release store }
} finally { Pop-Location }
$zip = Join-Path $root 'dist\Waysplit-companion.zip'
$extZip = Join-Path $root 'dist\Waysplit-extension.zip'
$storeZip = Join-Path $root "store\waysplit-$version.zip"
foreach ($f in $zip, "$zip.sha256", $extZip, "$extZip.sha256", $storeZip) { if (-not (Test-Path $f)) { Fail "нет $f" } }

# --- 5. Установщик из архива, как у пользователя (во временной папке) ---
Step 'Установка и удаление компаньона из собранного архива'
$tmp = Join-Path ([IO.Path]::GetTempPath()) "waysplit-ci-$PID"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
$x = Join-Path $tmp 'Загрузки\Waysplit-companion'
Expand-Archive $zip -DestinationPath $x
$realLocal = $env:LOCALAPPDATA
$env:LOCALAPPDATA = Join-Path $tmp 'LocalAppData'
try {
  $app = Join-Path $env:LOCALAPPDATA 'Programs\Waysplit'
  $data = Join-Path $env:LOCALAPPDATA 'Waysplit'

  # Испорченный архив: файл ядра повреждён — установщик отказывается и ничего не ставит.
  $broken = Join-Path $tmp 'Загрузки\испорченный'
  Copy-Item $x $broken -Recurse
  $fs = [IO.File]::Open((Join-Path $broken 'xray.exe'), 'Open', 'ReadWrite')
  try { $fs.Position = 4096; $b = $fs.ReadByte(); $fs.Position = 4096; $fs.WriteByte(($b + 1) % 256) } finally { $fs.Close() }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = cmd.exe /c (Join-Path $broken 'Установить.cmd') -NoPause
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  # Вывод через канал — в кодировке консоли (на английской Windows русские буквы теряются),
  # поэтому ищем только имя файла: оно бывает в выводе, лишь когда файл назван испорченным.
  if ($code -ne 1 -or -not (($out -join "`n") -match 'xray\.exe')) { Fail "испорченный архив: код $code, ждали 1 и xray.exe в списке испорченных`n$($out -join "`n")" }
  if (Test-Path $app) { Fail 'испорченный архив: папка программы всё-таки создана' }
  Write-Host 'испорченный архив — отказ, ничего не установлено'

  # Обновление поверх прежней версии: её лишние файлы убираются.
  New-Item -ItemType Directory -Force $app | Out-Null
  foreach ($f in 'cores.txt', 'libcronet.dll') { Set-Content (Join-Path $app $f) 'old' }
  Exec 'Установить.cmd' { cmd.exe /c (Join-Path $x 'Установить.cmd') -NoPause }
  $sums = Get-Content (Join-Path $x 'SHA256SUMS.txt') -Encoding UTF8
  foreach ($f in 'waysplit-host.exe', 'sing-box.exe', 'xray.exe', 'CORES.txt', 'sing-box-LICENSE.txt', 'sing-box-GPL-3.0.txt', 'xray-LICENSE.txt', 'SHA256SUMS.txt', 'Удалить.cmd') {
    $p = Join-Path $app $f
    if (-not (Test-Path $p)) { Fail "после установки нет $f" }
    $name = (Get-Item -LiteralPath $p).Name
    if ($name -cne $f) { Fail "после установки $f называется $name" } # прежний cores.txt и новый CORES.txt — одно имя для Windows
    if ($f -ne 'SHA256SUMS.txt' -and -not ($sums -contains "$(Get-FileSha256 $p)  $f")) { Fail "после установки $f не совпадает с SHA256SUMS.txt" }
  }
  # Прежний cores.txt для Windows — то же имя, что CORES.txt: его уборку проверяют имя и SHA-256 выше.
  if (Test-Path (Join-Path $app 'libcronet.dll')) { Fail 'после обновления остался libcronet.dll' }
  # Компаньон из архива пускает обе версии расширения: ручную (ID по полю key) и из магазина.
  $origins = (Get-Content (Join-Path $data 'com.waysplit.host.json') -Raw -Encoding UTF8 | ConvertFrom-Json).allowed_origins
  $devId = [regex]::Match((Get-Content (Join-Path $root 'host\extid.go') -Raw), 'extensionID = "([a-p]{32})"').Groups[1].Value
  $storeId = [regex]::Match((Get-Content (Join-Path $root 'host\storeid.go') -Raw), 'storeExtensionID = "([a-p]{32})"').Groups[1].Value
  foreach ($id in $devId, $storeId) {
    if (-not $id -or $origins -notcontains "chrome-extension://$id/") { Fail "компаньон из архива не пускает расширение с ID «$id» (разрешены: $($origins -join ', '))" }
  }
  Write-Host "компаньон пускает ручную версию ($devId) и версию из магазина ($storeId)"

  Set-Content (Join-Path $data 'device-id') 'ci-device-id-0000' # чтобы удаление задало свой вопрос
  Exec 'Удалить.cmd' { cmd.exe /c (Join-Path $app 'Удалить.cmd') -NoPause -DeviceId delete }
  if ((Test-Path $app) -or (Test-Path $data)) { Fail 'после удаления остались папки программы или данных' }
  if (Test-Path 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.waysplit.host') { Fail 'после удаления осталась регистрация в Chrome' }
  Write-Host 'установка (без интернета), обновление и удаление — без ошибок'
} finally {
  $env:LOCALAPPDATA = $realLocal
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# --- 6. Компаньон для тестов ---
Step 'Компаньон для тестов (host\bin) и регистрация в Chrome'
try { Install-Cores -Dest $bin -Reuse $cores } catch { Fail "$($_.Exception.Message). Если ядро сейчас работает (его запустил Chrome) — закройте Chrome." }
Push-Location (Join-Path $root 'host')
try {
  Exec 'go build (host)' { & $go build -o bin\waysplit-host.exe . }
  Exec 'waysplit-host install' { & .\bin\waysplit-host.exe install }
} finally { Pop-Location }

# --- 7. Тесты ---
Step 'Тесты компаньона (host)'
Push-Location (Join-Path $root 'host')
try {
  Exec 'go vet (host)' { & $go vet ./... }
  Exec 'go test (host)' { & $go test ./... }
} finally { Pop-Location }

Step 'Тесты расширения (npm test)'
Push-Location $root
try { Exec 'npm test' { & $npm test } } finally { Pop-Location }

if ($SkipChrome) {
  Step 'Проверка в Chrome — пропущена (-SkipChrome)'
} else {
  Step 'Проверка в Chrome (tools/chrome-check.js) — на распакованном Waysplit-extension.zip'
  $chrome = if ($env:CHROME) { $env:CHROME } else { 'C:\Program Files\Google\Chrome\Application\chrome.exe' }
  if (-not (Test-Path $chrome)) { Fail "нет Chrome ($chrome): укажите путь в переменной CHROME или запустите с -SkipChrome" }
  # Как у человека: архив распакован в свою папку, её и загружает Chrome.
  $extTmp = Join-Path ([IO.Path]::GetTempPath()) "waysplit-ci-ext-$PID"
  if (Test-Path $extTmp) { Remove-Item $extTmp -Recurse -Force }
  $extDir = Join-Path $extTmp 'Waysplit-extension'
  Expand-Archive $extZip -DestinationPath $extDir
  $env:WAYSPLIT_EXTENSION = $extDir
  Push-Location $root
  try { Exec 'chrome-check' { & $node tools\chrome-check.js } } finally {
    Pop-Location
    Remove-Item Env:\WAYSPLIT_EXTENSION -ErrorAction SilentlyContinue
    Remove-Item $extTmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 8. Исходный код ядер ---
$saved = @{}
if ($Sources) {
  Step 'Исходный код ядер (dist\sources)'
  $dir = Join-Path $root 'dist\sources'
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  try { foreach ($s in Save-CoreSources -Dest $dir) { $saved[$s.Name] = $s.Sha256 } } catch { Fail $_.Exception.Message }
}

# --- 9. Текст выпуска ---
Step 'Текст выпуска'
# section — раздел файла от заголовка «## …», подходящего под образец, до следующего «## ».
function Section([string]$file, [string]$pattern, [switch]$WithHeading) {
  $lines = @()
  $inside = $false
  foreach ($line in (Get-Content (Join-Path $root $file) -Encoding UTF8)) {
    if ($line -match '^## ') {
      if ($inside) { break }
      $inside = $line -match $pattern
      if ($inside -and -not $WithHeading) { continue }
    }
    if ($inside) { $lines += $line }
  }
  return ($lines -join "`n").Trim()
}
$section = Section 'CHANGELOG.md' ('^## ' + [regex]::Escape($version) + '\b')
if (-not $section) { Fail "в CHANGELOG.md нет раздела «## $version»" }
# Как установить — разделы README (один и тот же текст и там, и в описании выпуска): магазин и
# компаньон, ручная установка как запасной вариант, переход с ручной версии на версию из магазина.
$parts = @()
foreach ($h in @('Как установить', 'Ручная установка (запасной вариант)', 'Переход с ручной версии на версию из магазина')) {
  $text = Section 'README.md' ('^## ' + [regex]::Escape($h) + '\s*$') -WithHeading
  if (-not $text) { Fail "в README.md нет раздела «## $h» — он нужен для описания выпуска" }
  if ($text -match '\]\((?!https?://)') { Fail "в разделе README «$h» есть ссылка не с https:// — в описании выпуска она не сработает" }
  $parts += $text
}
$install = $parts -join "`n`n"
$sha = (Get-Content "$zip.sha256" -Raw).Trim().Split(' ')[0]
$extSha = (Get-Content "$extZip.sha256" -Raw).Trim().Split(' ')[0]
$coreLines = @()
foreach ($c in Get-WaysplitCores) {
  $line = "- $($c.name) $($c.version) ($($c.license)) — исходный код: $($c.sourceTree)"
  if ($saved.ContainsKey($c.sourceName)) { $line += "; архив приложен к выпуску: ``$($c.sourceName)``, SHA-256 ``$($saved[$c.sourceName])``" }
  $coreLines += $line
}
$notes = @(
  $section,
  '',
  $install,
  '',
  '## Контрольные суммы SHA-256',
  '',
  "- ``Waysplit-companion.zip`` — ``$sha``",
  "- ``Waysplit-extension.zip`` — ``$extSha``",
  '',
  '## Ядра в архиве компаньона',
  '',
  'Из официальных выпусков авторов, без изменений (SHA-256 сверены при сборке; подробно — CORES.txt в архиве):',
  ''
) + $coreLines
$notes = $notes -join "`n"
[IO.File]::WriteAllText((Join-Path $root 'dist\release-notes.md'), $notes + "`n", (New-Object Text.UTF8Encoding $false))
Write-Host $notes

Write-Host ''
Write-Host "Готово: $version — тесты пройдены, архивы и текст выпуска в dist\ и store\." -ForegroundColor Green

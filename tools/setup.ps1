# Waysplit: подготовка на новом компьютере для разработки — ядра, сборка компаньона, регистрация в Chrome.
#
# Запуск из папки проекта (права администратора не нужны):
#   powershell -ExecutionPolicy Bypass -File tools\setup.ps1
#
# Что делает:
#   1. находит Go (нужен только для сборки компаньона: если Go нет, а компаньон уже собран — берёт готовый);
#   2. кладёт в host\bin ядра sing-box и Xray тех же версий, что получают пользователи
#      (tools\cores.json): уже лежащие с верной SHA-256 не трогает, остальное скачивает с GitHub
#      из официальных выпусков и сверяет SHA-256 архива и каждого файла (tools\cores.ps1);
#   3. собирает компаньон host\bin\waysplit-host.exe (если есть Go);
#   4. регистрирует его в Chrome (waysplit-host.exe install).
# Запускать можно сколько угодно раз: уже скачанное не скачивается заново.
# -NoInstall — всё, кроме шага 4.
#
# Файл в UTF-8 с BOM: иначе Windows PowerShell 5.1 прочитает русские буквы неправильно.

param([switch]$NoInstall)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'host\bin'
$hostExe = Join-Path $bin 'waysplit-host.exe'
. (Join-Path $PSScriptRoot 'cores.ps1')

function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host ''; Write-Host "ОШИБКА: $text" -ForegroundColor Red; exit 1 }

# --- 1. Go ---
Step 'Go'
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) {
  # Только что установили — в этом окне PATH ещё старый; смотрим обычные места установки.
  foreach ($p in "$env:ProgramFiles\Go\bin\go.exe", "$env:LOCALAPPDATA\Programs\go\bin\go.exe") {
    if (Test-Path $p) { $go = $p; break }
  }
}
if ($go) {
  & $go version
} elseif (Test-Path $hostExe) {
  Write-Host 'Go не найден, но компаньон уже собран (host\bin\waysplit-host.exe) — беру готовый.'
} else {
  Fail 'Go не найден. Установите его командой  winget install -e --id GoLang.Go  и запустите этот скрипт снова.'
}

# --- 2. Ядра ---
Step 'Ядра sing-box и Xray (версии и SHA-256 — tools\cores.json)'
try {
  Install-Cores -Dest $bin
} catch {
  Fail "$($_.Exception.Message). Если ядро сейчас работает (его запустил Chrome) — закройте Chrome и запустите скрипт снова."
}

# --- 3. Компаньон ---
Step 'Компаньон'
if ($go) {
  $running = Get-Process waysplit-host -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $hostExe }
  if ($running) { Fail 'компаньон сейчас работает (его запустил Chrome). Закройте Chrome и запустите скрипт снова.' }
  Write-Host 'собираю host\bin\waysplit-host.exe'
  Push-Location (Join-Path $root 'host')
  try {
    & $go build -o $hostExe .
    if ($LASTEXITCODE -ne 0) { Fail 'сборка не удалась (причина — выше).' }
  } finally {
    Pop-Location
  }
}
& $hostExe version

# --- 4. Регистрация в Chrome ---
if (-not $NoInstall) {
  Step 'Регистрация в Chrome'
  & $hostExe install
  if ($LASTEXITCODE -ne 0) { Fail 'регистрация не удалась (причина — выше).' }
}

Step 'Готово'
Write-Host 'Дальше — в Chrome: откройте chrome://extensions, включите «Режим разработчика»,'
Write-Host '«Загрузить распакованное расширение» и выберите папку:'
Write-Host "  $(Join-Path $root 'extension')"

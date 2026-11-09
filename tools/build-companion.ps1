# Архив компаньона: dist\Waysplit-companion.zip (имя без версии) и .sha256 рядом (SPEC-STORE.md, 1.2).
# Ядра sing-box и Xray — в dist\cores (tools\cores.ps1): уже лежащие с верной SHA-256 не трогаются,
# подходящие берутся из host\bin (без интернета), остальное скачивается из официальных выпусков
# со сверкой SHA-256 (tools\cores.json). Остальное делает tools\release (Go): сборка
# waysplit-host.exe без путей этого компьютера, со значком и сведениями о версии, установщик,
# инструкция, ядра с лицензиями (CORES.txt) и полные тексты лицензий чужого кода (по go list -deps).
# -Draft — с заглушкой имени на GitHub (не для публикации).
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File tools\build-companion.ps1 [-Draft]
param([switch]$Draft)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'cores.ps1')
Install-Cores -Dest (Join-Path $root 'dist\cores') -Reuse (Join-Path $root 'host\bin')
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = Join-Path $env:LOCALAPPDATA 'Programs\go\bin\go.exe' }
Push-Location $PSScriptRoot
try {
  $flags = @('run', './release', 'companion')
  if ($Draft) { $flags += '-draft' }
  & $go @flags
  exit $LASTEXITCODE
} finally { Pop-Location }

# Архив для Chrome Web Store: store\waysplit-<версия>.zip (SPEC-STORE.md, 2.1).
# Всё делает tools\release (Go): копия extension\ без поля key и лишних файлов, проверки manifest,
# значка и кода из интернета. -Draft — с заглушкой имени на GitHub (только чтобы узнать ID).
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File tools\build-store.ps1 [-Draft]
param([switch]$Draft)
$ErrorActionPreference = 'Stop'
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = Join-Path $env:LOCALAPPDATA 'Programs\go\bin\go.exe' }
Push-Location $PSScriptRoot
try {
  $flags = @('run', './release', 'store')
  if ($Draft) { $flags += '-draft' }
  & $go @flags
  exit $LASTEXITCODE
} finally { Pop-Location }

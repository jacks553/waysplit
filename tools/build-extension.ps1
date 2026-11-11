# Расширение для ручной установки: dist\Waysplit-extension.zip (имя без версии) и .sha256 рядом.
# Его кладём в выпуск на GitHub — запасной вариант для тех, у кого магазин недоступен (README,
# «Ручная установка (запасной вариант)»). Всё делает tools\release (Go): папка extension\ как есть, с полем key
# (тот же ID, что у версии для разработки, — компаньон его пускает), без ключей и служебных файлов.
# Архив для магазина (без key) — отдельно: tools\build-store.ps1.
# Запуск из папки проекта: powershell -ExecutionPolicy Bypass -File tools\build-extension.ps1
param([switch]$Draft)
$ErrorActionPreference = 'Stop'
$go = (Get-Command go -ErrorAction SilentlyContinue).Source
if (-not $go) { $go = Join-Path $env:LOCALAPPDATA 'Programs\go\bin\go.exe' }
Push-Location $PSScriptRoot
try {
  $flags = @('run', './release', 'extension')
  if ($Draft) { $flags += '-draft' }
  & $go @flags
  exit $LASTEXITCODE
} finally { Pop-Location }

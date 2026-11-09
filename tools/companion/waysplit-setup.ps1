# Waysplit: установка и удаление компаньона (SPEC-STORE.md, 1.2).
#
# Лежит в архиве Waysplit-companion.zip рядом с waysplit-host.exe и ядрами sing-box и Xray;
# запускают его «Установить.cmd» и «Удалить.cmd». Права администратора не нужны (всё — для текущего
# пользователя), интернет — тоже: всё нужное уже в архиве.
#
#   установка   — сверяет файлы с SHA256SUMS.txt из архива (архив распакован целиком и не
#                 повреждён), копирует компаньон и ядра в %LOCALAPPDATA%\Programs\Waysplit и
#                 регистрирует компаньон в Chrome (waysplit-host.exe install). Запуск ещё раз —
#                 обновление: серверы, правила и настройки хранятся в Chrome и не теряются;
#   -Uninstall  — снимает регистрацию, удаляет программу и её данные (%LOCALAPPDATA%\Waysplit).
#                 Идентификатор устройства (device-id) — только если на вопрос ответить «да»:
#                 без него провайдер подписки при новой установке посчитает компьютер новым
#                 устройством. По умолчанию (Enter или нет ответа) он остаётся;
#   -NoPause    — не ждать нажатия клавиши в конце (для проверок);
#   -DeviceId keep|delete — ответ на вопрос про идентификатор заранее (для проверок: без человека
#                 у окна вопрос ждал бы ответа вечно).
param([switch]$Uninstall, [switch]$NoPause, [ValidateSet('ask', 'keep', 'delete')][string]$DeviceId = 'ask')

$ErrorActionPreference = 'Stop'

$App = Join-Path $env:LOCALAPPDATA 'Programs\Waysplit'
$Data = Join-Path $env:LOCALAPPDATA 'Waysplit'
$HostExe = 'waysplit-host.exe'
$RegKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.waysplit.host'
# Что копируется из архива в папку программы (имена — как в архиве). Ядра — те версии, что
# записаны в CORES.txt (там же их лицензии и где взять исходный код).
$AppFiles = @($HostExe, 'sing-box.exe', 'xray.exe', 'waysplit-setup.ps1', 'Удалить.cmd', 'Прочитай меня.txt',
  'LICENSE.txt', 'THIRD-PARTY-LICENSES.txt', 'CORES.txt', 'sing-box-LICENSE.txt', 'sing-box-GPL-3.0.txt',
  'xray-LICENSE.txt', 'SHA256SUMS.txt')
# Остались от прежних версий установщика (ядра скачивались, sing-box — с библиотекой для протокола,
# которого в Waysplit нет): при обновлении убираются.
$Stale = @('cores.txt', 'libcronet.dll')

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { throw [System.Exception]::new($text) }

function Finish($code) {
  if (-not $NoPause) {
    Write-Host ''
    Write-Host 'Нажмите любую клавишу, чтобы закрыть окно.'
    try { [void][Console]::ReadKey($true) } catch { }
  }
  exit $code
}

# StopOurs — завершить компаньон и ядра, запущенные из папки программы. Только по полному пути
# к файлу и номеру процесса: одноимённые программы в других папках (например, sing-box другого
# VPN-клиента) не трогаем.
function StopOurs {
  $root = [IO.Path]::GetFullPath($App).TrimEnd('\') + '\'
  $ours = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    })
  if ($ours.Count -eq 0) { return }
  Say "Останавливаю работающий компаньон ($($ours.Count) процесс.) — VPN в Chrome переподключится сам."
  foreach ($p in $ours) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
  }
  foreach ($p in $ours) {
    try { $p.WaitForExit(5000) | Out-Null } catch { }
  }
}

# CheckFiles — все файлы для установки на месте и совпадают с SHA256SUMS.txt (его пишет сборка
# архива): архив распакован целиком, и при скачивании ничего не испортилось. Это проверка
# целостности, не подлинности: подлинность — SHA-256 самого архива со страницы выпуска
# («Прочитай меня.txt»).
function CheckFiles($dir) {
  $again = 'Скачайте архив заново, распакуйте его целиком (правой кнопкой по архиву → «Извлечь всё…») и запустите «Установить.cmd» из распакованной папки.'
  $list = Join-Path $dir 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $list)) { Fail "рядом нет SHA256SUMS.txt — архив распакован не целиком. $again" }
  $sums = @{}
  foreach ($line in (Get-Content -LiteralPath $list -Encoding UTF8)) {
    if ($line -match '^([0-9a-f]{64})  (.+)$') { $sums[$Matches[2]] = $Matches[1] }
  }
  $bad = @()
  foreach ($f in $AppFiles) {
    if ($f -eq 'SHA256SUMS.txt') { continue }
    if (-not $sums.ContainsKey($f)) { $bad += "$f — нет в SHA256SUMS.txt"; continue }
    $path = Join-Path $dir $f
    if (-not (Test-Path -LiteralPath $path)) { $bad += "$f — нет файла"; continue }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $sums[$f]) { $bad += "$f — файл повреждён" }
  }
  if ($bad.Count -gt 0) {
    Fail ("архив распакован не целиком или повреждён:`r`n  " + ($bad -join "`r`n  ") + "`r`n$again")
  }
  Say "все файлы на месте ($($AppFiles.Count)), контрольные суммы SHA-256 сходятся"
}

# FirstLine — первая строка ответа программы на «version».
function FirstLine($exe) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return "$((& $exe version 2>$null) | Select-Object -First 1)".Trim() } finally { $ErrorActionPreference = $prev }
}

function Install {
  Say 'Waysplit — установка компаньона'
  $src = $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $src $HostExe))) {
    Fail 'рядом нет waysplit-host.exe. Сначала распакуйте архив целиком (правой кнопкой по архиву → «Извлечь всё…») и запустите «Установить.cmd» из распакованной папки.'
  }
  if (-not [Environment]::Is64BitOperatingSystem) { Fail 'нужна 64-битная Windows 10 или 11.' }

  Step 'Проверка файлов'
  CheckFiles $src

  Step "Программа → $App"
  New-Item -ItemType Directory -Force $App | Out-Null
  StopOurs
  $same = [IO.Path]::GetFullPath($src).TrimEnd('\') -ieq [IO.Path]::GetFullPath($App).TrimEnd('\')
  # Файлы прежних версий — до копирования: старый cores.txt и новый CORES.txt для Windows одно имя
  # (после копирования удалился бы новый). Запуск из самой папки программы: там это уже новые файлы.
  foreach ($f in $Stale) {
    if ($same -and $AppFiles -contains $f) { continue }
    $old = Join-Path $App $f
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue }
  }
  foreach ($f in $AppFiles) {
    $to = Join-Path $App $f
    if (-not $same) {
      try { Copy-Item -LiteralPath (Join-Path $src $f) $to -Force }
      catch { Fail "не удалось записать $to ($($_.Exception.Message)). Закройте Chrome и запустите установку ещё раз." }
    }
    Unblock-File -LiteralPath $to -ErrorAction SilentlyContinue # отметка «скачано из интернета» — от архива
  }
  Say ((& (Join-Path $App $HostExe) version) -join ' ')
  Say (FirstLine (Join-Path $App 'sing-box.exe'))
  Say (FirstLine (Join-Path $App 'xray.exe'))

  Step 'Регистрация в Chrome'
  & (Join-Path $App $HostExe) install
  if ($LASTEXITCODE -ne 0) { Fail 'компаньон не зарегистрировался (сообщение выше).' }

  Write-Host ''
  Write-Host 'Готово: компаньон установлен.' -ForegroundColor Green
  Say 'Вернитесь в Chrome: на странице «Начало работы» нажмите «Проверить ещё раз» или просто включите VPN в окне Waysplit.'
  Say "Удалить компаньон: «Удалить.cmd» в папке $App"
}

# AskDeleteDeviceId — удалять ли идентификатор устройства. По умолчанию — нет: просто Enter
# или нет ответа (окно без ввода). «да» можно набрать и в английской раскладке («lf»).
function AskDeleteDeviceId {
  Write-Host ''
  Say 'В папке данных лежит идентификатор устройства (файл device-id). По нему провайдер подписки'
  Say 'узнаёт этот компьютер, если подписка привязана к устройству.'
  Say 'Если его удалить, то при повторной установке Waysplit провайдер посчитает компьютер НОВЫМ'
  Say 'устройством — а лимит устройств у подписки может закончиться.'
  Write-Host 'Удалить идентификатор устройства? Введите «да» и нажмите Enter. Просто Enter — оставить: ' -NoNewline
  $answer = $null
  try { $answer = [Console]::In.ReadLine() } catch { }
  Write-Host ''
  return ("$answer".Trim() -match '^(да|д|lf|l|yes|y)$')
}

function Remove {
  Say 'Waysplit — удаление компаньона'
  $idFile = Join-Path $Data 'device-id'
  $hadId = Test-Path $idFile
  $keepId = $false
  if ($hadId) {
    switch ($DeviceId) {
      'keep' { $keepId = $true }
      'delete' { $keepId = $false }
      default { $keepId = -not (AskDeleteDeviceId) }
    }
  }
  StopOurs
  Set-Location $env:TEMP # из удаляемой папки нужно выйти, иначе Windows её не отдаст

  Step 'Регистрация в Chrome'
  $exe = Join-Path $App $HostExe
  if (Test-Path $exe) { & $exe uninstall }
  if (Test-Path $RegKey) { Remove-Item $RegKey -Recurse -Force -ErrorAction SilentlyContinue }
  $leftKey = Test-Path $RegKey
  if ($leftKey) { Say "не удалось убрать ключ реестра $RegKey" } else { Say 'в Chrome компаньон больше не зарегистрирован' }

  Step 'Файлы'
  $left = @()
  if (Test-Path $App) {
    Remove-Item $App -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $App) { $left += $App } else { Say "удалено: $App" }
  }
  if (Test-Path $Data) {
    if ($keepId) {
      # Всё, кроме идентификатора: журналы, настройки ядер (в них данные серверов).
      Get-ChildItem -LiteralPath $Data -Force | Where-Object { $_.Name -ne 'device-id' } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      $rest = @(Get-ChildItem -LiteralPath $Data -Force | Where-Object { $_.Name -ne 'device-id' })
      if ($rest.Count -gt 0) { $left += $rest.FullName } else { Say "удалено: журналы и настройки ядер в $Data" }
      Say "оставлен идентификатор устройства: $idFile"
    } else {
      Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $Data) { $left += $Data } else { Say "удалено: $Data" }
    }
  }

  Write-Host ''
  if ($leftKey) { $left += "ключ реестра $RegKey (regedit)" }
  if ($left.Count -eq 0) {
    Write-Host 'Готово: компаньон удалён.' -ForegroundColor Green
  } else {
    Write-Host 'Удалено не всё. Закройте Chrome и удалите вручную:' -ForegroundColor Yellow
    foreach ($d in $left) { Say "  $d" }
  }
  Say 'Осталось сделать вручную:'
  Say '  • расширение Waysplit — в Chrome: правой кнопкой по значку → «Удалить из Chrome» (вместе с ним удалятся серверы и правила);'
  if ($keepId) {
    Say "  • идентификатор устройства оставлен ($idFile): установите Waysplit снова — провайдер увидит тот же компьютер."
    Say '    Если Waysplit на этом компьютере больше не нужен, удалите этот файл и отвяжите устройство в личном кабинете провайдера.'
  } elseif ($hadId) {
    Say '  • идентификатор устройства удалён: если подписка была привязана к этому компьютеру, отвяжите устройство в личном кабинете'
    Say '    провайдера — при новой установке компьютер будет считаться новым устройством.'
  }
}

try {
  if ($Uninstall) { Remove } else { Install }
  Finish 0
} catch {
  Write-Host ''
  Write-Host "ОШИБКА: $($_.Exception.Message)" -ForegroundColor Red
  Finish 1
}

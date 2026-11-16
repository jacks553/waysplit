# Waysplit: установка и удаление компаньона (SPEC-STORE.md, 1.2).
#
# Лежит в архиве Waysplit-companion.zip рядом с waysplit-host.exe и ядрами sing-box и Xray;
# запускают его «Установить.cmd» и «Удалить.cmd» (они же — Install.cmd и Uninstall.cmd). Права
# администратора не нужны (всё — для текущего пользователя), интернет — тоже: всё нужное уже в архиве.
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
#                 у окна вопрос ждал бы ответа вечно);
#   -Lang ru|en — язык сообщений (для проверок). Без параметра — по языку Windows: русский при
#                 русской Windows, иначе английский (как язык окна расширения «как в Chrome»).
#                 Тот же язык получает waysplit-host.exe (переменная WAYSPLIT_LANG).
param([switch]$Uninstall, [switch]$NoPause, [ValidateSet('ask', 'keep', 'delete')][string]$DeviceId = 'ask',
  [ValidateSet('auto', 'ru', 'en')][string]$Lang = 'auto')

$ErrorActionPreference = 'Stop'

$App = Join-Path $env:LOCALAPPDATA 'Programs\Waysplit'
$Data = Join-Path $env:LOCALAPPDATA 'Waysplit'
$HostExe = 'waysplit-host.exe'
$RegKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.waysplit.host'
# Что копируется из архива в папку программы (имена — как в архиве). Ядра — те версии, что
# записаны в CORES.txt (там же их лицензии и где взять исходный код).
$AppFiles = @($HostExe, 'sing-box.exe', 'xray.exe', 'waysplit-setup.ps1', 'Удалить.cmd', 'Uninstall.cmd', 'Прочитай меня.txt', 'README.txt',
  'LICENSE.txt', 'THIRD-PARTY-LICENSES.txt', 'CORES.txt', 'sing-box-LICENSE.txt', 'sing-box-GPL-3.0.txt',
  'xray-LICENSE.txt', 'SHA256SUMS.txt')
# Остались от прежних версий установщика (ядра скачивались, sing-box — с библиотекой для протокола,
# которого в Waysplit нет): при обновлении убираются.
$Stale = @('cores.txt', 'libcronet.dll')

if ($Lang -eq 'auto') {
  $Lang = 'en'
  try { if ((Get-UICulture).TwoLetterISOLanguageName -eq 'ru') { $Lang = 'ru' } } catch { }
}
$env:WAYSPLIT_LANG = $Lang

# Сообщения на двух языках. {0}, {1} — вставки. Русские — как были до версии 1.2.0.
$Text = @{
  ru = @{
    pressKey      = 'Нажмите любую клавишу, чтобы закрыть окно.'
    stopping      = 'Останавливаю работающий компаньон ({0} процесс.) — VPN в Chrome переподключится сам.'
    again         = 'Скачайте архив заново, распакуйте его целиком (правой кнопкой по архиву → «Извлечь всё…») и запустите «Установить.cmd» из распакованной папки.'
    noSums        = 'рядом нет SHA256SUMS.txt — архив распакован не целиком. {0}'
    notInSums     = '{0} — нет в SHA256SUMS.txt'
    noFile        = '{0} — нет файла'
    badFile       = '{0} — файл повреждён'
    broken        = 'архив распакован не целиком или повреждён:'
    filesOk       = 'все файлы на месте ({0}), контрольные суммы SHA-256 сходятся'
    installTitle  = 'Waysplit — установка компаньона'
    noHost        = 'рядом нет waysplit-host.exe. Сначала распакуйте архив целиком (правой кнопкой по архиву → «Извлечь всё…») и запустите «Установить.cmd» из распакованной папки.'
    need64        = 'нужна 64-битная Windows 10 или 11.'
    stepCheck     = 'Проверка файлов'
    stepProgram   = 'Программа → {0}'
    copyFail      = 'не удалось записать {0} ({1}). Закройте Chrome и запустите установку ещё раз.'
    stepRegister  = 'Регистрация в Chrome'
    regFail       = 'компаньон не зарегистрировался (сообщение выше).'
    installDone   = 'Готово: компаньон установлен.'
    backToChrome  = 'Вернитесь в Chrome: на странице «Начало работы» нажмите «Проверить ещё раз» или просто включите VPN в окне Waysplit.'
    howRemove     = 'Удалить компаньон: «Удалить.cmd» в папке {0}'
    idAbout1      = 'В папке данных лежит идентификатор устройства (файл device-id). По нему провайдер подписки'
    idAbout2      = 'узнаёт этот компьютер, если подписка привязана к устройству.'
    idAbout3      = 'Если его удалить, то при повторной установке Waysplit провайдер посчитает компьютер НОВЫМ'
    idAbout4      = 'устройством — а лимит устройств у подписки может закончиться.'
    idQuestion    = 'Удалить идентификатор устройства? Введите «да» и нажмите Enter. Просто Enter — оставить: '
    removeTitle   = 'Waysplit — удаление компаньона'
    keyLeft       = 'не удалось убрать ключ реестра {0}'
    unregistered  = 'в Chrome компаньон больше не зарегистрирован'
    stepFiles     = 'Файлы'
    removed       = 'удалено: {0}'
    removedData   = 'удалено: журналы и настройки ядер в {0}'
    keptId        = 'оставлен идентификатор устройства: {0}'
    keyManual     = 'ключ реестра {0} (regedit)'
    removeDone    = 'Готово: компаньон удалён.'
    notAll        = 'Удалено не всё. Закройте Chrome и удалите вручную:'
    manual        = 'Осталось сделать вручную:'
    manualExt     = '  • расширение Waysplit — в Chrome: правой кнопкой по значку → «Удалить из Chrome» (вместе с ним удалятся серверы и правила);'
    manualKept1   = '  • идентификатор устройства оставлен ({0}): установите Waysplit снова — провайдер увидит тот же компьютер.'
    manualKept2   = '    Если Waysplit на этом компьютере больше не нужен, удалите этот файл и отвяжите устройство в личном кабинете провайдера.'
    manualGone1   = '  • идентификатор устройства удалён: если подписка была привязана к этому компьютеру, отвяжите устройство в личном кабинете'
    manualGone2   = '    провайдера — при новой установке компьютер будет считаться новым устройством.'
    error         = 'ОШИБКА: {0}'
  }
  en = @{
    pressKey      = 'Press any key to close this window.'
    stopping      = 'Stopping the running companion (processes: {0}). The VPN in Chrome will reconnect by itself.'
    again         = 'Download the archive again, extract all of it (right-click the archive, then "Extract All...") and run "Install.cmd" from the extracted folder.'
    noSums        = 'SHA256SUMS.txt is missing: the archive was not fully extracted. {0}'
    notInSums     = '{0}: not listed in SHA256SUMS.txt'
    noFile        = '{0}: the file is missing'
    badFile       = '{0}: the file is damaged'
    broken        = 'the archive was not fully extracted or is damaged:'
    filesOk       = 'all files are in place ({0}), SHA-256 checksums match'
    installTitle  = 'Waysplit: installing the companion'
    noHost        = 'waysplit-host.exe is missing. First extract the whole archive (right-click the archive, then "Extract All...") and run "Install.cmd" from the extracted folder.'
    need64        = '64-bit Windows 10 or 11 is required.'
    stepCheck     = 'Checking files'
    stepProgram   = 'Program folder: {0}'
    copyFail      = 'could not write {0} ({1}). Close Chrome and run the installer again.'
    stepRegister  = 'Chrome registration'
    regFail       = 'the companion was not registered (see the message above).'
    installDone   = 'Done: the companion is installed.'
    backToChrome  = 'Go back to Chrome: on the "Getting started" page click "Check again", or just turn on the VPN in the Waysplit popup.'
    howRemove     = 'To remove the companion, run "Uninstall.cmd" in {0}'
    idAbout1      = 'The data folder holds a device ID (the file device-id). Your subscription provider uses it'
    idAbout2      = 'to recognize this computer if the subscription is linked to a device.'
    idAbout3      = 'If you delete it and install Waysplit again, the provider will treat this computer as a NEW'
    idAbout4      = 'device, and the device limit of your subscription may run out.'
    idQuestion    = 'Delete the device ID? Type "yes" and press Enter. Just Enter keeps it: '
    removeTitle   = 'Waysplit: removing the companion'
    keyLeft       = 'could not remove the registry key {0}'
    unregistered  = 'the companion is no longer registered in Chrome'
    stepFiles     = 'Files'
    removed       = 'removed: {0}'
    removedData   = 'removed: logs and core settings in {0}'
    keptId        = 'kept the device ID: {0}'
    keyManual     = 'the registry key {0} (regedit)'
    removeDone    = 'Done: the companion is removed.'
    notAll        = 'Not everything was removed. Close Chrome and delete these by hand:'
    manual        = 'Left to do by hand:'
    manualExt     = '  - The Waysplit extension. In Chrome, right-click its icon and choose "Remove from Chrome". Servers and rules are removed with it.'
    manualKept1   = '  - The device ID is kept ({0}). Install Waysplit again and the provider will see the same computer.'
    manualKept2   = '    If you no longer need Waysplit on this computer, delete this file and unlink the device in your provider account.'
    manualGone1   = '  - The device ID is deleted. If the subscription was linked to this computer, unlink the device in your provider'
    manualGone2   = '    account. After a new install the computer will count as a new device.'
    error         = 'ERROR: {0}'
  }
}

# T — сообщение на языке установщика: T 'ключ' [вставки…].
function T($key) {
  $s = $Text[$Lang][$key]
  if ($args.Count -gt 0) { return ($s -f $args) }
  return $s
}

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Fail($text) { throw [System.Exception]::new($text) }

function Finish($code) {
  if (-not $NoPause) {
    Write-Host ''
    Write-Host (T 'pressKey')
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
  Say (T 'stopping' $ours.Count)
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
# («Прочитай меня.txt», README.txt).
function CheckFiles($dir) {
  $again = T 'again'
  $list = Join-Path $dir 'SHA256SUMS.txt'
  if (-not (Test-Path -LiteralPath $list)) { Fail (T 'noSums' $again) }
  $sums = @{}
  foreach ($line in (Get-Content -LiteralPath $list -Encoding UTF8)) {
    if ($line -match '^([0-9a-f]{64})  (.+)$') { $sums[$Matches[2]] = $Matches[1] }
  }
  $bad = @()
  foreach ($f in $AppFiles) {
    if ($f -eq 'SHA256SUMS.txt') { continue }
    if (-not $sums.ContainsKey($f)) { $bad += (T 'notInSums' $f); continue }
    $path = Join-Path $dir $f
    if (-not (Test-Path -LiteralPath $path)) { $bad += (T 'noFile' $f); continue }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -ne $sums[$f]) { $bad += (T 'badFile' $f) }
  }
  if ($bad.Count -gt 0) {
    Fail ((T 'broken') + "`r`n  " + ($bad -join "`r`n  ") + "`r`n$again")
  }
  Say (T 'filesOk' $AppFiles.Count)
}

# FirstLine — первая строка ответа программы на «version».
function FirstLine($exe) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return "$((& $exe version 2>$null) | Select-Object -First 1)".Trim() } finally { $ErrorActionPreference = $prev }
}

function Install {
  Say (T 'installTitle')
  $src = $PSScriptRoot
  if (-not (Test-Path -LiteralPath (Join-Path $src $HostExe))) { Fail (T 'noHost') }
  if (-not [Environment]::Is64BitOperatingSystem) { Fail (T 'need64') }

  Step (T 'stepCheck')
  CheckFiles $src

  Step (T 'stepProgram' $App)
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
      catch { Fail (T 'copyFail' $to $_.Exception.Message) }
    }
    Unblock-File -LiteralPath $to -ErrorAction SilentlyContinue # отметка «скачано из интернета» — от архива
  }
  Say ((& (Join-Path $App $HostExe) version) -join ' ')
  Say (FirstLine (Join-Path $App 'sing-box.exe'))
  Say (FirstLine (Join-Path $App 'xray.exe'))

  Step (T 'stepRegister')
  & (Join-Path $App $HostExe) install
  if ($LASTEXITCODE -ne 0) { Fail (T 'regFail') }

  Write-Host ''
  Write-Host (T 'installDone') -ForegroundColor Green
  Say (T 'backToChrome')
  Say (T 'howRemove' $App)
}

# AskDeleteDeviceId — удалять ли идентификатор устройства. По умолчанию — нет: просто Enter
# или нет ответа (окно без ввода). Ответ «да» или yes понимается на обоих языках; «да» можно
# набрать и в английской раскладке («lf»).
function AskDeleteDeviceId {
  Write-Host ''
  Say (T 'idAbout1')
  Say (T 'idAbout2')
  Say (T 'idAbout3')
  Say (T 'idAbout4')
  Write-Host (T 'idQuestion') -NoNewline
  $answer = $null
  try { $answer = [Console]::In.ReadLine() } catch { }
  Write-Host ''
  return ("$answer".Trim() -match '^(да|д|lf|l|yes|y)$')
}

function Remove {
  Say (T 'removeTitle')
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

  Step (T 'stepRegister')
  $exe = Join-Path $App $HostExe
  # Что компаньон пишет о снятой регистрации, не показываем: ниже то же самое говорит сам установщик,
  # уже проверив реестр. Ошибку компаньон пишет в другой поток, она остаётся видна.
  if (Test-Path $exe) { & $exe uninstall | Out-Null }
  if (Test-Path $RegKey) { Remove-Item $RegKey -Recurse -Force -ErrorAction SilentlyContinue }
  $leftKey = Test-Path $RegKey
  if ($leftKey) { Say (T 'keyLeft' $RegKey) } else { Say (T 'unregistered') }

  Step (T 'stepFiles')
  $left = @()
  if (Test-Path $App) {
    Remove-Item $App -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $App) { $left += $App } else { Say (T 'removed' $App) }
  }
  if (Test-Path $Data) {
    if ($keepId) {
      # Всё, кроме идентификатора: журналы, настройки ядер (в них данные серверов).
      Get-ChildItem -LiteralPath $Data -Force | Where-Object { $_.Name -ne 'device-id' } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      $rest = @(Get-ChildItem -LiteralPath $Data -Force | Where-Object { $_.Name -ne 'device-id' })
      if ($rest.Count -gt 0) { $left += $rest.FullName } else { Say (T 'removedData' $Data) }
      Say (T 'keptId' $idFile)
    } else {
      Remove-Item $Data -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $Data) { $left += $Data } else { Say (T 'removed' $Data) }
    }
  }

  Write-Host ''
  if ($leftKey) { $left += (T 'keyManual' $RegKey) }
  if ($left.Count -eq 0) {
    Write-Host (T 'removeDone') -ForegroundColor Green
  } else {
    Write-Host (T 'notAll') -ForegroundColor Yellow
    foreach ($d in $left) { Say "  $d" }
  }
  Say (T 'manual')
  Say (T 'manualExt')
  if ($keepId) {
    Say (T 'manualKept1' $idFile)
    Say (T 'manualKept2')
  } elseif ($hadId) {
    Say (T 'manualGone1')
    Say (T 'manualGone2')
  }
}

try {
  if ($Uninstall) { Remove } else { Install }
  Finish 0
} catch {
  Write-Host ''
  Write-Host (T 'error' $_.Exception.Message) -ForegroundColor Red
  Finish 1
}

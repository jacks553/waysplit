# Ядра Waysplit (sing-box, Xray): файлы из официальных выпусков, сверенные по SHA-256.
# Версии, адреса и контрольные суммы — tools\cores.json (единственное место).
# Подключается точкой: . (Join-Path $PSScriptRoot 'cores.ps1'), затем:
#
#   Install-Cores -Dest папка [-Reuse папки]
#       нужные файлы ядер — в папке. Уже лежащие с верной SHA-256 не трогаются; подходящие
#       берутся из папок -Reuse (без интернета — например, из host\bin); остальное: скачать
#       архив выпуска, сверить его SHA-256, достать файлы и сверить SHA-256 каждого.
#   Save-CoreSources -Dest папка
#       архивы исходного кода этих версий (их прикладываем к выпуску: GPL-3.0 у sing-box,
#       MPL-2.0 у Xray). Возвращает имена файлов и их SHA-256.

$WaysplitCoresJson = Join-Path $PSScriptRoot 'cores.json'

function Get-WaysplitCores {
  (Get-Content $WaysplitCoresJson -Raw -Encoding UTF8 | ConvertFrom-Json).cores
}

function Get-FileSha256([string]$Path) {
  (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function Use-Tls12 {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Install-Cores {
  param([Parameter(Mandatory = $true)][string]$Dest, [string[]]$Reuse = @())
  $ProgressPreference = 'SilentlyContinue' # с полоской загрузки Invoke-WebRequest в PowerShell 5.1 качает в разы медленнее
  New-Item -ItemType Directory -Force $Dest | Out-Null
  foreach ($core in Get-WaysplitCores) {
    $missing = @()
    $from = @()
    foreach ($f in $core.files) {
      $target = Join-Path $Dest $f.name
      if ((Test-Path -LiteralPath $target) -and (Get-FileSha256 $target) -eq $f.sha256) { continue }
      $copied = $false
      foreach ($dir in $Reuse) {
        $cand = Join-Path $dir $f.name
        if ((Test-Path -LiteralPath $cand) -and (Get-FileSha256 $cand) -eq $f.sha256) {
          Copy-Item -LiteralPath $cand $target -Force
          $copied = $true
          if ($from -notcontains $dir) { $from += $dir }
          break
        }
      }
      if (-not $copied) { $missing += $f }
    }
    if ($missing.Count -eq 0) {
      if ($from.Count -gt 0) { Write-Host "$($core.name) $($core.version): взят из $($from -join ', '), SHA-256 сходится" }
      else { Write-Host "$($core.name) $($core.version): на месте, SHA-256 сходится" }
      continue
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('waysplit-cores-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $tmp | Out-Null
    try {
      Use-Tls12
      $zip = Join-Path $tmp 'core.zip'
      Write-Host "скачиваю $($core.name) $($core.version): $($core.zip)"
      try { Invoke-WebRequest -Uri $core.zip -OutFile $zip -UseBasicParsing }
      catch { throw "$($core.name) не скачался: $($_.Exception.Message)" }
      $got = Get-FileSha256 $zip
      if ($got -ne $core.zipSha256) { throw "контрольная сумма архива $($core.name) не совпала ($got) — это не тот файл" }
      Add-Type -AssemblyName System.IO.Compression.FileSystem
      $z = [IO.Compression.ZipFile]::OpenRead($zip)
      try {
        foreach ($f in $missing) {
          $entry = $z.Entries | Where-Object { $_.FullName -eq $f.from } | Select-Object -First 1
          if (-not $entry) { throw "в архиве $($core.name) нет $($f.from)" }
          $target = Join-Path $Dest $f.name
          [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
          $got = Get-FileSha256 $target
          if ($got -ne $f.sha256) {
            Remove-Item -LiteralPath $target -Force
            throw "SHA-256 файла $($f.name) из архива $($core.name) не совпала ($got)"
          }
        }
      } finally { $z.Dispose() }
      Write-Host "$($core.name) $($core.version): скачан, SHA-256 архива и файлов сходятся"
    } finally {
      Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Save-CoreSources {
  param([Parameter(Mandatory = $true)][string]$Dest)
  $ProgressPreference = 'SilentlyContinue'
  Use-Tls12
  New-Item -ItemType Directory -Force $Dest | Out-Null
  foreach ($core in Get-WaysplitCores) {
    $out = Join-Path $Dest $core.sourceName
    Write-Host "исходники $($core.name) $($core.version): $($core.sourceArchive)"
    try { Invoke-WebRequest -Uri $core.sourceArchive -OutFile $out -UseBasicParsing }
    catch { throw "исходники $($core.name) не скачались: $($_.Exception.Message)" }
    [pscustomobject]@{ Name = $core.sourceName; Sha256 = (Get-FileSha256 $out); Core = "$($core.name) $($core.version)"; Url = $core.sourceArchive }
  }
}

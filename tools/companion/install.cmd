@echo off
rem Waysplit companion: install or update (see waysplit-setup.ps1 next to this file).
rem In the release archive this file has a Russian name ("Install.cmd" in Russian).
rem Extra arguments go to the script (for checks: -NoPause). The exit code is passed on by the
rem separate "exit /b %errorlevel%" line: "... & exit /b" on the same line returned 0 even when
rem the script failed (found by tools\ci.ps1).
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0waysplit-setup.ps1" %*
exit /b %errorlevel%

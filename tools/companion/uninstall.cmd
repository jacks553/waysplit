@echo off
rem Waysplit companion: uninstall (see waysplit-setup.ps1 next to this file).
rem The release archive holds this file twice: as Uninstall.cmd and under a Russian name.
rem The script may delete this very file (when run from the program folder), so cmd must not
rem read it again: the call is in parentheses and "exit" (not "exit /b") ends cmd at once,
rem keeping the script's exit code. Checked: other forms print "The system cannot find the path".
rem Extra arguments go to the script (for checks: -NoPause -DeviceId keep or delete).
cd /d "%TEMP%"
(powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0waysplit-setup.ps1" -Uninstall %*) & exit

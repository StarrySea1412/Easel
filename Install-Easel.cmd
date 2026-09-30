@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Easel.ps1" -InstallOnly %*
set "EASEL_EXIT=%ERRORLEVEL%"
if not "%EASEL_EXIT%"=="0" pause
exit /b %EASEL_EXIT%

@echo off
setlocal
title Easel Quick Start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Quick-Start-Easel.ps1" %*
set "EASEL_QUICK_EXIT=%ERRORLEVEL%"
if not "%EASEL_QUICK_EXIT%"=="0" pause
exit /b %EASEL_QUICK_EXIT%

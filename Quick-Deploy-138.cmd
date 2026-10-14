@echo off
setlocal
title Easel Quick Deploy to 138
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy_138.ps1" %*
set "EASEL_DEPLOY_EXIT=%ERRORLEVEL%"
if not "%EASEL_DEPLOY_EXIT%"=="0" pause
exit /b %EASEL_DEPLOY_EXIT%

@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [TabTin] Node.js 18 or newer is required.
  echo Download it from https://nodejs.org/ and run this launcher again.
  pause
  exit /b 1
)

node "%~dp0scripts\dev.mjs" community %*
set "tabtin_exit_code=%errorlevel%"

if not "%tabtin_exit_code%"=="0" (
  echo.
  echo [TabTin] Startup failed. Review the messages above for details.
  pause
)

exit /b %tabtin_exit_code%

@echo off
setlocal EnableExtensions
if "%~1"=="" exit /b 2
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /R /C:":%~1 .*LISTENING"') do (
  echo [PROCESS] Stopping PID %%P listening on port %~1...
  taskkill /PID %%P /T /F >nul 2>&1
)
exit /b 0

@echo off
rem Shared Windows Electron development defaults. The repository root .env is the SSoT.
for %%I in ("%~dp0..\..") do set "ROOT_DIR=%%~fI"
set "LOG_DIR=%ROOT_DIR%\apps\tabtin_django\logs"
set "VITE_DEV_SERVER_PORT=5175"
if exist "%ROOT_DIR%\.env" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT_DIR%\.env") do (
  if not "%%A"=="" set "%%A=%%B"
)
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

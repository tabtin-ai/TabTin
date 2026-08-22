@echo off
rem Shared Windows development defaults. The repository root .env is the SSoT.
for %%I in ("%~dp0..\..") do set "ROOT_DIR=%%~fI"
set "DJANGO_DIR=%ROOT_DIR%\apps\tabtin_django"
set "VENV_DIR=%DJANGO_DIR%\venv-windows"
set "LOG_DIR=%DJANGO_DIR%\logs"
set "DJANGO_BIND_PORT=6060"
set "COLLAB_LIVE_PORT=4100"
set "CENTRIFUGO_PORT=8100"
set "VITE_DEV_SERVER_PORT=5175"
set "PG_DB_NAME=tabtin_single"
if exist "%ROOT_DIR%\.env" for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT_DIR%\.env") do (
  if not "%%A"=="" set "%%A=%%B"
)
set "PYTHON_BIN=%VENV_DIR%\Scripts\python.exe"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

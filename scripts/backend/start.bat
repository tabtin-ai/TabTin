@echo off
setlocal
call "%~dp0_dev-env.bat"
call "%~dp0..\electron\runtime\_ensure-desktop-runtimes.bat"
echo ============================================================
echo              Starting TabTin backend stack
echo ============================================================
if not exist "%PYTHON_BIN%" (
  echo [SETUP] Django virtual environment is missing. Installing backend dependencies...
  call "%~dp0django-setup.bat" || exit /b 1
  call "%~dp0_dev-env.bat"
)
echo [1/6] Preparing Docker infrastructure and database...
call "%~dp0db-prepare.bat" || exit /b 1
echo.
echo [2/6] Starting Django...
call "%~dp0django-start.bat" || exit /b 1
echo.
echo [3/6] Starting Celery...
call "%~dp0celery-start.bat" || exit /b 1
echo.
echo [4/6] Starting Channel Longpoll...
call "%~dp0longpoll-start.bat" || exit /b 1
echo.
echo [5/6] Starting Collab Live...
call "%~dp0collab-live-start.bat" || exit /b 1
echo.
echo [6/6] Starting Centrifugo...
call "%~dp0centrifugo-start.bat" || exit /b 1
echo.
echo [HEALTH] Waiting for Collab Live, timeout 30 seconds...
for /l %%I in (1,1,30) do (
  curl -fs "http://127.0.0.1:%COLLAB_LIVE_PORT%/health" >nul 2>&1 && goto healthy
  ping 127.0.0.1 -n 2 >nul
)
echo [ERROR] Collab Live health check did not pass.
echo [ERROR] Inspect %LOG_DIR%\collab-live.log
exit /b 1
:healthy
call "%~dp0health-check.bat"
if errorlevel 1 (
  echo [ERROR] Backend stack started but did not pass all health checks.
  exit /b 1
)
echo.
echo ============================================================
echo              TabTin backend stack is ready
echo ============================================================
echo Django:      http://127.0.0.1:%DJANGO_BIND_PORT%
echo Collab Live: ws://127.0.0.1:%COLLAB_LIVE_PORT%
echo Centrifugo:  ws://127.0.0.1:%CENTRIFUGO_PORT%
echo Logs:        %LOG_DIR%
exit /b 0

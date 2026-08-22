@echo off
echo ============================================================
echo              Stopping TabTin application services
echo ============================================================
call "%~dp0django-stop.bat"
call "%~dp0celery-stop.bat"
call "%~dp0collab-live-stop.bat"
call "%~dp0centrifugo-stop.bat"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'manage.py run_longpoll' } | Select-Object -ExpandProperty ProcessId" 2^>nul`) do taskkill /PID %%P /T /F >nul 2>&1
echo [OK] Application services are stopped.
echo [INFO] Docker PostgreSQL and Redis remain running.
exit /b 0

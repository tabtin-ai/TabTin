@echo off
echo [CELERY] Stopping workers and beat...
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python' -and $_.CommandLine -match '-m celery' } | Select-Object -ExpandProperty ProcessId" 2^>nul`) do taskkill /PID %%P /T /F >nul 2>&1
exit /b 0

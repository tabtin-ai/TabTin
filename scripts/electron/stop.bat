@echo off
call "%~dp0_dev-env.bat"
echo [ELECTRON] Stopping dev server and Electron processes...
call "%~dp0_kill-port.bat" "%VITE_DEV_SERVER_PORT%"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'electron' -and $_.CommandLine -match 'TabTin' } | Select-Object -ExpandProperty ProcessId" 2^>nul`) do taskkill /PID %%P /T /F >nul 2>&1
echo [OK] Electron is stopped.
exit /b 0

@echo off
setlocal
call "%~dp0_dev-env.bat"
call "%~dp0runtime\_ensure-desktop-runtimes.bat"
echo [ELECTRON] Starting in a persistent terminal window...
echo [ELECTRON] Dev server: http://127.0.0.1:%VITE_DEV_SERVER_PORT%
start "TabTin Electron Dev" cmd /k "cd /d ""%ROOT_DIR%\apps\tabtin-electron"" && pnpm dev"
echo [OK] Electron launch requested.
exit /b 0

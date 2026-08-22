@echo off
call "%~dp0_dev-env.bat"
echo [CENTRIFUGO] Stopping service on port %CENTRIFUGO_PORT% ...
call "%~dp0_kill-port.bat" "%CENTRIFUGO_PORT%"
echo [OK] Centrifugo is stopped.
exit /b 0

@echo off
call "%~dp0_dev-env.bat"
echo [DJANGO] Stopping service on port %DJANGO_BIND_PORT% ...
call "%~dp0_kill-port.bat" "%DJANGO_BIND_PORT%"
exit /b 0

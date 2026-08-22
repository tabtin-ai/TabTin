@echo off
call "%~dp0_dev-env.bat"
call "%~dp0_kill-port.bat" "%COLLAB_LIVE_PORT%"
exit /b 0

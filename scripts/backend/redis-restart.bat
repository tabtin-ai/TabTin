@echo off
echo [REDIS] Restarting...
call "%~dp0redis-stop.bat" || exit /b 1
call "%~dp0redis-start.bat"
exit /b %ERRORLEVEL%

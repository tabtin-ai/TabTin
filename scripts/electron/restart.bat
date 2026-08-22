@echo off
echo [ELECTRON] Restarting...
call "%~dp0runtime\_ensure-desktop-runtimes.bat"
call "%~dp0stop.bat" || exit /b 1
call "%~dp0start.bat"
exit /b %ERRORLEVEL%

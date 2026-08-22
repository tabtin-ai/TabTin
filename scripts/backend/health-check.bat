@echo off
setlocal EnableDelayedExpansion
call "%~dp0_dev-env.bat"
set "FAILED=0"
call :http Django "http://127.0.0.1:%DJANGO_BIND_PORT%/health" "healthy"
call :http "Collab Live" "http://127.0.0.1:%COLLAB_LIVE_PORT%/health" "ok"
netstat -ano -p tcp | findstr /R /C:":%CENTRIFUGO_PORT% .*LISTENING" >nul || set "FAILED=1"
docker exec tabtin-redis-dev redis-cli ping 2>nul | findstr /I /C:"PONG" >nul || set "FAILED=1"
if "!FAILED!"=="1" exit /b 1
exit /b 0
:http
curl -fs "%~2" 2>nul | findstr /I /C:"%~3" >nul || set "FAILED=1"
exit /b 0

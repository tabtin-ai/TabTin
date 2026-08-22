@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set COMPOSE_DISABLE_ENV_FILE=1

where docker >nul 2>&1
if errorlevel 1 goto docker_not_running
docker info >nul 2>&1
if errorlevel 1 goto docker_not_running
echo Docker: RUNNING
goto check_services

:docker_not_running
echo Docker: NOT RUNNING
echo TabTin Server: NOT READY
echo API: http://127.0.0.1:6060
echo Centrifugo: NOT READY
exit /b 1

:check_services
powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:6060/health/ready; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
  echo TabTin Server: NOT READY
) else (
  echo TabTin Server: READY
)
echo API: http://127.0.0.1:6060

powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:8100/health; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
  echo Centrifugo: NOT READY
) else (
  echo Centrifugo: READY
)
exit /b 0

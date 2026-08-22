@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set COMPOSE_DISABLE_ENV_FILE=1

where docker >nul 2>&1
if errorlevel 1 goto docker_missing
docker --version >nul 2>&1
if errorlevel 1 goto docker_missing
docker compose version >nul 2>&1
if errorlevel 1 goto compose_missing
docker info >nul 2>&1
if errorlevel 1 goto engine_stopped

echo Starting TabTin Community...
docker compose up -d --build
if errorlevel 1 goto startup_failed

set /a READY_ATTEMPT=0
:wait_ready
powershell -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 http://127.0.0.1:6060/health/ready; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 goto ready
set /a READY_ATTEMPT+=1
if %READY_ATTEMPT% GEQ 90 goto ready_timeout
timeout /t 2 /nobreak >nul
goto wait_ready

:ready
call "%~dp0scripts\electron\runtime\_ensure-desktop-runtimes.bat"
echo.
echo ========================================
echo TabTin Community is READY
echo ========================================
echo.
echo 1. Start TabTin Desktop Client
echo.
echo 2. Register / Login
echo.
echo 3. Configure your model:
echo    Settings
echo    -^> Model Configuration
echo    -^> BYOK
echo.
echo 4. Start chatting
echo.
echo Backend:
echo http://127.0.0.1:6060
echo.
echo ========================================
exit /b 0

:docker_missing
echo ERROR: Docker was not found. Install Docker Desktop and try again.
echo https://www.docker.com/products/docker-desktop/
exit /b 1

:compose_missing
echo ERROR: Docker Compose is not available. Update Docker Desktop and try again.
exit /b 1

:engine_stopped
echo ERROR: Docker Engine is not running. Start Docker Desktop and try again.
exit /b 1

:startup_failed
echo ERROR: TabTin Community could not start.
echo Run status.bat to check the current status, then review Docker Desktop logs.
exit /b 1

:ready_timeout
echo ERROR: TabTin Server did not become ready within 180 seconds.
echo Run status.bat and inspect logs with: docker compose logs --tail 200
exit /b 1

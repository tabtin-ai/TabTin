@echo off
setlocal
call "%~dp0_dev-env.bat"
echo [REDIS] Stopping Docker service...
docker compose -f "%ROOT_DIR%\docker-compose.dev.yml" stop redis
if errorlevel 1 (
  echo [ERROR] Redis Docker service failed to stop.
  exit /b 1
)
echo [OK] Redis is stopped.
exit /b 0

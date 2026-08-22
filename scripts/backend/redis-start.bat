@echo off
setlocal
call "%~dp0_dev-env.bat"
echo [REDIS] Starting Docker service...
docker compose -f "%ROOT_DIR%\docker-compose.dev.yml" up -d redis
if errorlevel 1 (
  echo [ERROR] Redis Docker service failed to start.
  exit /b 1
)
for /l %%I in (1,1,30) do (
  docker exec tabtin-redis-dev redis-cli ping 2^>nul | findstr /X "PONG" >nul && echo [OK] Redis is ready on port 6379. && exit /b 0
  ping 127.0.0.1 -n 2 >nul
)
echo [ERROR] Redis did not become ready within 30 seconds.
exit /b 1

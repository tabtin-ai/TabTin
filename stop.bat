@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set COMPOSE_DISABLE_ENV_FILE=1

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker was not found.
  exit /b 1
)

docker compose down
if errorlevel 1 (
  echo ERROR: TabTin Community could not be stopped cleanly.
  exit /b 1
)

echo TabTin Community is stopped. Your data volumes are preserved.
exit /b 0

@echo off
setlocal
call "%~dp0_dev-env.bat"
if not exist "%PYTHON_BIN%" (
  echo [ERROR] Missing Windows virtual environment: %PYTHON_BIN%
  echo Create apps\tabtin_django\venv-windows before starting TabTin.
  exit /b 1
)
echo [INFRA] Starting PostgreSQL and Redis with Docker Compose...
docker compose -f "%ROOT_DIR%\docker-compose.dev.yml" up -d postgres redis
if errorlevel 1 exit /b 1
echo [INFRA] Waiting for PostgreSQL readiness, timeout 60 seconds...
for /l %%I in (1,1,60) do (
  docker exec tabtin-postgres-dev pg_isready -U tabtin -d tabtin_single >nul 2>&1 && goto ready
  ping 127.0.0.1 -n 2 >nul
)
echo [ERROR] PostgreSQL did not become ready within 60 seconds.
exit /b 1
:ready
echo [DATABASE] Applying managed migrations with safe_migrate...
pushd "%DJANGO_DIR%"
"%PYTHON_BIN%" manage.py safe_migrate --noinput
set "RESULT=%ERRORLEVEL%"
popd
if not "%RESULT%"=="0" exit /b %RESULT%
"%PYTHON_BIN%" "%DJANGO_DIR%\manage.py" seed_scene_bindings --if-empty
if errorlevel 1 echo [WARN] Scene binding seed failed; startup will continue.
"%PYTHON_BIN%" "%DJANGO_DIR%\manage.py" provision_dev_agent_ready
if errorlevel 1 echo [WARN] Development agent provisioning failed; startup will continue.
exit /b 0

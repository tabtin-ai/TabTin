@echo off
setlocal
call "%~dp0_dev-env.bat"
if not exist "%PYTHON_BIN%" (
  echo [ERROR] Missing Windows virtual environment: %PYTHON_BIN%
  exit /b 1
)
call "%~dp0_kill-port.bat" "%DJANGO_BIND_PORT%"
echo [DJANGO] Starting Daphne on http://127.0.0.1:%DJANGO_BIND_PORT% ...
powershell -NoProfile -Command "$argsList=@('-m','daphne','--ping-interval','45','--ping-timeout','60','--websocket_timeout','3600','--application-close-timeout','120','-b','0.0.0.0','-p',$env:DJANGO_BIND_PORT,'tabtin.asgi:application'); $p=Start-Process -FilePath $env:PYTHON_BIN -WorkingDirectory $env:DJANGO_DIR -ArgumentList $argsList -RedirectStandardOutput ($env:LOG_DIR+'\django-dev.log') -RedirectStandardError ($env:LOG_DIR+'\django-dev.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\django-dev.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
for /l %%I in (1,1,40) do (
  curl -fs "http://127.0.0.1:%DJANGO_BIND_PORT%/health" >nul 2>&1 && exit /b 0
  ping 127.0.0.1 -n 2 >nul
)
echo [ERROR] Django did not become healthy within 40 seconds.
exit /b 1

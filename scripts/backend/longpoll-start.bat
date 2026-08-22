@echo off
setlocal
call "%~dp0_dev-env.bat"
if not exist "%PYTHON_BIN%" exit /b 1
powershell -NoProfile -Command "$a=@($env:DJANGO_DIR+'\manage.py','run_longpoll'); $p=Start-Process -FilePath $env:PYTHON_BIN -WorkingDirectory $env:DJANGO_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\channel-longpoll.log') -RedirectStandardError ($env:LOG_DIR+'\channel-longpoll.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\channel-longpoll.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
exit /b 0

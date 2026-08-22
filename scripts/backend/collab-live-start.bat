@echo off
setlocal
call "%~dp0_dev-env.bat"
call "%~dp0_kill-port.bat" "%COLLAB_LIVE_PORT%"
set "NODE_ENV=development"
set "PORT=%COLLAB_LIVE_PORT%"
set "DJANGO_API_URL=http://127.0.0.1:%DJANGO_BIND_PORT%"
set "COLLAB_LIVE_DIR=%ROOT_DIR%\apps\collab-live"
powershell -NoProfile -Command "$a=@('exec','tsx','src/start.ts'); $p=Start-Process -FilePath 'pnpm.cmd' -WorkingDirectory $env:COLLAB_LIVE_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\collab-live.log') -RedirectStandardError ($env:LOG_DIR+'\collab-live.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\collab-live.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
exit /b 0

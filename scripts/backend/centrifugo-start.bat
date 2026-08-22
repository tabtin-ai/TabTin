@echo off
setlocal
call "%~dp0_dev-env.bat"
call "%~dp0_kill-port.bat" "%CENTRIFUGO_PORT%"
set "CENTRIFUGO_VERSION=6.6.2"
set "CENTRIFUGO_BIN=%ROOT_DIR%\scripts\backend\bin\centrifugo.exe"
set "CENTRIFUGO_CONFIG=%ROOT_DIR%\scripts\backend\centrifugo-dev.json"
if not exist "%CENTRIFUGO_BIN%" if exist "%ROOT_DIR%\scripts\bin\centrifugo.exe" (
  if not exist "%ROOT_DIR%\scripts\backend\bin" mkdir "%ROOT_DIR%\scripts\backend\bin"
  copy /Y "%ROOT_DIR%\scripts\bin\centrifugo.exe" "%CENTRIFUGO_BIN%" >nul
)
if not exist "%CENTRIFUGO_BIN%" call :install_centrifugo
if errorlevel 1 exit /b 1
echo [CENTRIFUGO] Starting on http://127.0.0.1:%CENTRIFUGO_PORT% ...
echo [CENTRIFUGO] Log: %LOG_DIR%\centrifugo.log
powershell -NoProfile -Command "$a=@('-c',$env:CENTRIFUGO_CONFIG,'--http_server.port',$env:CENTRIFUGO_PORT); $p=Start-Process -FilePath $env:CENTRIFUGO_BIN -WorkingDirectory $env:ROOT_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\centrifugo.log') -RedirectStandardError ($env:LOG_DIR+'\centrifugo.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\centrifugo.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
echo [OK] Centrifugo launch requested.
exit /b 0

:install_centrifugo
echo [CENTRIFUGO] Binary missing; downloading v%CENTRIFUGO_VERSION%...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $arch=if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {'arm64'} else {'amd64'}; $asset='centrifugo_'+$env:CENTRIFUGO_VERSION+'_windows_'+$arch+'.zip'; $dir=Split-Path $env:CENTRIFUGO_BIN; $zip=Join-Path $dir $asset; New-Item -ItemType Directory -Force -Path $dir | Out-Null; Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri ('https://github.com/centrifugal/centrifugo/releases/download/v'+$env:CENTRIFUGO_VERSION+'/'+$asset) -OutFile $zip; Expand-Archive -Path $zip -DestinationPath $dir -Force; Remove-Item $zip -Force"
if errorlevel 1 (
  echo [ERROR] Failed to install Centrifugo v%CENTRIFUGO_VERSION%.
  exit /b 1
)
if not exist "%CENTRIFUGO_BIN%" (
  echo [ERROR] Archive did not contain centrifugo.exe.
  exit /b 1
)
exit /b 0

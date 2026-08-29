@echo off
setlocal EnableExtensions
call "%~dp0_dev-env.bat"
if not exist "%PYTHON_BIN%" (
  echo [ERROR] Missing Windows virtual environment: %PYTHON_BIN%
  exit /b 1
)
call :worker critical "critical" || exit /b 1
call :worker default "default,low_priority" || exit /b 1
call :worker realtime "realtime_delivery" || exit /b 1
if /I not "%CELERY_PROFILE%"=="full" goto beat
call :worker data-ai "rag_indexing,tabdata_compute,doc_merge" || exit /b 1
call :worker heavy "heavy,media,docparse,tabdata_conversion,pptx_import_oss" || exit /b 1
call :worker ai-background "ai_background" || exit /b 1
call :worker tracker "tracker_agent" || exit /b 1
call :worker search "search_indexing" || exit /b 1
:beat
powershell -NoProfile -Command "$a=@('-m','celery','-A','tabtin','beat','-l','info','--scheduler','django_celery_beat.schedulers:DatabaseScheduler'); $p=Start-Process -FilePath $env:PYTHON_BIN -WorkingDirectory $env:DJANGO_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\celery-beat.log') -RedirectStandardError ($env:LOG_DIR+'\celery-beat.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\celery-beat.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
exit /b 0
:worker
set "CELERY_WORKER_NAME=%~1"
set "CELERY_WORKER_QUEUES=%~2"
powershell -NoProfile -Command "$a=@('-m','celery','-A','tabtin','worker','-l','info','--pool=solo','-c','1','--max-memory-per-child=512000','-Q',$env:CELERY_WORKER_QUEUES,'-n',($env:CELERY_WORKER_NAME+'@'+$env:COMPUTERNAME)); $p=Start-Process -FilePath $env:PYTHON_BIN -WorkingDirectory $env:DJANGO_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\celery-'+$env:CELERY_WORKER_NAME+'.log') -RedirectStandardError ($env:LOG_DIR+'\celery-'+$env:CELERY_WORKER_NAME+'.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\celery-'+$env:CELERY_WORKER_NAME+'.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
exit /b 0

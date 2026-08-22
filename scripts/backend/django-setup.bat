@echo off
setlocal
call "%~dp0_dev-env.bat"

set "PYTHON_LAUNCHER="
where py >nul 2>&1
if not errorlevel 1 set "PYTHON_LAUNCHER=py -3.11"

if not defined PYTHON_LAUNCHER (
  where python3.11 >nul 2>&1
  if not errorlevel 1 set "PYTHON_LAUNCHER=python3.11"
)

if not defined PYTHON_LAUNCHER (
  where python >nul 2>&1
  if not errorlevel 1 (
    for /f "usebackq delims=" %%V in (`python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2^>nul`) do (
      if "%%V"=="3.11" set "PYTHON_LAUNCHER=python"
    )
  )
)

if not defined PYTHON_LAUNCHER (
  echo [ERROR] Python 3.11 was not found.
  echo Install Python 3.11 and ensure py.exe or python.exe is available on PATH.
  exit /b 1
)

if not exist "%PYTHON_BIN%" (
  echo [SETUP] Creating Python virtual environment: %VENV_DIR%
  %PYTHON_LAUNCHER% -m venv "%VENV_DIR%"
  if errorlevel 1 exit /b 1
)

"%PYTHON_BIN%" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
"%PYTHON_BIN%" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --timeout 300 -r "%DJANGO_DIR%\requirements.txt"
if errorlevel 1 exit /b 1

echo [OK] Django dependencies are installed.
exit /b 0

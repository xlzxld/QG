@echo off
rem ==================================================================
rem  Stop the bridge service  (ASCII only, on purpose)
rem ------------------------------------------------------------------
rem  Double-click to shut down the background bridge process.
rem  Start it again with 启动.bat (or Restart Service).
rem ==================================================================

chcp 65001 >nul 2>&1

setlocal
title Stop Service

cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE (
    if exist "C:\Users\5600\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
        set "NODE_EXE=C:\Users\5600\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    )
)
if not defined NODE_EXE (
    echo.
    echo   [ERROR] Node.js not found.
    echo.
    pause
    exit /b 1
)

"%NODE_EXE%" "core\grab-launcher.mjs" --stop
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo   [OK] Service stopped.
) else (
    echo   [FAIL] Stop failed, exit code %EXITCODE%
)
echo.
pause

endlocal

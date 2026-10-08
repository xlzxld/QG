@echo off
rem ==================================================================
rem  Restart the bridge service  (ASCII only, on purpose)
rem ------------------------------------------------------------------
rem  Double-click this file after the bridge code has been changed.
rem  The bridge does NOT hot-reload: a running old process keeps the
rem  old behaviour until it is stopped and started again.
rem
rem  What it does: stop whatever listens on port 3100, then start the
rem  bridge again with the current code.
rem ==================================================================

chcp 65001 >nul 2>&1

setlocal
title Restart Service

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

"%NODE_EXE%" "scripts\grab-launcher.mjs" --restart
set "EXITCODE=%ERRORLEVEL%"

echo.
if "%EXITCODE%"=="0" (
    echo   [OK] Service restarted.
) else (
    echo   [FAIL] Restart failed, exit code %EXITCODE%
)
echo.
pause

endlocal

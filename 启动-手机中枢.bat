@echo off
rem ==================================================================
rem  Start the device hub (:3120) in THIS window  (ASCII only, on purpose)
rem ------------------------------------------------------------------
rem  Double-click to start the APP-side rush device hub.
rem  Keep this window open (or minimized) while the hub is in use.
rem  Stop it with the stop bat in this folder, or press Ctrl+C here.
rem ==================================================================

chcp 65001 >nul 2>&1

setlocal
title Device Hub (:3120)

cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
    )
)
if not defined NODE_EXE (
    if exist "C:\Users\5600\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
        set "NODE_EXE=C:\Users\5600\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    )
)
if not defined NODE_EXE (
    echo.
    echo   [ERROR] Node.js not found - the hub needs Node.js 18 or newer.
    echo           Install it first: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

"%NODE_EXE%" "core\hub-launcher.mjs" --start
set "EXITCODE=%ERRORLEVEL%"

echo.
pause

endlocal

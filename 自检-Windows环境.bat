@echo off
rem ==================================================================
rem  Windows environment self-check  (ASCII only, on purpose)
rem  Companion of the macOS self-check (check-macos-env.sh)
rem ------------------------------------------------------------------
rem  Double-click this file to run the Windows readiness check:
rem  system / winget / Node.js / Chrome / ADB / phone / deps+ports.
rem  The real logic lives in check-windows-env.mjs (Chinese output).
rem ==================================================================

chcp 65001 >nul 2>&1

setlocal
title QG Env Self-Check (Windows)

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
    echo   [ERROR] Node.js not found - the self-check needs Node.js 18 or newer.
    echo           Install it first, then double-click this file again.
    echo           Download: https://nodejs.org/  -  choose the LTS build.
    echo.
    pause
    exit /b 1
)

"%NODE_EXE%" "check-windows-env.mjs"
set "EXITCODE=%ERRORLEVEL%"

echo.
pause

endlocal

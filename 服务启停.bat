@echo off
rem ==================================================================
rem  Service control panel  (ASCII only, on purpose)
rem ------------------------------------------------------------------
rem  Double-click to open the menu (start / stop / restart / status)
rem  for the bridge (:3100) and the device hub (:3120).
rem  cmd.exe parses .bat files byte-by-byte. Any multi-byte UTF-8
rem  character (e.g. Chinese) breaks its quote/paren matching, and the
rem  remainder of the file gets executed as garbage commands.
rem  All Chinese text is printed by the Node script instead.
rem ==================================================================

rem Switch console to UTF-8 so Node output renders correctly.
chcp 65001 >nul 2>&1

setlocal
title QG Service Panel

cd /d "%~dp0"

rem ---- locate Node.js --------------------------------------------
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
    echo   Install Node.js, or add it to PATH.
    echo.
    pause
    exit /b 1
)

rem ---- Playwright browser cache ----------------------------------
if not defined PLAYWRIGHT_BROWSERS_PATH (
    set "PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright"
)

rem ---- run -------------------------------------------------------
"%NODE_EXE%" "core\service-menu.mjs" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo   [INFO] launcher exited with code %EXITCODE%
    echo.
    pause
)

endlocal

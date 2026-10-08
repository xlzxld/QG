@echo off
rem ==================================================================
rem  Windows double-click stopper: QG grab hub (device-hub :3120)
rem  (ASCII only on purpose, same convention as Stop Service)
rem ------------------------------------------------------------------
rem  1) Preferred: kill the PID recorded in data\grab\device-hub.pid
rem  2) Fallback: kill every node.exe whose command line runs
rem     core\device-hub.mjs (covers a stale/missing PID file)
rem ==================================================================

chcp 65001 >nul 2>&1

setlocal enabledelayedexpansion
title Stop QG Grab Hub

cd /d "%~dp0"

echo.
echo   Stopping QG grab hub...

set "STOPPED=0"

rem ---- 1) via PID file ----
if exist "data\grab\device-hub.pid" (
    set /p HUBPID=<"data\grab\device-hub.pid"
    if defined HUBPID (
        tasklist /FI "PID eq !HUBPID!" 2>nul | find /I "node.exe" >nul 2>&1
        if not errorlevel 1 (
            taskkill /PID !HUBPID! /T /F >nul 2>&1
            echo   [OK] Stopped hub process PID !HUBPID!
            set "STOPPED=1"
        )
    )
)

rem ---- 2) fallback: by command line ----
for /f "tokens=2 delims=," %%p in (
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $_.CommandLine -match ''device-hub\.mjs'' } | ForEach-Object { $_.ProcessId }" 2^>nul'
) do (
    taskkill /PID %%p /T /F >nul 2>&1
    echo   [OK] Stopped leftover hub process PID %%p
    set "STOPPED=1"
)

rem ---- cleanup PID file ----
if exist "data\grab\device-hub.pid" del /q "data\grab\device-hub.pid" >nul 2>&1

if "!STOPPED!"=="0" (
    echo   [i] Grab hub is not running.
)

echo.
pause

endlocal

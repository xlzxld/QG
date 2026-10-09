@echo off
chcp 936 >nul 2>&1
rem ==================================================================
rem  开启局域网访问（手机 <-> 电脑互通）—— 需要管理员权限
rem  作用：放行 TCP 3120（手机中枢），让手机通过 Wi-Fi 访问电脑。
rem  用法：右键本文件 →「以管理员身份运行」→ 弹窗点「是」。
rem ==================================================================
title 开启局域网访问（需管理员）

net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [提示] 需要管理员权限！
    echo   请：右键本文件，选择「以管理员身份运行」，弹窗点「是」。
    echo.
    pause
    exit /b 1
)

echo.
echo   正在放行 TCP 3120（手机中枢，覆盖 域/专用/公用 所有网络类型）...
netsh advfirewall firewall delete rule name="QG-Hub-3120" >nul 2>&1
netsh advfirewall firewall add rule name="QG-Hub-3120" dir=in action=allow protocol=TCP localport=3120 profile=any
echo.
if errorlevel 1 (
    echo   [FAIL] 放行失败，请把本窗口截图给助手。
) else (
    echo   [OK] 已放行。现在手机浏览器打开 http://电脑IP:3120 就能看到中枢页面。
)
echo.
pause

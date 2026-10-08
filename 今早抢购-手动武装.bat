@echo off
rem ==================================================================
rem  今早华为抢购 · 手动武装定时（可选双保险）
rem  武装后：09:40 登录预检 / 09:55 自动派发（脱管定时，可关闭本窗口）
rem  说明：系统里另挂有 09:55 自动派发 + 10:03 兜底守卫，不双击本文件也照跑。
rem  请在 09:40 之前双击本文件，过点后定时器会提示"目标时刻已过"。
rem ==================================================================
chcp 65001 >nul 2>&1
setlocal
title 今早抢购武装（华为三槽位）
cd /d "%~dp0"

echo.
echo ============================================================
echo   给今早的华为抢购装上定时（脱管运行，可关本窗口）
echo ============================================================
echo.
echo   [1/3] 快速检查（桥接 / 槽位闸门 / 驱动状态）...
echo.
node tools\dispatch-huawei.mjs --plan
echo.
echo   [2/3] 挂 09:40 登录预检定时...
start "qg-0940-check" /min cmd /c "node core\deferred-timers.mjs 09:40 tools\check-slot-logins.mjs data\grab\timer-0940-check.log"
echo   [3/3] 挂 09:55 自动派发定时...
start "qg-0955-dispatch" /min cmd /c "node core\deferred-timers.mjs 09:55 tools\dispatch-huawei.mjs data\grab\timer-0955-dispatch.log"
echo.
echo ============================================================
echo   已武装完成！两个定时窗口已最小化到任务栏（别关它们）。
echo   · 09:40 预检三个槽位登录（日志 data\grab\timer-0940-check.log）
echo   · 09:55 自动派发驱动（日志 data\grab\timer-0955-dispatch.log）
echo   · 10:08 三款同时开售：Mate 90 Pro Max / Mate XT 2 / Pura X View
echo.
echo   提示：如果 9 点前电脑重启过，请重新双击本文件武装一次。
echo.
pause
endlocal

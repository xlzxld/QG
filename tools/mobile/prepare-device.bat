@echo off
chcp 65001 >nul
echo 正在运行 Android 真机整备脚本...
node "%~dp0prepare-device.mjs"
pause

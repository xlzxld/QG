@echo off
chcp 936 >nul 2>&1
echo 正在运行 Android 真机整备脚本...
node "%~dp0prepare-device.mjs"
pause

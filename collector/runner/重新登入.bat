@echo off
rem Re-login helper for the background collector (county version).
rem Double-click this file when the screen says the ttfd2 login has expired.
chcp 65001 >nul
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" runner.js --setup --county --profile profile
echo.
pause

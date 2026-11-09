@echo off
rem Background collector launcher for Windows Task Scheduler.
rem Output of each run goes to logs\scheduler-out.log
cd /d "%~dp0"
if not exist logs mkdir logs
rem County (all units) collector, using the already logged-in folder "profile".
"C:\Program Files\nodejs\node.exe" runner.js --county --profile profile >> logs\scheduler-out.log 2>&1
exit /b %ERRORLEVEL%

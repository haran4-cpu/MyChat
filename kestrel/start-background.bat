@echo off
rem Starts Kestrel without a console window (for use from Open WebUI). Stop it from Task Manager (pythonw.exe) or stop-kestrel.bat.
cd /d "%~dp0"
set PYW=C:\Python314\pythonw.exe
if not exist "%PYW%" set PYW=pyw -3
start "" %PYW% -m kestrel serve --no-browser
echo Kestrel is running in the background at http://127.0.0.1:8765
timeout /t 3 >nul

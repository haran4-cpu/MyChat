@echo off
rem Restarts Kestrel (used after an update). Kills whatever listens on 8765, waits until the port is free, starts again.
cd /d "%~dp0"
timeout /t 3 /nobreak >nul
for /l %%i in (1,1,5) do (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:8765" ^| findstr LISTENING') do taskkill /PID %%p /F /T >nul 2>&1
  netstat -ano | findstr "127.0.0.1:8765" | findstr LISTENING >nul || goto start
  timeout /t 2 /nobreak >nul
)
:start
set PYW=C:\Python314\pythonw.exe
if not exist "%PYW%" set PYW=pyw -3
start "" %PYW% -m kestrel serve --no-browser
echo %date% %time% restarted>> "%~dp0logs\restart.log"

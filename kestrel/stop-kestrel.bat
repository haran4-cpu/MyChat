@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:8765" ^| findstr LISTENING') do taskkill /PID %%p /F
echo Kestrel stopped.
timeout /t 3 >nul

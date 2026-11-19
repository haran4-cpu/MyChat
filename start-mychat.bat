@echo off
rem Starts the MyChat gateway in the background on http://127.0.0.1:11500 (keys: %APPDATA%\MyChat)
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODEFOUND (set "NODE=%%n" & set NODEFOUND=1)
if not exist "%NODE%" (echo Node.js was not found. Install it from https://nodejs.org and run this again. & pause & exit /b 1)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:11500" ^| findstr LISTENING') do taskkill /PID %%p /F >NUL 2>&1
start "MyChat gateway" /min "%NODE%" pc\server.mjs
echo MyChat gateway started: http://127.0.0.1:11500/connections
timeout /t 3 >nul

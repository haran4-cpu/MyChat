@echo off
title Kestrel - full verification (log: logs\verify.log)
cd /d "%~dp0"
if not exist logs mkdir logs
set PY=C:\Python314\python.exe
if not exist "%PY%" set PY=py -3
set PYTHONIOENCODING=utf-8
set LOG=logs\verify.log
echo === %DATE% %TIME% === > %LOG%
echo [1/4] setup-models >> %LOG%
%PY% -u -m kestrel setup-models >> %LOG% 2>&1
echo [2/4] doctor >> %LOG%
%PY% -u -m kestrel doctor >> %LOG% 2>&1
echo [3/4] offline tests >> %LOG%
%PY% -u tests\test_kestrel.py >> %LOG% 2>&1
echo [4/4] live smoke test >> %LOG%
%PY% -u -m kestrel smoke >> %LOG% 2>&1
echo === DONE exit %ERRORLEVEL% === >> %LOG%
type %LOG%
pause

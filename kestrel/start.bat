@echo off
title Kestrel
cd /d "%~dp0"
set PY=C:\Python314\python.exe
if not exist "%PY%" set PY=py -3
%PY% -m kestrel serve
pause

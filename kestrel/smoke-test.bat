@echo off
title Kestrel live test
cd /d "%~dp0"
set PY=C:\Python314\python.exe
if not exist "%PY%" set PY=py -3
echo Live test with your real local model. Ollama must be running. This takes a few minutes on CPU.
%PY% -m kestrel smoke
pause

@echo off
title Kestrel setup
cd /d "%~dp0"
set PY=C:\Python314\python.exe
if not exist "%PY%" set PY=py -3
echo === Creating the kestrel-* model profiles in Ollama (uses the models you already have, no download) ===
%PY% -m kestrel setup-models
echo.
echo === Checking the installation ===
%PY% -m kestrel doctor
echo.
echo === Running the offline test suite ===
%PY% tests\test_kestrel.py
pause

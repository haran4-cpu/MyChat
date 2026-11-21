@echo off
setlocal
pushd "%~dp0" || exit /b 1
node tools\repair-lab.mjs %*
set "labExit=%errorlevel%"
popd
if "%~1"=="" pause
exit /b %labExit%

# Restarts Open WebUI through Codex's launcher (keeps the session key, env and data folder).
$log = 'C:\AI-Workspace\Kestrel\logs\openwebui-upgrade.log'
Add-Content $log "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') restart requested"
Get-Process | Where-Object { $_.Path -and ($_.Path -like "*\uv\tools\open-webui\*" -or $_.Path -like "*\.local\bin\open-webui.exe") } | Stop-Process -Force
for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) { break }; Start-Sleep 1 }
& powershell -ExecutionPolicy Bypass -File 'C:\Users\user\Documents\Codex\2026-11-14\x20\outputs\Start-Local-AI.ps1' -NoBrowser
Add-Content $log "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') restart done (exit $LASTEXITCODE)"

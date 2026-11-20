# Upgrades Open WebUI (uv tool install) with a full data backup and automatic rollback.
# Usage: powershell -ExecutionPolicy Bypass -File upgrade-openwebui.ps1 [-Version 0.13.4]
param([string]$Version = '0.13.4')
$ErrorActionPreference = 'Continue'
$log = 'C:\AI-Workspace\Kestrel\logs\openwebui-upgrade.log'
function Log($m) { $l = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Add-Content -Path $log -Value $l -Encoding utf8 }
$py = 'C:\Python314\python.exe'
$venvPy = "$env:APPDATA\uv\tools\open-webui\Scripts\python.exe"
$data = 'C:\Users\user\Documents\Codex\LocalAI\OpenWebUIData'
$starter = 'C:\Users\user\Documents\Codex\2026-11-14\x20\outputs\Start-Local-AI.ps1'
function Ver { try { (& $venvPy -c "import importlib.metadata as m;print(m.version('open-webui'))" 2>$null).Trim() } catch { '' } }
function StopWebUI {
  Get-Process | Where-Object { $_.Path -and ($_.Path -like "*\uv\tools\open-webui\*" -or $_.Path -like "*\.local\bin\open-webui.exe") } | ForEach-Object { Log "stop PID $($_.Id) $($_.Path)"; Stop-Process -Id $_.Id -Force }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue)) { return }; Start-Sleep 1 }
}
$old = Ver
Log "=== upgrade start: installed $old -> target $Version"
if ($old -eq $Version) { Log "already at $Version; nothing to do"; exit 0 }
StopWebUI
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak = "C:\Users\user\Documents\Codex\LocalAI\Backups\OpenWebUIData-$old-$stamp"
robocopy $data $bak /E /R:2 /W:2 /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Log "BACKUP FAILED (robocopy $LASTEXITCODE); aborting, restarting the old version"; & powershell -ExecutionPolicy Bypass -File $starter -NoBrowser; exit 1 }
Log "backup ok: $bak"
$out = & $py -m uv tool install "open-webui==$Version" --python 3.12 --force 2>&1 | Out-String
Log ($out.Trim() -split "`n" | Select-Object -Last 6 | Out-String).Trim()
$new = Ver
if ($new -ne $Version) {
  Log "UPGRADE FAILED (now '$new'); rolling back to $old"
  & $py -m uv tool install "open-webui==$old" --python 3.12 --force 2>&1 | Out-Null
  Log "rolled back: $(Ver)"
}
Log "starting Open WebUI ($(Ver)) - first start after an upgrade runs database migrations"
& powershell -ExecutionPolicy Bypass -File $starter -NoBrowser
Log "start script exit $LASTEXITCODE"
try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/version' -TimeoutSec 10; Log "running version: $($h.version)" } catch { Log "version check failed: $_" }
Log "=== done"

# OpenClaw Node Watchdog — runs every 5 minutes via Scheduled Task
# Checks if the openclaw node process is alive, restarts if dead

$logFile = "$env:USERPROFILE\.openclaw\watchdog.log"

# Find any node.exe running openclaw node
$nodeProc = $null
Get-Process node -EA SilentlyContinue | ForEach-Object {
    try {
        $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
        if ($cl -like "*openclaw*" -and $cl -like "*node*run*") {
            $nodeProc = $_
        }
    } catch {}
}

if ($nodeProc) {
    # Node is running, nothing to do
    exit 0
}

# Node is dead — check if launch-node.ps1 is running (might be in backoff sleep)
$launcherRunning = $false
Get-Process powershell -EA SilentlyContinue | ForEach-Object {
    try {
        $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
        if ($cl -like "*launch-node*") {
            $launcherRunning = $true
        }
    } catch {}
}

if ($launcherRunning) {
    # Launcher is running but node isn't — launcher is probably in backoff, let it handle it
    exit 0
}

# Neither node nor launcher is running — restart via Scheduled Task
Add-Content $logFile "[$(Get-Date)] Node dead, launcher dead. Restarting OpenClaw-Node task."
schtasks /Run /TN "OpenClaw-Node" 2>&1 | Out-Null

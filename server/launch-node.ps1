$env:OPENCLAW_GATEWAY_TOKEN = "606382b23cccd95064bf60d097f766df9accf6c8ce4823df"
$logDir = "$env:USERPROFILE\.openclaw"
$failCount = 0
$HEALTH_CHECK_INTERVAL_SEC = 300  # 5 minutes
$HEALTH_FAIL_THRESHOLD = 3       # 3 consecutive failures = restart

# Kill any leftover openclaw node processes
Get-Process node -EA SilentlyContinue | ForEach-Object {
    try {
        $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
        if ($cl -like "*openclaw*") { Stop-Process -Id $_.Id -Force -EA SilentlyContinue }
    } catch {}
}
Start-Sleep -Seconds 2

function Test-NodeHealth {
    # Check if gateway sees us as connected by querying Tailscale endpoint
    try {
        $resp = Invoke-RestMethod -Uri "https://wenzhelin-minimac-mini.tail2ef762.ts.net/api/health" `
            -Headers @{ "Authorization" = "Bearer $env:OPENCLAW_GATEWAY_TOKEN" } `
            -TimeoutSec 10 -ErrorAction Stop
        return $true
    } catch {
        # Fallback: just check if our WSS TCP connection is alive and sending data
        try {
            $nodeName = $env:COMPUTERNAME.ToLower()
            $resp = Invoke-WebRequest -Uri "https://wenzhelin-minimac-mini.tail2ef762.ts.net/" `
                -TimeoutSec 10 -UseBasicParsing -ErrorAction Stop
            return ($resp.StatusCode -eq 200)
        } catch {
            return $false
        }
    }
}

while ($true) {
    $start = Get-Date
    $proc = Start-Process -FilePath "C:\\nvm4w\\nodejs\\node.exe" -ArgumentList '"C:\\nvm4w\\nodejs\\node_modules\\openclaw\\openclaw.mjs" node run --host "wenzhelin-minimac-mini.tail2ef762.ts.net" --port 443 --tls --display-name "' + $env:COMPUTERNAME.ToLower() + '"' -PassThru -WindowStyle Hidden

    if (-not $proc) {
        Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Failed to start node process")
        $failCount++
        if ($failCount -ge 5) {
            Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] 5x rapid failures. Stopped.")
            exit 1
        }
        Start-Sleep -Seconds 10
        continue
    }

    Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Node started (PID: $($proc.Id))")

    # Monitor loop: check health periodically while process is running
    $healthFailCount = 0
    $lastHealthCheck = Get-Date

    while (-not $proc.HasExited) {
        # Wait in small intervals so we notice process exit quickly
        $proc.WaitForExit(30000)  # 30 second intervals
        
        if ($proc.HasExited) { break }
        
        # Health check every HEALTH_CHECK_INTERVAL_SEC
        if (((Get-Date) - $lastHealthCheck).TotalSeconds -ge $HEALTH_CHECK_INTERVAL_SEC) {
            $lastHealthCheck = Get-Date
            
            # Check if the TCP connection to gateway is still alive
            $tcpOk = $false
            try {
                $conns = netstat -ano 2>$null | Select-String "$($proc.Id)" | Select-String "ESTABLISHED" | Select-String "443"
                $tcpOk = ($conns -ne $null -and $conns.Count -gt 0)
            } catch {}
            
            if (-not $tcpOk) {
                $healthFailCount++
                Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Health check failed ($healthFailCount/$HEALTH_FAIL_THRESHOLD): no TCP connection to gateway")
            } else {
                # TCP alive - also check gateway can reach us
                $gatewayOk = Test-NodeHealth
                if ($gatewayOk) {
                    $healthFailCount = 0  # Reset on success
                } else {
                    $healthFailCount++
                    Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Health check failed ($healthFailCount/$HEALTH_FAIL_THRESHOLD): TCP alive but gateway unreachable")
                }
            }
            
            if ($healthFailCount -ge $HEALTH_FAIL_THRESHOLD) {
                Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Stale connection detected. Killing PID $($proc.Id)")
                try { Stop-Process -Id $proc.Id -Force -EA SilentlyContinue } catch {}
                Start-Sleep -Seconds 3
                break
            }
        }
    }

    # Process exited or was killed
    $runtime = ((Get-Date) - $start).TotalSeconds
    Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Node exited after $([math]::Round($runtime))s")
    
    if ($runtime -lt 30) { $failCount++ } else { $failCount = 0 }
    if ($failCount -ge 5) {
        Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Crashed 5x rapidly. Stopped.")
        exit 1
    }
    Start-Sleep -Seconds 5
}

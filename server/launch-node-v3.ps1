$env:OPENCLAW_GATEWAY_TOKEN = "606382b23cccd95064bf60d097f766df9accf6c8ce4823df"
$logDir = "$env:USERPROFILE\.openclaw"
$failCount = 0
$HEALTH_CHECK_INTERVAL_SEC = 300  # 5 minutes
$HEALTH_FAIL_THRESHOLD = 3       # 3 consecutive failures = restart

if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

# Kill any leftover openclaw node processes
Get-Process node -EA SilentlyContinue | ForEach-Object {
    try {
        $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
        if ($cl -like "*openclaw*") { Stop-Process -Id $_.Id -Force -EA SilentlyContinue }
    } catch {}
}
Start-Sleep -Seconds 2

function Test-NodeHealth {
    try {
        $resp = Invoke-RestMethod -Uri "https://wenzhelin-minimac-mini.tail2ef762.ts.net/api/health" `
            -Headers @{ "Authorization" = "Bearer $env:OPENCLAW_GATEWAY_TOKEN" } `
            -TimeoutSec 10 -ErrorAction Stop
        return $true
    } catch {
        try {
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
    $displayName = $env:COMPUTERNAME.ToLower()
    $nodeArgs = "`"C:\nvm4w\nodejs\node_modules\openclaw\openclaw.mjs`" node run --host `"wenzhelin-minimac-mini.tail2ef762.ts.net`" --port 443 --tls --display-name `"$displayName`""
    $proc = $null

    try {
        $proc = Start-Process -FilePath "C:\nvm4w\nodejs\node.exe" -ArgumentList $nodeArgs -PassThru -WindowStyle Hidden -ErrorAction Stop
    } catch {
        Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Failed to start node process: $($_.Exception.Message)")
    }

    if (-not $proc) {
        $failCount++
        # Exponential backoff: 10s, 20s, 40s, 80s, 160s, max 300s (5 min)
        $backoff = [math]::Min(300, 10 * [math]::Pow(2, $failCount - 1))
        Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Start failed ($failCount). Backing off ${backoff}s.")
        Start-Sleep -Seconds $backoff
        continue
    }

    # Reset fail count on successful start
    $failCount = 0
    Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Node started (PID: $($proc.Id))")

    # Monitor loop: check health periodically while process is running
    $healthFailCount = 0
    $lastHealthCheck = Get-Date

    while (-not $proc.HasExited) {
        $proc.WaitForExit(30000)  # 30 second intervals
        
        if ($proc.HasExited) { break }
        
        # Health check every HEALTH_CHECK_INTERVAL_SEC
        if (((Get-Date) - $lastHealthCheck).TotalSeconds -ge $HEALTH_CHECK_INTERVAL_SEC) {
            $lastHealthCheck = Get-Date
            
            $tcpOk = $false
            try {
                $conns = netstat -ano 2>$null | Select-String "^\s*TCP\s+\S+\s+\S+:443\s+ESTABLISHED\s+$($proc.Id)\s*$"
                $tcpOk = ($conns -ne $null -and $conns.Count -gt 0)
            } catch {}
            
            if (-not $tcpOk) {
                $healthFailCount++
                Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Health check failed ($healthFailCount/$HEALTH_FAIL_THRESHOLD): no TCP connection to gateway")
            } else {
                $gatewayOk = Test-NodeHealth
                if ($gatewayOk) {
                    $healthFailCount = 0
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
    
    # Exponential backoff on rapid failures, but NEVER give up
    if ($runtime -lt 30) {
        $failCount++
        $backoff = [math]::Min(300, 10 * [math]::Pow(2, $failCount - 1))
        Add-Content "$logDir\node-crash.log" ("[" + (Get-Date) + "] Rapid exit ($failCount). Backing off ${backoff}s.")
        Start-Sleep -Seconds $backoff
    } else {
        $failCount = 0
        Start-Sleep -Seconds 5
    }
}

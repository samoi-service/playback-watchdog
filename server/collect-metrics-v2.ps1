param(
    [string]$ServerUrl = "http://100.106.81.54:9100/metrics",
    [string]$NodeName = "",
    [int]$IntervalSec = 30
)

if (-not $NodeName) { $NodeName = $env:COMPUTERNAME.ToLower() }

# --- Node Watchdog: ensure openclaw node is alive every cycle ---
function Ensure-NodeAlive {
    $nodeProc = $null
    Get-Process node -EA SilentlyContinue | ForEach-Object {
        try {
            $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
            if ($cl -like "*openclaw*" -and $cl -like "*node*run*") { $nodeProc = $_ }
        } catch {}
    }
    if ($nodeProc) { return }

    # Node is dead — check if launcher is running (in backoff sleep)
    $launcherAlive = $false
    Get-Process powershell -EA SilentlyContinue | ForEach-Object {
        try {
            $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
            if ($cl -like "*launch-node*") { $launcherAlive = $true }
        } catch {}
    }
    if ($launcherAlive) { return }

    # Both dead — restart via Scheduled Task
    Add-Content "$env:USERPROFILE\.openclaw\watchdog.log" "[$(Get-Date)] Collector watchdog: node+launcher dead, restarting OpenClaw-Node"
    schtasks /Run /TN "OpenClaw-Node" 2>&1 | Out-Null
}

# --- Metrics Collection ---
function Get-Metrics {
    $ts = [int][double]::Parse((Get-Date -UFormat %s))
    $cpu = (Get-CimInstance Win32_Processor -EA SilentlyContinue | Measure-Object -Property LoadPercentage -Average).Average
    $os = Get-CimInstance Win32_OperatingSystem -EA SilentlyContinue
    $ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1024, 0)
    $ramFree = [math]::Round($os.FreePhysicalMemory / 1024, 0)
    $ramUsed = $ramTotal - $ramFree
    $ramPct = if ($ramTotal -gt 0) { [math]::Round($ramUsed / $ramTotal * 100, 1) } else { 0 }

    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" -EA SilentlyContinue
    $diskTotal = if ($disk) { [math]::Round($disk.Size / 1GB, 1) } else { 0 }
    $diskFree = if ($disk) { [math]::Round($disk.FreeSpace / 1GB, 1) } else { 0 }
    $diskPct = if ($diskTotal -gt 0) { [math]::Round(($diskTotal - $diskFree) / $diskTotal * 100, 1) } else { 0 }

    $uptime = (Get-Date) - $os.LastBootUpTime
    $uptimeH = [math]::Round($uptime.TotalHours, 1)

    # GPU (nvidia-smi)
    $gpuName = ""; $gpuPct = $null; $gpuTemp = $null
    try {
        $smi = & "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe" --query-gpu=name,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null
        if (-not $smi) { $smi = & nvidia-smi --query-gpu=name,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null }
        if ($smi) {
            $parts = $smi.Split(',').Trim()
            $gpuName = $parts[0]
            $gpuPct = [double]$parts[1]
            $gpuTemp = [double]$parts[2]
        }
    } catch {}

    # Network (bytes delta — simplified)
    $netSend = 0; $netRecv = 0
    try {
        $adapters = Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -EA SilentlyContinue | Where-Object { $_.BytesTotalPersec -gt 0 }
        foreach ($a in $adapters) {
            $netSend += $a.BytesSentPersec
            $netRecv += $a.BytesReceivedPersec
        }
    } catch {}

    # Processes (top 5 by CPU)
    $procs = @()
    try {
        $procs = Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object {
            @{ name = $_.ProcessName; pid = $_.Id; cpu = [math]::Round($_.CPU, 1); ram_mb = [math]::Round($_.WorkingSet64 / 1MB, 0) }
        }
    } catch {}

    # MPVServer status
    $mpvserver = @{ process_count = 0; instances = @() }
    try {
        $mpvProcs = Get-Process MPVServer -EA SilentlyContinue
        $mpvserver.process_count = if ($mpvProcs) { @($mpvProcs).Count } else { 0 }
        if ($mpvserver.process_count -gt 0) {
            $listeners = netstat -ano 2>$null | Select-String "LISTENING" | Where-Object { $_ -match ":(\d{4,5})\s+.*\s+(\d+)\s*$" }
            foreach ($p in $mpvProcs) {
                $ports = $listeners | Where-Object { $_ -match "\s$($p.Id)\s*$" } | ForEach-Object {
                    if ($_ -match ":(\d{4,5})\s") { $Matches[1] }
                }
                foreach ($port in $ports) {
                    $listenLine = netstat -ano 2>$null | Select-String ":$port\s+.*LISTENING\s+$($p.Id)" | Select-Object -First 1
                    $addr = ""
                    if ($listenLine -match "TCP\s+(\S+):$port") { $addr = $Matches[1] }
                    $mpvserver.instances += @{ port = [int]$port; pid = $p.Id; listening = $true; listen_addr = $addr }
                }
            }
        }
    } catch {}

    return @{
        timestamp  = $ts
        node       = $NodeName
        cpu_percent = $cpu
        ram_percent = $ramPct
        ram_used_mb = $ramUsed
        ram_total_mb = $ramTotal
        gpu_name    = $gpuName
        gpu_percent = $gpuPct
        gpu_temp_c  = $gpuTemp
        disk_percent = $diskPct
        disk_free_gb = $diskFree
        disk_total_gb = $diskTotal
        net_send_bps = $netSend
        net_recv_bps = $netRecv
        uptime_hours = $uptimeH
        processes   = $procs
        mpvserver   = $mpvserver
    }
}

# --- Command Execution ---
function Exec-Command($cmd) {
    $action = $cmd.action
    $result = "unknown_action"
    switch ($action) {
        "start_mpvserver" {
            try {
                Start-Process "C:\Program Files\MPVServer\MPVServer.exe" -EA SilentlyContinue
                $result = "started"
            } catch { $result = "error: $_" }
        }
        "stop_mpvserver" {
            Get-Process MPVServer -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
            Get-Process mpv -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
            $result = "stopped"
        }
        "restart_node" {
            # Kill existing node processes, let launcher or watchdog restart
            Get-Process node -EA SilentlyContinue | ForEach-Object {
                try {
                    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
                    if ($cl -like "*openclaw*") { Stop-Process -Id $_.Id -Force -EA SilentlyContinue }
                } catch {}
            }
            # Also kill launcher so it restarts fresh
            Get-Process powershell -EA SilentlyContinue | ForEach-Object {
                try {
                    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -EA SilentlyContinue).CommandLine
                    if ($cl -like "*launch-node*") { Stop-Process -Id $_.Id -Force -EA SilentlyContinue }
                } catch {}
            }
            Start-Sleep -Seconds 2
            schtasks /Run /TN "OpenClaw-Node" 2>&1 | Out-Null
            $result = "node_restarted"
        }
        "exec_ps" {
            # Execute arbitrary PowerShell from base64 payload
            if ($cmd.payload) {
                try {
                    $script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($cmd.payload))
                    $output = Invoke-Expression $script 2>&1 | Out-String
                    $result = "exec_ok: $($output.Substring(0, [math]::Min(500, $output.Length)))"
                } catch { $result = "exec_error: $_" }
            } else { $result = "no_payload" }
        }
        "update_collector" {
            # Self-update: overwrite this script with new version from base64 payload
            if ($cmd.payload) {
                try {
                    $bytes = [Convert]::FromBase64String($cmd.payload)
                    $myPath = "$env:USERPROFILE\.openclaw\collect-metrics.ps1"
                    [IO.File]::WriteAllBytes($myPath, $bytes)
                    $result = "updated_$($bytes.Length)_bytes"
                    # Will take effect on next scheduled task cycle
                } catch { $result = "update_error: $_" }
            } else { $result = "no_payload" }
        }
    }
    # Report result back
    try {
        $body = @{ node = $NodeName; command_result = @{ action = $action; result = $result; ts = [int][double]::Parse((Get-Date -UFormat %s)) } } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $ServerUrl -Method POST -Body $body -ContentType "application/json" -TimeoutSec 5 -EA SilentlyContinue | Out-Null
    } catch {}
}

# --- Main Loop ---
while ($true) {
    try {
        # 1. Node watchdog check
        Ensure-NodeAlive

        # 2. Collect and send metrics
        $metrics = Get-Metrics
        $json = $metrics | ConvertTo-Json -Depth 3 -Compress
        $response = Invoke-RestMethod -Uri $ServerUrl -Method POST -Body $json -ContentType "application/json" -TimeoutSec 10 -EA Stop

        # 3. Handle commands from server
        if ($response.command) {
            Exec-Command $response.command
        }
    } catch {
        # Log errors but keep running
        Add-Content "$env:USERPROFILE\.openclaw\collector-error.log" "[$(Get-Date)] $_"
    }

    Start-Sleep -Seconds $IntervalSec
}

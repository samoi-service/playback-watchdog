# repair.ps1 - Force restart the agent service
$ServiceName = 'OpenClawPlayerAgent'
Write-Host 'Repairing OpenClaw Player Agent...'
Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
Start-Service -Name $ServiceName
Write-Host 'Agent restarted.'

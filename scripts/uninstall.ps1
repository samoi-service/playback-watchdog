# uninstall.ps1 - OpenClaw Player Agent Uninstaller
$ServiceName = 'OpenClawPlayerAgent'
$InstallDir = 'C:\Program Files\OpenClawPlayerAgent'

Write-Host 'Stopping and removing service...'
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & "$InstallDir\$ServiceName.exe" uninstall 2>&1 | Out-Null
    Write-Host 'Service removed.'
} else {
    Write-Host 'Service not found.'
}

Write-Host 'Note: Config and logs at C:\ProgramData\OpenClawPlayerAgent\ are preserved.'
Write-Host 'Remove manually if no longer needed.'

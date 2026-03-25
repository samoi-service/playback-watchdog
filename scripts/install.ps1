# install.ps1 - OpenClaw Player Agent Installer
# Run as Administrator

$ErrorActionPreference = 'Stop'
$InstallDir = 'C:\Program Files\OpenClawPlayerAgent'
$DataDir = 'C:\ProgramData\OpenClawPlayerAgent'
$ServiceName = 'OpenClawPlayerAgent'
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe'

Write-Host '=== OpenClaw Player Agent Installer ===' -ForegroundColor Cyan

# 1. Create directories
foreach ($dir in @($InstallDir, "$DataDir\config", "$DataDir\logs", "$DataDir\runtime")) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
Write-Host '[1/6] Directories created' -ForegroundColor Green

# 2. Copy agent files
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$ScriptDir\..\dist\*" $InstallDir -Recurse -Force
Copy-Item "$ScriptDir\..\package.json" $InstallDir -Force
Write-Host '[2/6] Agent files copied' -ForegroundColor Green

# 3. Install node_modules in install dir
Push-Location $InstallDir
& npm install --production 2>&1 | Out-Null
Pop-Location
Write-Host '[3/6] Dependencies installed' -ForegroundColor Green

# 4. Download WinSW if not present
$WinSWPath = "$InstallDir\$ServiceName.exe"
if (-not (Test-Path $WinSWPath)) {
    Write-Host 'Downloading WinSW...' -ForegroundColor Yellow
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $WinSWPath -UseBasicParsing
}
Copy-Item "$ScriptDir\..\winsw\$ServiceName.xml" $InstallDir -Force
Write-Host '[4/6] WinSW configured' -ForegroundColor Green

# 5. Copy example config if no config exists
if (-not (Test-Path "$DataDir\config\agent.json")) {
    Copy-Item "$ScriptDir\..\config\agent.example.json" "$DataDir\config\agent.json" -Force
    Write-Host '[!] Config copied from example. Edit C:\ProgramData\OpenClawPlayerAgent\config\agent.json before starting!' -ForegroundColor Yellow
}
Write-Host '[5/6] Config ready' -ForegroundColor Green

# 6. Remove old scheduled tasks and install service
$oldTasks = @('OpenClaw-Monitor', 'OpenClaw-Node')
foreach ($task in $oldTasks) {
    $exists = schtasks.exe /Query /TN $task 2>&1
    if ($LASTEXITCODE -eq 0) {
        schtasks.exe /Delete /TN $task /F 2>&1 | Out-Null
        Write-Host "  Removed old task: $task" -ForegroundColor DarkYellow
    }
}

# Stop existing service if running
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & "$WinSWPath" uninstall 2>&1 | Out-Null
    Start-Sleep -Seconds 2
}

# Install and start service
Push-Location $InstallDir
& ".\$ServiceName.exe" install
& ".\$ServiceName.exe" start
Pop-Location
Write-Host '[6/6] Service installed and started' -ForegroundColor Green

Write-Host ''
Write-Host '=== Installation complete ===' -ForegroundColor Cyan
Write-Host "Service: $ServiceName"
Write-Host "Install: $InstallDir"
Write-Host "Config:  $DataDir\config\agent.json"
Write-Host "Logs:    $DataDir\logs\"

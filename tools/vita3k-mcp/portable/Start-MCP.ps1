[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$mcpRoot = $PSScriptRoot
$configPath = Join-Path $mcpRoot 'config\mcp-config.json'
$nodePath = Join-Path $mcpRoot 'runtime\node.exe'
$entryPath = Join-Path $mcpRoot 'server\dist\http.js'
$pidPath = Join-Path $mcpRoot 'mcp-host.pid'
$logsPath = Join-Path $mcpRoot 'logs'

foreach ($required in @($configPath, $nodePath, $entryPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Vita3K MCP deployment is incomplete: $required"
    }
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$healthUrl = "http://$($config.host):$($config.port)/health"

try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    if ($health.ok) {
        Write-Output "Vita3K MCP is already running at http://$($config.host):$($config.port)/mcp"
        exit 0
    }
} catch {
    # The host is not running yet.
}

New-Item -ItemType Directory -Path $logsPath -Force | Out-Null
$env:VITA3K_MCP_HTTP_HOST = [string]$config.host
$env:VITA3K_MCP_HTTP_PORT = [string]$config.port
$env:VITA3K_EXECUTABLE = [string]$config.executable
$env:VITA3K_MCP_REPO_ROOT = [string]$config.sourceRoot
$env:VITA3K_MCP_TOOL_ROOT = Join-Path $mcpRoot '.tools'
$env:VITA3K_MCP_STATE_ROOT = Join-Path $mcpRoot '.vita3k-mcp'

$process = Start-Process -FilePath $nodePath -ArgumentList @($entryPath) `
    -WorkingDirectory (Join-Path $mcpRoot 'server') -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logsPath 'http-host.stdout.log') `
    -RedirectStandardError (Join-Path $logsPath 'http-host.stderr.log')
[System.IO.File]::WriteAllText($pidPath, [string]$process.Id)

$ready = $false
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 100
    if ($process.HasExited) { break }
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        if ($health.ok) { $ready = $true; break }
    } catch {
        # Keep polling during startup.
    }
}

if (-not $ready) {
    $detail = ''
    $stderrPath = Join-Path $logsPath 'http-host.stderr.log'
    if (Test-Path -LiteralPath $stderrPath) {
        $detail = (Get-Content -LiteralPath $stderrPath -Tail 20) -join [Environment]::NewLine
    }
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    throw "Vita3K MCP did not become ready. $detail"
}

Write-Output "Vita3K MCP started (PID $($process.Id)): http://$($config.host):$($config.port)/mcp"

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$mcpRoot = $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $mcpRoot 'config\mcp-config.json') -Raw | ConvertFrom-Json
$shutdownUrl = "http://$($config.host):$($config.port)/shutdown"

try {
    $result = Invoke-RestMethod -Uri $shutdownUrl -Method Post -TimeoutSec 5
    if (-not $result.ok) { throw 'The host rejected the shutdown request.' }
} catch {
    $shutdownFailure = $_
    $isRunning = $false
    try {
        $health = Invoke-RestMethod -Uri "http://$($config.host):$($config.port)/health" -Method Get -TimeoutSec 2
        $isRunning = [bool]$health.ok
    } catch {
        $isRunning = $false
    }
    if ($isRunning) { throw "Vita3K MCP shutdown failed: $($shutdownFailure.Exception.Message)" }
    Write-Output 'Vita3K MCP is not running.'
    exit 0
}

for ($attempt = 0; $attempt -lt 50; $attempt++) {
    Start-Sleep -Milliseconds 100
    try {
        Invoke-RestMethod -Uri "http://$($config.host):$($config.port)/health" -Method Get -TimeoutSec 1 | Out-Null
    } catch {
        Remove-Item -LiteralPath (Join-Path $mcpRoot 'mcp-host.pid') -Force -ErrorAction SilentlyContinue
        Write-Output 'Vita3K MCP stopped.'
        exit 0
    }
}

throw 'Vita3K MCP accepted shutdown but did not stop within 5 seconds.'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$mcpRoot = $PSScriptRoot
$config = Get-Content -LiteralPath (Join-Path $mcpRoot 'config\mcp-config.json') -Raw | ConvertFrom-Json
$healthUrl = "http://$($config.host):$($config.port)/health"

try {
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
    if ($health.ok) {
        Write-Output "Vita3K MCP is running: http://$($config.host):$($config.port)/mcp"
        exit 0
    }
} catch {
    # Report a simple offline status below.
}

Write-Output 'Vita3K MCP is stopped.'
exit 3

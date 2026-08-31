[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$DestinationRoot,
    [string]$SourceRoot,
    [ValidateRange(1, 65535)]
    [int]$Port = 32560
)

$ErrorActionPreference = 'Stop'
$serverSource = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $SourceRoot) {
    $SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $serverSource '..\..'))
} else {
    $SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
}
$DestinationRoot = [System.IO.Path]::GetFullPath($DestinationRoot)
$vita3kExecutable = Join-Path $DestinationRoot 'Vita3K.exe'
if (-not (Test-Path -LiteralPath $vita3kExecutable -PathType Leaf)) {
    throw "Vita3K.exe was not found at $vita3kExecutable"
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'CMakeLists.txt') -PathType Leaf)) {
    throw "The Vita3K source root is invalid: $SourceRoot"
}

$mcpRoot = [System.IO.Path]::GetFullPath((Join-Path $DestinationRoot 'mcp'))
$relativeMcp = [System.IO.Path]::GetRelativePath($DestinationRoot, $mcpRoot)
if ($relativeMcp.StartsWith('..') -or [System.IO.Path]::IsPathRooted($relativeMcp)) {
    throw 'The MCP destination must stay inside the Vita3K directory.'
}

$existingStop = Join-Path $mcpRoot 'Stop-MCP.ps1'
if (Test-Path -LiteralPath $existingStop -PathType Leaf) {
    & $existingStop 2>$null | Out-Null
}

$localNodeRoot = Join-Path $SourceRoot '.tools\node'
$localNode = Join-Path $localNodeRoot 'node.exe'
$localNpm = Join-Path $localNodeRoot 'npm.cmd'
if (-not (Test-Path -LiteralPath $localNode -PathType Leaf) -or -not (Test-Path -LiteralPath $localNpm -PathType Leaf)) {
    throw "Repository-local Node 24 is missing from $localNodeRoot"
}

& $localNpm run build --prefix $serverSource
if ($LASTEXITCODE -ne 0) { throw "TypeScript build failed with exit code $LASTEXITCODE" }

$serverTarget = Join-Path $mcpRoot 'server'
$runtimeTarget = Join-Path $mcpRoot 'runtime'
$configTarget = Join-Path $mcpRoot 'config'
$cacheTarget = Join-Path $mcpRoot '.tools\cache\npm'
foreach ($directory in @($mcpRoot, $serverTarget, $runtimeTarget, $configTarget, $cacheTarget, (Join-Path $mcpRoot 'logs'))) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

Copy-Item -LiteralPath (Join-Path $serverSource 'package.json') -Destination $serverTarget -Force
Copy-Item -LiteralPath (Join-Path $serverSource 'package-lock.json') -Destination $serverTarget -Force
Copy-Item -LiteralPath (Join-Path $serverSource 'toolchain.lock.json') -Destination $serverTarget -Force
Copy-Item -LiteralPath (Join-Path $serverSource 'dist') -Destination $serverTarget -Recurse -Force
Copy-Item -LiteralPath (Join-Path $serverSource 'scripts') -Destination $serverTarget -Recurse -Force
Copy-Item -Path (Join-Path $localNodeRoot '*') -Destination $runtimeTarget -Recurse -Force
Copy-Item -Path (Join-Path $serverSource 'portable\*') -Destination $mcpRoot -Force

$deployedNpm = Join-Path $runtimeTarget 'npm.cmd'
& $deployedNpm ci --omit=dev --prefix $serverTarget --cache $cacheTarget --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "Local production dependency install failed with exit code $LASTEXITCODE" }

$obsoleteTokenPath = Join-Path $configTarget 'http-token.txt'
if (Test-Path -LiteralPath $obsoleteTokenPath -PathType Leaf) {
    Remove-Item -LiteralPath $obsoleteTokenPath -Force
}

$configuration = [ordered]@{
    host = '127.0.0.1'
    port = $Port
    executable = $vita3kExecutable
    sourceRoot = $SourceRoot
}
[System.IO.File]::WriteAllText(
    (Join-Path $configTarget 'mcp-config.json'),
    ($configuration | ConvertTo-Json -Depth 3),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Output "Vita3K MCP deployed to $mcpRoot"
Write-Output "Start it with: $(Join-Path $mcpRoot 'Start-MCP.cmd')"
Write-Output "Endpoint: http://127.0.0.1:$Port/mcp"

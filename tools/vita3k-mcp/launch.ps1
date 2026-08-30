[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serverDir = $PSScriptRoot
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $serverDir '..\..'))
$toolRoot = Join-Path $repoRoot '.tools'
$localNode = Join-Path $toolRoot 'node\node.exe'
$localNpm = Join-Path $toolRoot 'node\npm.cmd'
$ensureScript = Join-Path $serverDir 'scripts\ensure-toolchain.ps1'
$systemPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path -LiteralPath $localNode)) {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    $major = 0
    if ($systemNode) {
        $versionText = & $systemNode.Source --version
        if ($versionText -match '^v(?<major>\d+)\.') {
            $major = [int]$Matches.major
        }
    }
    if (-not $systemNode -or $major -ne 24) {
        & $systemPowerShell -NoProfile -ExecutionPolicy Bypass -File $ensureScript -RepoRoot $repoRoot -Components Node 1>&2
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

if (Test-Path -LiteralPath $localNode) {
    $nodeExe = $localNode
    $npmExe = $localNpm
} else {
    $nodeExe = (Get-Command node -ErrorAction Stop).Source
    $npmExe = (Get-Command npm -ErrorAction Stop).Source
}

$distEntry = Join-Path $serverDir 'dist\index.js'
$packageLock = Join-Path $serverDir 'package-lock.json'
if (-not (Test-Path -LiteralPath $distEntry)) {
    if (-not (Test-Path -LiteralPath $packageLock)) {
        Write-Error 'package-lock.json is missing; run npm install in tools/vita3k-mcp during development.'
        exit 2
    }
    & $npmExe ci --prefix $serverDir --cache (Join-Path $toolRoot 'cache\npm') --no-audit --no-fund 1>&2
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $npmExe run build --prefix $serverDir 1>&2
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $nodeExe $distEntry
exit $LASTEXITCODE

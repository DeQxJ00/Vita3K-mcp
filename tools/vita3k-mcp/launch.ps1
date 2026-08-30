[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$serverDir = $PSScriptRoot
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $serverDir '..\..'))
$toolRoot = Join-Path $repoRoot '.tools'
$localNode = Join-Path $toolRoot 'node\node.exe'
$localNpm = Join-Path $toolRoot 'node\npm.cmd'
$ensureScript = Join-Path $serverDir 'scripts\ensure-toolchain.ps1'

if (-not (Test-Path -LiteralPath $localNode)) {
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $major = 0
    if ($systemNode) {
        $versionText = & $systemNode.Source --version
        if ($versionText -match '^v(?<major>\d+)\.') {
            $major = [int]$Matches.major
        }
    }
    if (-not $systemNode -or $major -ne 24) {
        & $ensureScript -RepoRoot $repoRoot -Components Node 2>&1 |
            ForEach-Object { [Console]::Error.WriteLine($_) }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}

if (Test-Path -LiteralPath $localNode) {
    $nodeExe = $localNode
    $npmExe = $localNpm
} else {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $npmExe = (Get-Command npm.cmd -ErrorAction Stop).Source
}

$distEntry = Join-Path $serverDir 'dist\index.js'
$packageLock = Join-Path $serverDir 'package-lock.json'
$installedLock = Join-Path $serverDir 'node_modules\.package-lock.json'
if (-not (Test-Path -LiteralPath $packageLock)) {
    Write-Error 'package-lock.json is missing; restore the repository file before starting the MCP server.'
    exit 2
}
$needsInstall = -not (Test-Path -LiteralPath $installedLock) -or
    (Get-Item -LiteralPath $packageLock).LastWriteTimeUtc -gt (Get-Item -LiteralPath $installedLock).LastWriteTimeUtc
if ($needsInstall) {
    & $npmExe ci --prefix $serverDir --cache (Join-Path $toolRoot 'cache\npm') --no-audit --no-fund 2>&1 |
        ForEach-Object { [Console]::Error.WriteLine($_) }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $serverDir 'src') -Filter '*.ts' -File -Recurse)
$sourceFiles += Get-Item -LiteralPath (Join-Path $serverDir 'tsconfig.json')
$needsBuild = -not (Test-Path -LiteralPath $distEntry)
if (-not $needsBuild) {
    $distTime = (Get-Item -LiteralPath $distEntry).LastWriteTimeUtc
    $needsBuild = @($sourceFiles | Where-Object { $_.LastWriteTimeUtc -gt $distTime }).Count -gt 0
}
if ($needsBuild) {
    & $npmExe run build --prefix $serverDir 2>&1 |
        ForEach-Object { [Console]::Error.WriteLine($_) }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& $nodeExe $distEntry
exit $LASTEXITCODE

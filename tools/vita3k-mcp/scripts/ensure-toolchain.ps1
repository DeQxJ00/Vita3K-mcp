[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,
    [string]$Components = 'CMake,Qt'
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath($RepoRoot)
$toolRoot = [System.IO.Path]::GetFullPath((Join-Path $repo '.tools'))
$serverDir = [System.IO.Path]::GetFullPath((Join-Path $repo 'tools\vita3k-mcp'))
$lockPath = Join-Path $serverDir 'toolchain.lock.json'
$lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json

function Assert-LocalPath([string]$Path) {
    $resolved = [System.IO.Path]::GetFullPath($Path)
    $prefix = $toolRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $resolved.Equals($toolRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside repository tool directory: $resolved"
    }
    return $resolved
}

function Get-Sha256([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-VerifiedArchive([string]$Name, [string]$Url, [string]$Sha256) {
    $cacheDir = Assert-LocalPath (Join-Path $toolRoot 'cache\downloads')
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $archive = Assert-LocalPath (Join-Path $cacheDir $Name)
    if (Test-Path -LiteralPath $archive) {
        $actual = Get-Sha256 $archive
        if ($actual -eq $Sha256.ToLowerInvariant()) { return $archive }
        Remove-Item -Force -LiteralPath $archive
    }
    $partial = Assert-LocalPath ($archive + '.partial')
    if (Test-Path -LiteralPath $partial) { Remove-Item -Force -LiteralPath $partial }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source --fail --location --silent --show-error --retry 4 --connect-timeout 20 --output $partial $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $Name" }
    } else {
        Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
    }
    $actual = Get-Sha256 $partial
    if ($actual -ne $Sha256.ToLowerInvariant()) {
        Remove-Item -Force -LiteralPath $partial
        throw "SHA-256 mismatch for $Name"
    }
    Move-Item -LiteralPath $partial -Destination $archive
    return $archive
}

function Install-ZipTool([string]$Component, [object]$Info, [string]$ExecutableRelativePath) {
    $target = Assert-LocalPath (Join-Path $toolRoot $Component.ToLowerInvariant())
    $executable = Join-Path $target $ExecutableRelativePath
    if (Test-Path -LiteralPath $executable) { return }
    $archiveName = [System.IO.Path]::GetFileName([string]$Info.url)
    $archive = Get-VerifiedArchive $archiveName ([string]$Info.url) ([string]$Info.sha256)
    $staging = Assert-LocalPath (Join-Path $toolRoot ('.staging-' + $Component.ToLowerInvariant() + '-' + [guid]::NewGuid().ToString('N')))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
        $children = @(Get-ChildItem -LiteralPath $staging)
        $source = if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $children[0].FullName } else { $staging }
        if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }
        if ($source -eq $staging) {
            New-Item -ItemType Directory -Force -Path $target | Out-Null
            Get-ChildItem -LiteralPath $staging | Move-Item -Destination $target
        } else {
            Move-Item -LiteralPath $source -Destination $target
        }
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -Recurse -Force -LiteralPath $staging }
    }
    if (-not (Test-Path -LiteralPath $executable)) { throw "$Component archive did not contain $ExecutableRelativePath" }
}

function Install-Qt {
    $qtRoot = Assert-LocalPath (Join-Path $toolRoot 'qt')
    $qtTarget = Join-Path $qtRoot (Join-Path ([string]$lock.qt.version) 'msvc2022_64')
    if (Test-Path -LiteralPath (Join-Path $qtTarget 'bin\qmake.exe')) { return }

    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) { throw 'MISSING_PYTHON: Python is required only to create the repository-local aqt environment.' }
    $venv = Assert-LocalPath (Join-Path $toolRoot 'python-venv')
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $venvPython)) { & $python.Source -m venv $venv }
    $pipCache = Assert-LocalPath (Join-Path $toolRoot 'cache\pip')
    & $venvPython -m pip install --disable-pip-version-check --cache-dir $pipCache --require-virtualenv ("aqtinstall==" + [string]$lock.qt.aqtinstallVersion)
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install aqtinstall in the repository-local virtual environment.' }

    $staging = Assert-LocalPath (Join-Path $toolRoot ('.staging-qt-' + [guid]::NewGuid().ToString('N')))
    $stagedTarget = Join-Path $staging (Join-Path ([string]$lock.qt.version) 'msvc2022_64')
    New-Item -ItemType Directory -Force -Path $stagedTarget | Out-Null
    try {
        foreach ($archiveInfo in $lock.qt.archives) {
            $archive = Get-VerifiedArchive ([string]$archiveInfo.name) ([string]$archiveInfo.url) ([string]$archiveInfo.sha256)
            & $venvPython -m py7zr x $archive $stagedTarget
            if ($LASTEXITCODE -ne 0) { throw "Failed to extract Qt archive $($archiveInfo.name)" }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $stagedTarget 'bin\qmake.exe'))) {
            throw 'Qt archives did not contain the expected msvc2022_64 layout.'
        }
        New-Item -ItemType Directory -Force -Path $qtRoot | Out-Null
        if (Test-Path -LiteralPath $qtTarget) { Remove-Item -Recurse -Force -LiteralPath $qtTarget }
        $versionRoot = Join-Path $qtRoot ([string]$lock.qt.version)
        New-Item -ItemType Directory -Force -Path $versionRoot | Out-Null
        Move-Item -LiteralPath $stagedTarget -Destination $qtTarget
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -Recurse -Force -LiteralPath $staging }
    }
}

function Install-BuildDependencies {
    $info = $lock.buildDependencies.openssl
    $archive = Get-VerifiedArchive ([string]$info.name) ([string]$info.url) ([string]$info.sha256)
    $buildExternal = [System.IO.Path]::GetFullPath((Join-Path $repo 'build\windows-vs2022\external'))
    $buildRoot = [System.IO.Path]::GetFullPath((Join-Path $repo 'build')).TrimEnd('\') + '\'
    if (-not $buildExternal.StartsWith($buildRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to stage a build dependency outside the build directory: $buildExternal"
    }
    New-Item -ItemType Directory -Force -Path $buildExternal | Out-Null
    Copy-Item -Force -LiteralPath $archive -Destination (Join-Path $buildExternal 'openssl.zip')
}

$requestedComponents = @($Components.Split(',', [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() })
$unsupported = @($requestedComponents | Where-Object { $_ -notin @('CMake', 'Qt', 'Node', 'BuildDeps') })
if ($unsupported.Count -gt 0) { throw "Unsupported tool component: $($unsupported -join ', ')" }

New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
foreach ($component in $requestedComponents) {
    switch ($component) {
        'CMake' { Install-ZipTool 'CMake' $lock.cmake 'bin\cmake.exe' }
        'Node' { Install-ZipTool 'Node' $lock.node 'node.exe' }
        'Qt' { Install-Qt }
        'BuildDeps' { Install-BuildDependencies }
    }
}

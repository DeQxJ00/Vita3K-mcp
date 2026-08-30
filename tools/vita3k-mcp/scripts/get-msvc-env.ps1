[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallationPath
)

$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $InstallationPath 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
if (-not (Test-Path -LiteralPath $modulePath)) {
    throw "Visual Studio developer shell module was not found: $modulePath"
}
Import-Module $modulePath
Enter-VsDevShell -VsInstallPath $InstallationPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
Get-ChildItem Env: | Sort-Object Name | ForEach-Object { "{0}={1}" -f $_.Name, $_.Value }

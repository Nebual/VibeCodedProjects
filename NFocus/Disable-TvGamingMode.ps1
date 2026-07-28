<#
    Turn TV Gaming Mode off, restoring the previous settings.

    Exit codes (for Stream Deck / scripting):
      0  success                 4  corrupt state file, best-effort reset done
      1  unhandled error         10 some steps could not be reverted
      3  no state file, best-effort reset done
      11 another instance is running
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string[]]$Only,
    [switch]$DryRun,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    exit (Invoke-NFocusDisable -Force:$Force -Only $Only -DryRun:$DryRun -Quiet:$Quiet)
}
catch {
    Write-Error $_.Exception.Message
    try { [Console]::Beep(220, 400) } catch { }
    exit 1
}

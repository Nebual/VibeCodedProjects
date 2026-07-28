<#
    Turn TV Gaming Mode on.

    Exit codes (for Stream Deck / scripting):
      0  success                 5  refused, machine already looks enabled
      1  unhandled error         6  preflight failed / TV not connected
      2  already on              10 partial: display committed, a later step failed
      4  corrupt state file      11 another instance is running
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string[]]$Only,
    [int]$ConfirmTimeout = 40,
    [switch]$DryRun,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty under -Command "& {...}", which Steam launch options
# tempt you into. Turn that into a clear error rather than a mystery.
if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    exit (Invoke-NFocusEnable -Force:$Force -Only $Only -ConfirmTimeout $ConfirmTimeout -DryRun:$DryRun -Quiet:$Quiet)
}
catch {
    Write-Error $_.Exception.Message
    try { [Console]::Beep(220, 400) } catch { }
    exit 1
}

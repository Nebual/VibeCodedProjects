<#
    Report NFocus state. Read-only, takes no lock, safe to run at any time.

    Exit codes mirror the mode state so a Stream Deck button can reflect it:
      0 inactive   2 active   4 corrupt   10 partial/drifted   12 stale
#>
[CmdletBinding()]
param([switch]$Json)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    Write-NFocusStatusReport -Json:$Json

    switch ((Get-NFocusStatus).overall) {
        'Inactive' { exit 0 }
        'Active'   { exit 2 }
        'Corrupt'  { exit 4 }
        'Stale'    { exit 12 }
        default    { exit 10 }   # Partial, Drifted
    }
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

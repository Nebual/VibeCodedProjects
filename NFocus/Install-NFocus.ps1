<#
    One-time setup. Registers the two elevated scheduled tasks that let the
    Bluetooth adapter be toggled without a UAC prompt every time.

    This raises ONE UAC prompt, here, and never again.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    Install-NFocus -Uninstall:$Uninstall -WhatIf:$WhatIfPreference
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

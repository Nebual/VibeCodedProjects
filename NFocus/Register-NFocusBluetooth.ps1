<#
    Pin which Bluetooth adapter is the DESK one.

    TV Gaming Mode disables that adapter so the TV room's adapter takes over.
    Run this once, with the desk adapter switched on.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$InstanceId,
    [switch]$List
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    Register-NFocusBluetooth -InstanceId $InstanceId -List:$List -WhatIf:$WhatIfPreference
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

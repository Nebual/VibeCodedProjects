<#
    Learn which display is the TV. Run once, with the TV connected and on.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$HardwareId,
    [switch]$List,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop
    Register-NFocusTv -HardwareId $HardwareId -List:$List -Force:$Force -WhatIf:$WhatIfPreference
    exit 0
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

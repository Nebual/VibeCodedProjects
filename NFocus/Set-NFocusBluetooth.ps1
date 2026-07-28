<#
    Elevated Bluetooth helper. Not meant to be run by hand -- it is the action
    behind the NFocus-BtDisable / NFocus-BtEnable scheduled tasks, which exist
    so that toggling TV Gaming Mode does not raise a UAC prompt every time.

    The adapter is auto-detected at run time rather than baked into the task,
    so a driver reinstall or port change does not silently break the task.

    Exit codes: 0 success, 1 failure, 2 no adapter found.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Enable', 'Disable')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

if (-not $PSScriptRoot) {
    Write-Error 'Run this with -File, not -Command.'
    exit 1
}

try {
    Import-Module (Join-Path $PSScriptRoot 'NFocus\NFocus.psd1') -Force -ErrorAction Stop

    $result = & (Get-Module NFocus) {
        param($Action)

        Initialize-NFocusLog -Operation "bt-$($Action.ToLower())"

        $m = Measure-NFocusBluetooth
        if (-not $m.found) {
            Write-NFocusLog -Level ERR -Step 'bluetooth' -Message 'No present Bluetooth adapter found.'
            return 2
        }

        $want = ($Action -eq 'Enable')
        if ($m.enabled -eq $want) {
            Write-NFocusLog -Step 'bluetooth' -Message "'$($m.name)' is already $($Action.ToLower())d."
            return 0
        }

        try {
            if ($want) {
                Enable-PnpDevice -InstanceId $m.instanceId -Confirm:$false -ErrorAction Stop
            }
            else {
                Disable-PnpDevice -InstanceId $m.instanceId -Confirm:$false -ErrorAction Stop
            }
            Write-NFocusLog -Step 'bluetooth' -Message "$Action succeeded for '$($m.name)'."
            return 0
        }
        catch {
            Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "$Action failed: $($_.Exception.Message)"
            return 1
        }
    } $Action

    exit ([int]$result)
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}

# Step.Bluetooth.ps1 -- disable/enable the Bluetooth adapter.
#
# Target on this machine: "Qualcomm FastConnect 7800 Dual Bluetooth Adapter",
# USB\VID_0489&PID_E10A\8&5D1DE9F&0&15. Four other radios exist in the
# Bluetooth class (an Intel adapter and three Generic Bluetooth Radios) but all
# are Present=$false phantoms, so PRESENCE IS THE FILTER THAT MATTERS.
#
# TRAP: a disabled PnP device reports Status='Error' with Problem=22
# (CM_PROB_DISABLED), NOT Status='Disabled'. Keying off the status string
# silently mis-detects. We key off the problem code.
#
# REVERT POLICY -- deliberate exception to the tool's general rule. Everywhere
# else NFocus restores the recorded prior value. Here Disable turns Bluetooth
# back ON unconditionally, because the user asked for exactly that: the adapter
# happened to be off when this was written, but that state is incidental. The
# prior state is still recorded, for the log and for -Force.

$script:NFocusBtProblemDisabled = 22   # CM_PROB_DISABLED

function Get-NFocusBluetoothAdapter {
    <#
        The one real radio. Filters to Class=Bluetooth, Present=$true, and a
        bus-level instance id (USB\ or PCI\) so the BTHENUM/BTHLE/BTH\MS_*
        child nodes for paired devices are excluded.
    #>
    [CmdletBinding()]
    param([string]$PinnedInstanceId)

    $all = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
             Where-Object { $_.Present -and ($_.InstanceId -like 'USB\*' -or $_.InstanceId -like 'PCI\*') })

    if (-not [string]::IsNullOrWhiteSpace($PinnedInstanceId)) {
        $pinned = $all | Where-Object { $_.InstanceId -eq $PinnedInstanceId } | Select-Object -First 1
        if ($null -ne $pinned) { return $pinned }
        Write-NFocusLog -Level WRN -Step 'bluetooth' -Message "Pinned adapter '$PinnedInstanceId' is not present; falling back to auto-detect."
    }

    if ($all.Count -eq 0) { return $null }
    if ($all.Count -eq 1) { return $all[0] }

    Write-NFocusLog -Level WRN -Step 'bluetooth' -Message ("Found {0} present Bluetooth adapters; using '{1}'. Pin one with bluetoothInstanceId in config.json to be explicit." -f `
        $all.Count, $all[0].FriendlyName)
    return $all[0]
}

function Test-NFocusBluetoothEnabled {
    param($Adapter)
    if ($null -eq $Adapter) { return $null }
    return ([int]$Adapter.Problem -ne $script:NFocusBtProblemDisabled)
}

function Measure-NFocusBluetooth {
    [CmdletBinding()]
    param()

    $cfg = $null
    try { $cfg = Read-NFocusConfig } catch { }
    $pinned = $null
    if ($null -ne $cfg) { $pinned = $cfg.bluetoothInstanceId }

    $a = Get-NFocusBluetoothAdapter -PinnedInstanceId $pinned
    if ($null -eq $a) {
        return [pscustomobject]@{ found = $false; enabled = $null; name = $null; instanceId = $null; problem = $null }
    }

    return [pscustomobject]@{
        found      = $true
        enabled    = (Test-NFocusBluetoothEnabled $a)
        name       = $a.FriendlyName
        instanceId = $a.InstanceId
        problem    = [int]$a.Problem
    }
}

function Set-NFocusBluetoothState {
    <#
        Enable or disable the adapter. Needs elevation, so it goes through the
        pre-registered scheduled task when one exists (no UAC prompt per
        toggle) and falls back to a RunAs relaunch otherwise.
        Returns $true on success.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][bool]$Enable
    )

    if (Test-NFocusElevated) {
        try {
            if ($Enable) {
                Enable-PnpDevice -InstanceId $InstanceId -Confirm:$false -ErrorAction Stop
            }
            else {
                Disable-PnpDevice -InstanceId $InstanceId -Confirm:$false -ErrorAction Stop
            }
            return $true
        }
        catch {
            Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "Direct PnP call failed: $($_.Exception.Message)"
            return $false
        }
    }

    return (Invoke-NFocusElevatedBluetooth -InstanceId $InstanceId -Enable:$Enable)
}

function Invoke-NFocusStepBluetooth {
    [CmdletBinding()]
    param([switch]$DryRun)

    $step = New-NFocusStepResult
    $step.attempted = $true

    $m = Measure-NFocusBluetooth
    Add-Member -InputObject $step -NotePropertyName 'instanceId' -NotePropertyValue $m.instanceId
    Add-Member -InputObject $step -NotePropertyName 'name'       -NotePropertyValue $m.name
    Add-Member -InputObject $step -NotePropertyName 'prior'      -NotePropertyValue ([pscustomobject]@{
        enabled = $m.enabled; problem = $m.problem
    })

    if (-not $m.found) {
        $step.status = 'AdapterNotFound'
        $step.error  = 'No present Bluetooth adapter was found.'
        Write-NFocusLog -Level WRN -Step 'bluetooth' -Message $step.error
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ enabled = $null })
        return $step
    }

    Write-NFocusLog -Step 'bluetooth' -Message ("prior: '{0}' enabled={1} problem={2}" -f $m.name, $m.enabled, $m.problem)

    if ($m.enabled -eq $false) {
        # Already off. Record changed=$false so the revert rule can tell
        # "we turned it off" from "it was already off".
        $step.changed = $false
        $step.status  = 'AlreadyInDesiredState'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ enabled = $false })
        Write-NFocusLog -Step 'bluetooth' -Message 'Adapter was already disabled; nothing to do.'
        return $step
    }

    if ($DryRun) {
        $step.changed = $true
        $step.status  = 'WouldDisable'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ enabled = $false })
        return $step
    }

    if (Set-NFocusBluetoothState -InstanceId $m.instanceId -Enable $false) {
        $step.changed = $true
        $step.status  = 'Success'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ enabled = $false })
        Write-NFocusLog -Step 'bluetooth' -Message "Disabled '$($m.name)'."
    }
    else {
        $step.changed = $false
        $step.status  = 'Failed'
        $step.error   = 'Could not disable the Bluetooth adapter (elevation unavailable or the call failed).'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ enabled = $true })
    }

    return $step
}

function Revert-NFocusStepBluetooth {
    <#
        Per the user's instruction this turns Bluetooth back ON unconditionally
        whenever NFocus turned it off -- and, with -Force, even if it did not.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$StepData,
        [switch]$Force,
        [switch]$DryRun
    )

    $result = [pscustomobject]@{ status = 'Skipped'; notes = @() }

    if ($null -eq $StepData -or -not $StepData.attempted) {
        $result.status = 'NotAttempted'
        return $result
    }

    if (-not $StepData.changed -and -not $Force) {
        $result.status = 'NoChangeMade'
        $result.notes += 'Bluetooth was already off before NFocus, so it has been left off.'
        Write-NFocusLog -Step 'bluetooth' -Message 'Left disabled: NFocus did not turn it off.'
        return $result
    }

    $m = Measure-NFocusBluetooth
    if (-not $m.found) {
        $result.status = 'AdapterNotFound'
        return $result
    }
    if ($m.enabled -eq $true) {
        $result.status = 'AlreadyReverted'
        return $result
    }

    if ($DryRun) {
        $result.status = 'WouldEnable'
        return $result
    }

    if (Set-NFocusBluetoothState -InstanceId $m.instanceId -Enable $true) {
        $result.status = 'Reverted'
        Write-NFocusLog -Step 'bluetooth' -Message "Re-enabled '$($m.name)'."
    }
    else {
        $result.status = 'Failed'
        $result.notes += 'Could not re-enable the Bluetooth adapter (elevation unavailable).'
        Write-NFocusLog -Level ERR -Step 'bluetooth' -Message 'Failed to re-enable the adapter.'
    }

    return $result
}

function Reset-NFocusBluetoothBestEffort {
    [CmdletBinding()]
    param([switch]$DryRun)

    $m = Measure-NFocusBluetooth
    if (-not $m.found)        { return @('No present Bluetooth adapter found.') }
    if ($m.enabled -eq $true) { return @('Bluetooth is already enabled.') }
    if ($DryRun)              { return @("Would enable '$($m.name)'.") }

    if (Set-NFocusBluetoothState -InstanceId $m.instanceId -Enable $true) {
        return @("Enabled '$($m.name)'.")
    }
    return @("Could not enable '$($m.name)' -- elevation unavailable.")
}

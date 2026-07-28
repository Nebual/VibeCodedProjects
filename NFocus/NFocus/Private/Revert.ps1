# Revert.ps1 -- shared revert, used by Disable and by Enable's stale-state
# reconcile path.
#
# THE REVERT RULE:
#
#   Restore the recorded prior value, but only where changed == true, and only
#   if the current value still equals what we applied. A compare-and-swap.
#
#   * changed == false          -> never touch it. Bluetooth is the live case:
#                                  if it was already off at enable time, Disable
#                                  must leave it off rather than "helpfully"
#                                  turning the radio on every session.
#   * changed and current==applied -> restore prior, honouring present:false as
#                                  a DELETE.
#   * changed and current!=applied -> the user changed it by hand while the mode
#                                  was active. Their explicit, more recent
#                                  action outranks our stale recording: leave
#                                  it, warn, and surface it.
#
# Two deliberate exceptions, both documented at their call sites: Bluetooth is
# turned back on unconditionally when we turned it off (the user asked for
# that), and the display uses a coarse CAS on the active-monitor set rather than
# on the opaque blob, because "leave it alone" would strand the user on the TV.

function Invoke-NFocusRevertSteps {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [switch]$Force,
        [switch]$DryRun,
        [string[]]$Only
    )

    $results = [ordered]@{}

    # Reverse of the apply order: give the display back last so the user is
    # looking at their desk layout only once everything else is settled.
    $order = @('discord', 'notifications', 'bluetooth', 'display')
    if ($null -ne $Only -and $Only.Count -gt 0) {
        $order = @($order | Where-Object { $Only -contains $_ })
    }

    foreach ($name in $order) {
        $data = Get-NFocusStep -State $State -Name $name
        if ($null -eq $data) {
            $results[$name] = [pscustomobject]@{ status = 'NotAttempted'; notes = @() }
            continue
        }

        try {
            $r = $null
            switch ($name) {
                'discord'       { $r = Revert-NFocusStepDiscord       -StepData $data -Force:$Force -DryRun:$DryRun }
                'notifications' { $r = Revert-NFocusStepNotifications -StepData $data -Force:$Force -DryRun:$DryRun }
                'bluetooth'     { $r = Revert-NFocusStepBluetooth     -StepData $data -Force:$Force -DryRun:$DryRun }
                'display'       { $r = Revert-NFocusStepDisplay       -StepData $data -Force:$Force -DryRun:$DryRun }
            }
            $results[$name] = $r
            Write-NFocusLog -Step $name -Message "revert: $($r.status)"
        }
        catch {
            Write-NFocusLog -Level ERR -Step $name -Message "revert threw: $($_.Exception.Message)"
            $results[$name] = [pscustomobject]@{ status = 'Failed'; notes = @($_.Exception.Message) }
        }
    }

    return $results
}

function Invoke-NFocusResetBestEffort {
    <#
        Disable with no state file. The user may be stranded -- notifications
        off, Bluetooth off, one display -- so a pure no-op is unhelpful at
        exactly the wrong moment. But blindly "restoring defaults" is also
        wrong, and this machine proves it: writing
        NOC_GLOBAL_SETTING_TOASTS_ENABLED=1 would CREATE a value whose correct
        state is absent.

        Resolution: "safe default" means REMOVE OUR MARKS, not write
        known-good values. The display is never guessed at without -Force,
        because a wrong topology is the one failure that can black-screen the
        user out of fixing it.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [switch]$DryRun
    )

    $notes = [ordered]@{}

    $notes['notifications'] = @(Reset-NFocusNotificationsBestEffort -DryRun:$DryRun)
    $notes['discord']       = @(Reset-NFocusDiscordBestEffort -DryRun:$DryRun)

    # Bluetooth: the user's rule is "back on when disabling", so this is safe
    # to do even without a state file.
    $notes['bluetooth'] = @(Reset-NFocusBluetoothBestEffort -DryRun:$DryRun)

    if ($Force) {
        if ($DryRun) {
            $notes['display'] = @('Would run DisplaySwitch.exe /extend.')
        }
        else {
            try {
                Start-Process -FilePath 'DisplaySwitch.exe' -ArgumentList '/extend' -WindowStyle Hidden -Wait -ErrorAction Stop
                $notes['display'] = @('Ran DisplaySwitch.exe /extend to bring the monitors back.')
            }
            catch {
                $notes['display'] = @("DisplaySwitch.exe failed: $($_.Exception.Message)")
            }
        }
    }
    else {
        $notes['display'] = @('Left alone -- no snapshot to restore, and guessing risks a black screen. Press Win+P, or re-run with -Force to extend.')
    }

    return $notes
}

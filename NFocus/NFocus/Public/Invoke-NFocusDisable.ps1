function Invoke-NFocusDisable {
    <#
    .SYNOPSIS
        Turn TV Gaming Mode off, restoring what was there before.

    .PARAMETER Force
        Restore every recorded prior value unconditionally, ignoring both the
        "we did not change it" rule and the "you changed it by hand" rule. With
        no state file, also attempts DisplaySwitch /extend.

    .PARAMETER Only
        Revert just these steps: display, bluetooth, notifications, discord.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [string[]]$Only,
        [switch]$DryRun,
        [switch]$Quiet
    )

    Initialize-NFocusLog -Operation 'disable'
    Write-NFocusLog -Step 'run' -Message ("start: Force={0} Only='{1}' DryRun={2}" -f $Force, ($Only -join ','), $DryRun)

    $lock = New-NFocusLock
    if (-not $lock.acquired) {
        Write-NFocusLog -Level WRN -Step 'run' -Message 'Another NFocus run holds the lock; doing nothing.'
        if (-not $Quiet) { Write-Warning 'Another NFocus operation is already running.' }
        return 11
    }

    try {
        Confirm-NFocusStateDir

        # A pending deadman must never fire after a deliberate Disable.
        Stop-NFocusDeadman

        $state = $null
        $corrupt = $null
        try {
            $state = Read-NFocusState
        }
        catch {
            $corrupt = $_.Exception.Message
        }

        if ($null -ne $corrupt) {
            $archived = Move-NFocusStateToArchive -Reason 'corrupt'
            Write-NFocusLog -Level ERR -Step 'run' -Message "State unusable ($corrupt); archived to $archived."
            if (-not $Quiet) {
                Write-Warning "State file was unreadable and has been archived to $archived."
                Write-Warning 'Falling back to a best-effort reset.'
            }
            $notes = Invoke-NFocusResetBestEffort -Force:$Force -DryRun:$DryRun
            if (-not $Quiet) { Write-NFocusNotes $notes }
            Invoke-NFocusBeep -Kind 'Failed'
            return 4
        }

        # --- no state file --------------------------------------------------
        if ($null -eq $state) {
            Write-NFocusLog -Level WRN -Step 'run' -Message 'No state file; best-effort reset.'
            if (-not $Quiet) {
                Write-Host 'No NFocus state file found -- TV Gaming Mode was not recorded as on.' -ForegroundColor Yellow
                Write-Host 'Doing a best-effort reset of the settings that are safe to touch.' -ForegroundColor Yellow
            }
            $notes = Invoke-NFocusResetBestEffort -Force:$Force -DryRun:$DryRun
            if (-not $Quiet) { Write-NFocusNotes $notes }
            Invoke-NFocusBeep -Kind 'Disabled'
            return 3
        }

        # --- reconcile mode after a reboot ----------------------------------
        # Steps survive a reboot unevenly: the registry values and the Bluetooth
        # devnode flag persist, the Discord mute does not, the display usually
        # does. So re-measure per step and act only on the delta -- each
        # Revert-* already compares against the live world before writing.
        if (Test-NFocusStateStale -State $state) {
            Write-NFocusLog -Level WRN -Step 'run' -Message 'Stale state (reboot detected); reconciling.'
            if (-not $Quiet) { Write-Host 'The machine rebooted while the mode was on -- reconciling.' -ForegroundColor Yellow }
        }

        $wanted = Resolve-NFocusStepList -Only $Only -Valid @('display', 'bluetooth', 'notifications', 'discord')
        $results = Invoke-NFocusRevertSteps -State $state -Force:$Force -DryRun:$DryRun -Only $wanted

        if (-not $Quiet) { Write-NFocusNotes $results }

        $failed = @($results.Values | Where-Object { $_.status -eq 'Failed' })

        if (-not $DryRun) {
            if ($wanted.Count -gt 0) {
                # Partial revert: keep the state file, the rest is still applied.
                Write-NFocusLog -Step 'run' -Message 'Partial revert (-Only); state file kept.'
            }
            elseif ($failed.Count -eq 0) {
                Remove-NFocusState
            }
            else {
                $archived = Move-NFocusStateToArchive -Reason 'revert-failed'
                Write-NFocusLog -Level WRN -Step 'run' -Message "Some steps failed to revert; state archived to $archived."
            }
        }

        Write-NFocusLog -Step 'run' -Message "end: failures=$($failed.Count)"

        if ($DryRun) {
            if (-not $Quiet) { Write-Host 'Dry run complete -- nothing was changed.' -ForegroundColor Cyan }
            return 0
        }

        if ($failed.Count -eq 0) {
            Invoke-NFocusBeep -Kind 'Disabled'
            if (-not $Quiet) { Write-Host 'TV Gaming Mode off.' -ForegroundColor Green }
            return 0
        }

        Invoke-NFocusBeep -Kind 'Failed'
        if (-not $Quiet) { Write-Warning 'Some steps could not be reverted. See Get-TvGamingModeStatus.ps1.' }
        return 10
    }
    finally {
        Remove-NFocusLock -Lock $lock
    }
}

function Write-NFocusNotes {
    <# Print the per-step notes from a revert/reset in a readable way. #>
    param($Results)

    foreach ($key in $Results.Keys) {
        $v = $Results[$key]

        $status = $v
        $notes  = @()
        if ($v -is [array]) {
            $status = ''
            $notes  = @($v)
        }
        else {
            $status = $v.status
            $notes  = @(ConvertTo-NFocusArray $v.notes)
        }

        if ($status) { Write-Host ('  {0,-14} {1}' -f $key, $status) }
        else         { Write-Host ('  {0,-14}' -f $key) }

        foreach ($n in $notes) {
            Write-Host ('      - {0}' -f $n) -ForegroundColor DarkGray
        }
    }
}

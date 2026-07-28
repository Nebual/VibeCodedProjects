function Invoke-NFocusEnable {
    <#
    .SYNOPSIS
        Turn TV Gaming Mode on. Returns the process exit code.

    .DESCRIPTION
        Order of operations -- the display switch is the COMMIT POINT:

            0 lock -> 1 preflight (read-only) -> 2 capture + phase="applying"
            -> 3 DISPLAY  <== commit ==>  4 Bluetooth -> 5 Notifications
            -> 6 Discord -> 7 phase="active"

        The fragile step runs first, so the common failure (TV absent) is
        caught with zero mutations and the rollback set before the commit point
        is empty by construction. Failures AFTER the commit point are committed
        and reported rather than rolled back -- putting the display back to
        punish a failed Bluetooth toggle would be worse than the failure. This
        also dodges an irony: we disable notifications, so we cannot use a
        notification to tell you something half-failed.

    .PARAMETER Force
        Reconcile-revert first, then enable fresh. Deliberately NOT
        "overwrite the state file" -- that would turn the escape hatch into
        the footgun this design exists to prevent.

    .PARAMETER Only
        Run just these steps: display, bluetooth, notifications, discord.

    .PARAMETER ConfirmTimeout
        Seconds for the display deadman. 0 disables it.
    #>
    [CmdletBinding()]
    param(
        [switch]$Force,
        [string[]]$Only,
        [int]$ConfirmTimeout = 40,
        [switch]$DryRun,
        [switch]$Quiet
    )

    Initialize-NFocusLog -Operation 'enable'
    Write-NFocusLog -Step 'run' -Message ("start: Force={0} Only='{1}' ConfirmTimeout={2} DryRun={3}" -f `
        $Force, ($Only -join ','), $ConfirmTimeout, $DryRun)

    $allSteps = @('display', 'bluetooth', 'notifications', 'discord')
    $wanted = Resolve-NFocusStepList -Only $Only -Valid $allSteps
    $run = $allSteps
    if ($wanted.Count -gt 0) {
        $run = @($allSteps | Where-Object { $wanted -contains $_ })
    }

    $lock = New-NFocusLock
    if (-not $lock.acquired) {
        Write-NFocusLog -Level WRN -Step 'run' -Message 'Another NFocus run holds the lock; doing nothing.'
        if (-not $Quiet) { Write-Warning 'Another NFocus operation is already running.' }
        return 11
    }

    try {
        Confirm-NFocusStateDir

        # --- layer 1: the state file is the flag --------------------------
        $existing = $null
        try {
            $existing = Read-NFocusState
        }
        catch {
            $archived = Move-NFocusStateToArchive -Reason 'corrupt'
            Write-NFocusLog -Level ERR -Step 'run' -Message "State file unusable ($($_.Exception.Message)); archived to $archived."
            if (-not $Quiet) { Write-Warning "State file was unreadable and has been archived to $archived. Run again to enable." }
            Invoke-NFocusBeep -Kind 'Failed'
            return 4
        }

        if ($null -ne $existing) {
            if (-not (Test-NFocusStateStale -State $existing)) {
                # Already active this boot. Do NOT capture, do NOT write --
                # capturing now would record our own changes as the baseline.
                Write-NFocusLog -Step 'run' -Message 'Already active; leaving the existing state file untouched.'
                if (-not $Quiet) { Write-Host 'TV Gaming Mode is already on.' -ForegroundColor Yellow }
                return 2
            }

            # Stale: the machine rebooted while active. Steps survive a reboot
            # unevenly, so reconcile-revert against the OLD baseline first,
            # archive it, and only then capture a fresh one. Skipping this
            # would bake our own leftovers in as the user's baseline and let
            # the error compound permanently.
            Write-NFocusLog -Level WRN -Step 'run' -Message 'Stale state (reboot detected); reconcile-reverting before re-enabling.'
            if (-not $Quiet) { Write-Host 'Found stale state from before a reboot -- reconciling first.' -ForegroundColor Yellow }
            $null = Invoke-NFocusRevertSteps -State $existing -Force:$false -DryRun:$DryRun
            $null = Move-NFocusStateToArchive -Reason 'stale'
        }
        elseif ($Force) {
            # -Force with no state file: nothing to reconcile, just proceed.
            Write-NFocusLog -Step 'run' -Message '-Force with no state file; proceeding.'
        }

        # --- layer 4: does the world already look enabled? -----------------
        # The only layer that catches "state file deleted while active" --
        # layers 1-3 all key off the file. Requires 2 of 3 so that a legitimate
        # enable on a machine where Discord happens to be muted does not trip.
        if (-not $Force) {
            $signals = 0
            $why = @()
            if (Test-NFocusNotificationsSuppressed) { $signals++; $why += 'notifications already suppressed' }
            $dm = Measure-NFocusDisplay
            if ($dm.tvOnly)                         { $signals++; $why += 'display already TV-only' }
            $cm = Measure-NFocusDiscord
            if ($cm.allMuted)                       { $signals++; $why += 'Discord already muted' }

            if ($signals -ge 2) {
                Write-NFocusLog -Level ERR -Step 'run' -Message "Refusing: the machine already looks enabled ($($why -join '; '))."
                if (-not $Quiet) {
                    Write-Warning "The machine already looks like TV Gaming Mode is on ($($why -join '; ')), but there is no state file to revert with."
                    Write-Warning 'Re-run with -Force to enable anyway, or run Disable first.'
                }
                Invoke-NFocusBeep -Kind 'Failed'
                return 5
            }
        }

        # --- preflight: read-only, no mutations ----------------------------
        if ($run -contains 'display') {
            $config = Read-NFocusConfig
            if ($null -eq $config -or [string]::IsNullOrWhiteSpace($config.tvHardwareId)) {
                Write-NFocusLog -Level ERR -Step 'preflight' -Message 'No TV registered.'
                if (-not $Quiet) { Write-Warning 'No TV registered. Run Register-NFocusTv.ps1 once with the TV connected.' }
                Invoke-NFocusBeep -Kind 'Failed'
                return 6
            }
            if (-not (Test-NFocusTvPresent -HardwareId $config.tvHardwareId)) {
                Write-NFocusLog -Level ERR -Step 'preflight' -Message "TV $($config.tvHardwareId) has no display path."
                if (-not $Quiet) { Write-Warning "The TV ($($config.tvHardwareId)) is not connected. Nothing was changed." }
                Invoke-NFocusBeep -Kind 'Failed'
                return 6
            }
        }

        # --- capture ------------------------------------------------------
        $state = New-NFocusStateObject
        if (-not $DryRun) {
            try {
                # Layer 3: CreateNew, never overwrite.
                Write-NFocusState -State $state -CreateNew
            }
            catch {
                Write-NFocusLog -Level ERR -Step 'run' -Message "State file appeared mid-run; aborting. $($_.Exception.Message)"
                if (-not $Quiet) { Write-Warning 'Another NFocus run created the state file first. Nothing was changed.' }
                return 11
            }
        }

        # --- apply ---------------------------------------------------------
        $exit = 0

        if ($run -contains 'display') {
            $d = Invoke-NFocusStepDisplay -DryRun:$DryRun -ConfirmTimeout $ConfirmTimeout
            Set-NFocusStep -State $state -Name 'display' -Value $d

            if ($d.status -eq 'Failed' -or $d.status -eq 'TvNotConnected' -or $d.status -eq 'NoTvRegistered') {
                # Before the commit point: nothing else has been touched, so
                # just drop the state file and report.
                Write-NFocusLog -Level ERR -Step 'run' -Message "Display step failed ($($d.status)); aborting with no changes."
                if (-not $DryRun) { Remove-NFocusState }
                if (-not $Quiet) { Write-Warning "Display switch failed: $($d.error)" }
                Invoke-NFocusBeep -Kind 'Failed'
                return 6
            }
            if ($d.status -eq 'VerificationFailed') {
                Add-NFocusFailure -State $state -Step 'display' -Message $d.error
                $exit = 10
            }
            if (-not $DryRun) { Write-NFocusState -State $state }
        }

        # ===================== COMMIT POINT PASSED ========================
        # From here on, failures are recorded and reported, not rolled back.

        foreach ($name in @('bluetooth', 'notifications', 'discord')) {
            if ($run -notcontains $name) { continue }

            try {
                $r = $null
                switch ($name) {
                    'bluetooth'     { $r = Invoke-NFocusStepBluetooth -DryRun:$DryRun }
                    'notifications' { $r = Invoke-NFocusStepNotifications -DryRun:$DryRun }
                    'discord'       { $r = Invoke-NFocusStepDiscord -DryRun:$DryRun }
                }
                Set-NFocusStep -State $state -Name $name -Value $r

                if ($r.status -eq 'Failed') {
                    Add-NFocusFailure -State $state -Step $name -Message $r.error
                    $exit = 10
                }
            }
            catch {
                Write-NFocusLog -Level ERR -Step $name -Message "Unhandled: $($_.Exception.Message)"
                $failed = New-NFocusStepResult 'Failed'
                $failed.attempted = $true
                $failed.error = $_.Exception.Message
                Set-NFocusStep -State $state -Name $name -Value $failed
                Add-NFocusFailure -State $state -Step $name -Message $_.Exception.Message
                $exit = 10
            }

            if (-not $DryRun) { Write-NFocusState -State $state }
        }

        $state.phase = 'active'
        if (-not $DryRun) { Write-NFocusState -State $state }

        Write-NFocusLog -Step 'run' -Message "end: exit=$exit partial=$($state.partial)"

        if ($DryRun) {
            # Nothing was written in a dry run, so there is nothing to clean up.
            if (-not $Quiet) { Write-Host 'Dry run complete -- nothing was changed.' -ForegroundColor Cyan }
            return 0
        }

        if ($exit -eq 0) { Invoke-NFocusBeep -Kind 'Enabled' } else { Invoke-NFocusBeep -Kind 'Failed' }
        if (-not $Quiet) {
            if ($exit -eq 0) { Write-Host 'TV Gaming Mode on.' -ForegroundColor Green }
            else { Write-Warning 'TV Gaming Mode on, but some steps failed. Run Get-TvGamingModeStatus.ps1.' }
        }
        return $exit
    }
    finally {
        Remove-NFocusLock -Lock $lock
    }
}

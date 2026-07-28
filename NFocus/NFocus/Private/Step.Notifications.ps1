# Step.Notifications.ps1 -- suppress Windows notifications and restore them.
#
# Two layers:
#
#   Layer 0  Windows.UI.Shell.FocusSessionManager -- the real Windows 11
#            Do Not Disturb. A PUBLIC, DOCUMENTED WinRT API, verified loadable
#            from PowerShell 5.1 unelevated on this build. This is what moves
#            the bell icon and the Action Center state.
#
#   Layer 1  the two toast registry switches, as belt and braces for anything
#            that bypasses Focus.
#
# Deliberately NOT shipped: the WNF (NtUpdateWnfStateData) and CloudStore
# quiet-hours pokes that circulate online. Both are undocumented and
# build-fragile, and the public API makes them unnecessary.

$script:NFocusToastKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications'
$script:NFocusToastName = 'ToastEnabled'
$script:NFocusNocKey    = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$script:NFocusNocName   = 'NOC_GLOBAL_SETTING_TOASTS_ENABLED'

function Get-NFocusFocusManager {
    try {
        $null = [Windows.UI.Shell.FocusSessionManager, Windows.UI, ContentType = WindowsRuntime]
        if (-not [Windows.UI.Shell.FocusSessionManager]::IsSupported) { return $null }
        return [Windows.UI.Shell.FocusSessionManager]::GetDefault()
    }
    catch {
        return $null
    }
}

function Test-NFocusFocusActive {
    $mgr = Get-NFocusFocusManager
    if ($null -eq $mgr) { return $null }
    try { return [bool]$mgr.IsFocusActive } catch { return $null }
}

function Measure-NFocusNotifications {
    <# Current world state, for status reporting and the world-check. #>
    [CmdletBinding()]
    param()

    return [pscustomobject]@{
        focusActive  = (Test-NFocusFocusActive)
        toastEnabled = (Get-NFocusRegistryValue -Path $script:NFocusToastKey -Name $script:NFocusToastName)
        nocEnabled   = (Get-NFocusRegistryValue -Path $script:NFocusNocKey   -Name $script:NFocusNocName)
    }
}

function Test-NFocusNotificationsSuppressed {
    <# True when notifications look suppressed right now, by any of our means. #>
    $m = Measure-NFocusNotifications
    if ($m.focusActive -eq $true) { return $true }
    if ($m.toastEnabled.present -and "$($m.toastEnabled.data)" -eq '0') { return $true }
    if ($m.nocEnabled.present   -and "$($m.nocEnabled.data)"   -eq '0') { return $true }
    return $false
}

function Invoke-NFocusStepNotifications {
    [CmdletBinding()]
    param([switch]$DryRun)

    $step = New-NFocusStepResult
    $step.attempted = $true

    $priorToast = Get-NFocusRegistryValue -Path $script:NFocusToastKey -Name $script:NFocusToastName
    $priorNoc   = Get-NFocusRegistryValue -Path $script:NFocusNocKey   -Name $script:NFocusNocName
    $priorFocus = Test-NFocusFocusActive

    Write-NFocusLog -Step 'notifications' -Message ("prior: focusActive={0} {1}={2}(present={3}) {4}={5}(present={6})" -f `
        $priorFocus, $script:NFocusToastName, $priorToast.data, $priorToast.present, `
        $script:NFocusNocName, $priorNoc.data, $priorNoc.present)

    $appliedToast = [pscustomobject]@{ present = $true; kind = 'DWord'; data = 0 }
    $appliedNoc   = [pscustomobject]@{ present = $true; kind = 'DWord'; data = 0 }

    $focusStarted = $false
    $focusError   = $null

    if (-not $DryRun) {
        $mgr = Get-NFocusFocusManager
        if ($null -ne $mgr) {
            try {
                if (-not $mgr.IsFocusActive) {
                    # No end time: the session runs until DeactivateFocus().
                    $null = $mgr.TryStartFocusSession()
                    $focusStarted = $true
                }
            }
            catch {
                # Measured on this build: the READ side of FocusSessionManager
                # works fine unelevated, but TryStartFocusSession is denied with
                # "Feature com.microsoft.windows.focussessionmanager.1 is not
                # available" -- the write path is gated to callers with package
                # identity. So Layer 1 is the workhorse, not the backstop.
                # Not fatal, and deliberately not worked around with the WNF or
                # CloudStore pokes: undocumented and build-fragile.
                $focusError = $_.Exception.Message
                Write-NFocusLog -Level WRN -Step 'notifications' -Message "TryStartFocusSession denied; registry layer will carry this. $focusError"
            }
        }
        else {
            Write-NFocusLog -Level WRN -Step 'notifications' -Message 'FocusSessionManager unavailable; relying on the registry layer only.'
        }

        Set-NFocusRegistryDword -Path $script:NFocusToastKey -Name $script:NFocusToastName -Value 0
        Set-NFocusRegistryDword -Path $script:NFocusNocKey   -Name $script:NFocusNocName   -Value 0
    }

    $step.changed = $true
    $step.status  = 'Success'

    # Record what actually happened, not what we hoped. Claiming active=$true
    # when the call was denied would make the revert logic lie later.
    $postFocus = $priorFocus
    if (-not $DryRun) { $postFocus = Test-NFocusFocusActive }

    Add-Member -InputObject $step -NotePropertyName 'focus' -NotePropertyValue ([pscustomobject]@{
        supported   = ($null -ne (Get-NFocusFocusManager))
        prior       = [pscustomobject]@{ active = $priorFocus }
        applied     = [pscustomobject]@{ active = $postFocus }
        startedByUs = $focusStarted
        error       = $focusError
    })

    Add-Member -InputObject $step -NotePropertyName 'values' -NotePropertyValue @(
        [pscustomobject]@{
            path = $script:NFocusToastKey; name = $script:NFocusToastName
            prior = $priorToast; applied = $appliedToast
        }
        [pscustomobject]@{
            path = $script:NFocusNocKey; name = $script:NFocusNocName
            prior = $priorNoc; applied = $appliedNoc
        }
    )

    return $step
}

function Revert-NFocusStepNotifications {
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
        # We never changed it, so it is not ours to put back.
        $result.status = 'NoChangeMade'
        return $result
    }

    # --- registry, with compare-and-swap ---------------------------------
    foreach ($v in (ConvertTo-NFocusArray $StepData.values)) {
        $now = Get-NFocusRegistryValue -Path $v.path -Name $v.name

        if (-not $Force -and -not (Test-NFocusValueEqual $now $v.applied)) {
            # Someone changed this while the mode was active. Their explicit,
            # more recent action outranks our stale recording.
            $msg = "$($v.name) was changed outside NFocus while active; leaving it alone."
            $result.notes += $msg
            Write-NFocusLog -Level WRN -Step 'notifications' -Message $msg
            continue
        }

        if (-not $DryRun) {
            Restore-NFocusRegistryValue -Path $v.path -Name $v.name -Capture $v.prior
        }

        $how = 'deleted'
        if ($v.prior.present) { $how = "set to $($v.prior.data)" }
        Write-NFocusLog -Step 'notifications' -Message "restored $($v.name): $how"
    }

    # --- focus session ----------------------------------------------------
    # Only end Focus if WE started it. If the user already had DND on, or if
    # our start attempt was denied and DND is on for some other reason, turning
    # it off on the way out would be silently reconfiguring their machine.
    $startedByUs = $false
    $priorFocus  = $null
    if ($null -ne $StepData.focus) {
        $startedByUs = [bool]$StepData.focus.startedByUs
        $priorFocus  = $StepData.focus.prior.active
    }

    if (-not $startedByUs -and -not $Force) {
        if ($priorFocus -eq $true) {
            $result.notes += 'Do Not Disturb was already on before NFocus; leaving it on.'
        }
    }
    elseif (-not $DryRun) {
        $mgr = Get-NFocusFocusManager
        if ($null -ne $mgr) {
            try {
                if ($mgr.IsFocusActive) { $mgr.DeactivateFocus() }
            }
            catch {
                $result.notes += "DeactivateFocus failed: $($_.Exception.Message)"
                Write-NFocusLog -Level WRN -Step 'notifications' -Message "DeactivateFocus failed: $($_.Exception.Message)"
            }
        }
    }

    $result.status = 'Reverted'
    return $result
}

function Reset-NFocusNotificationsBestEffort {
    <#
        Used by Disable when there is no state file. "Safe default" here means
        REMOVE OUR MARKS, not write known-good values:

          * NOC_GLOBAL_...  -> delete. Deletion restores the OS default, and on
            this machine that also happens to be the true prior state. Writing
            1 would CREATE a value that should not exist.
          * ToastEnabled    -> set 1. No absence trick available, so this is a
            genuine guess and is logged as one.
    #>
    [CmdletBinding()]
    param([switch]$DryRun)

    $notes = @()

    if (-not $DryRun) {
        Restore-NFocusRegistryValue -Path $script:NFocusNocKey -Name $script:NFocusNocName `
            -Capture ([pscustomobject]@{ present = $false; kind = $null; data = $null })
        Set-NFocusRegistryDword -Path $script:NFocusToastKey -Name $script:NFocusToastName -Value 1

        $mgr = Get-NFocusFocusManager
        if ($null -ne $mgr) {
            try { if ($mgr.IsFocusActive) { $mgr.DeactivateFocus() } } catch { }
        }
    }

    $notes += "Deleted $script:NFocusNocName (restores the OS default)."
    $notes += "Set $script:NFocusToastName = 1 -- this is a GUESS, no prior value was recorded."
    Write-NFocusLog -Level WRN -Step 'notifications' -Message 'Best-effort reset with no state file; ToastEnabled=1 is a guess.'

    return $notes
}

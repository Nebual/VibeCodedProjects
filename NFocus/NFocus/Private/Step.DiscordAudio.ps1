# Step.DiscordAudio.ps1 -- silence Discord locally via per-app audio mute.
#
# Discord's ONLINE STATUS IS DELIBERATELY NOT TOUCHED. There is no sanctioned
# way to set it: bots cannot change a user's presence and OAuth2 has no scope
# for it. The only method that works is a user token against
# PATCH /users/@me/settings, which is self-botting -- a ToS violation carrying
# account-termination risk. So friends still see you Online; Discord just
# stops making noise.
#
# KNOWN LIMITATION, measured: Discord creates an audio session lazily. With six
# Discord processes running and nothing playing, it holds NO audio session at
# all -- so there may be nothing to mute at enable time, and a session created
# afterwards (joining a call) will not be muted. Reported honestly rather than
# papered over; re-running Enable re-asserts.

$script:NFocusDiscordProcessNames = @('Discord', 'DiscordPTB', 'DiscordCanary', 'DiscordDevelopment')

function Get-NFocusDiscordPids {
    $pids = @()
    foreach ($n in $script:NFocusDiscordProcessNames) {
        foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
            $pids += [uint32]$p.Id
        }
    }
    # Helper executables (DiscordHookHelper etc.) own sessions of their own.
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Discord*' })) {
        if ($pids -notcontains [uint32]$p.Id) { $pids += [uint32]$p.Id }
    }
    return @($pids | Sort-Object -Unique)
}

function Get-NFocusDiscordSessions {
    <# Current Discord-owned audio sessions across every active render endpoint. #>
    [CmdletBinding()]
    param()

    Import-NFocusInterop

    $out = @()
    foreach ($s in [NFocus.AudioSessions]::List()) {
        if ($s.IsSystemSounds) { continue }
        if ([string]::IsNullOrWhiteSpace($s.ProcessName)) { continue }
        if ($s.ProcessName -notlike 'Discord*') { continue }

        $out += [pscustomobject]@{
            pid         = [uint32]$s.ProcessId
            processName = $s.ProcessName
            exePath     = $s.ExePath
            endpointId  = $s.EndpointId
            muted       = [bool]$s.Muted
            volume      = [double]$s.Volume
            state       = [int]$s.State
        }
    }
    return $out
}

function Measure-NFocusDiscord {
    [CmdletBinding()]
    param()

    $sessions = @(Get-NFocusDiscordSessions)
    $running  = @(Get-NFocusDiscordPids)

    $mutedCount = @($sessions | Where-Object { $_.muted }).Count

    return [pscustomobject]@{
        processCount = $running.Count
        sessionCount = $sessions.Count
        mutedCount   = $mutedCount
        allMuted     = ($sessions.Count -gt 0 -and $mutedCount -eq $sessions.Count)
        sessions     = $sessions
    }
}

function Invoke-NFocusStepDiscord {
    [CmdletBinding()]
    param([switch]$DryRun)

    $step = New-NFocusStepResult
    $step.attempted = $true

    Import-NFocusInterop
    $prior = @(Get-NFocusDiscordSessions)

    Write-NFocusLog -Step 'discord' -Message ("prior: {0} Discord audio session(s), {1} already muted" -f `
        $prior.Count, @($prior | Where-Object { $_.muted }).Count)

    if ($prior.Count -eq 0) {
        $step.changed = $false
        $step.status  = 'NoAudioSession'
        Add-Member -InputObject $step -NotePropertyName 'sessions' -NotePropertyValue @()
        Add-Member -InputObject $step -NotePropertyName 'note' -NotePropertyValue `
            'Discord held no audio session, so there was nothing to mute. Discord creates one lazily when it first plays a sound.'
        Write-NFocusLog -Level WRN -Step 'discord' -Message 'No Discord audio session to mute.'
        return $step
    }

    $changed = 0
    if (-not $DryRun) {
        $pids = @($prior | ForEach-Object { $_.pid } | Sort-Object -Unique)
        $changed = [NFocus.AudioSessions]::SetMuteForPids([uint32[]]$pids, $true)
    }

    $records = @()
    foreach ($s in $prior) {
        $records += [pscustomobject]@{
            pid         = $s.pid
            processName = $s.processName
            exePath     = $s.exePath
            endpointId  = $s.endpointId
            prior       = [pscustomobject]@{ muted = $s.muted }
            applied     = [pscustomobject]@{ muted = $true }
        }
    }

    Add-Member -InputObject $step -NotePropertyName 'sessions' -NotePropertyValue $records
    $step.changed = ($changed -gt 0)
    $step.status  = 'Success'

    Write-NFocusLog -Step 'discord' -Message "muted $changed of $($prior.Count) Discord session(s)"
    return $step
}

function Revert-NFocusStepDiscord {
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

    Import-NFocusInterop

    $records = ConvertTo-NFocusArray $StepData.sessions
    if ($records.Count -eq 0) {
        $result.status = 'NothingToRevert'
        return $result
    }

    # Audio sessions are ephemeral: they do not survive a Discord restart, and
    # a reboot certainly clears them. Match on the live world, never blind-set.
    $live = @(Get-NFocusDiscordSessions)
    $toUnmute = @()

    foreach ($r in $records) {
        if ($r.prior.muted -eq $true -and -not $Force) {
            $result.notes += "PID $($r.pid) was already muted before NFocus; leaving it muted."
            continue
        }

        $match = $live | Where-Object { $_.pid -eq $r.pid -and $_.endpointId -eq $r.endpointId } | Select-Object -First 1
        if ($null -eq $match) {
            # Process gone or session expired -- nothing to put back.
            continue
        }
        if (-not $match.muted -and -not $Force) {
            $result.notes += "PID $($r.pid) was unmuted outside NFocus; leaving it alone."
            continue
        }

        $toUnmute += $r.pid
    }

    if ($toUnmute.Count -gt 0 -and -not $DryRun) {
        $n = [NFocus.AudioSessions]::SetMuteForPids([uint32[]]@($toUnmute | Sort-Object -Unique), $false)
        Write-NFocusLog -Step 'discord' -Message "unmuted $n session(s)"
    }

    $result.status = 'Reverted'
    return $result
}

function Reset-NFocusDiscordBestEffort {
    <# No state file: unmuting Discord is always safe and always reversible. #>
    [CmdletBinding()]
    param([switch]$DryRun)

    Import-NFocusInterop
    $pids = @(Get-NFocusDiscordPids)
    if ($pids.Count -eq 0) { return @('No Discord processes running.') }

    if (-not $DryRun) {
        $n = [NFocus.AudioSessions]::SetMuteForPids([uint32[]]$pids, $false)
        return @("Unmuted $n Discord audio session(s).")
    }
    return @("Would unmute Discord audio sessions for $($pids.Count) process(es).")
}

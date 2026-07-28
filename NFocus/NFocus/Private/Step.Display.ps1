# Step.Display.ps1 -- make the TV the sole active display, and put the desk
# layout back afterwards.
#
# This is the COMMIT POINT of the whole tool. It runs first (after a read-only
# preflight) so that the fragile step either succeeds or fails before anything
# else has been touched -- which makes the rollback set before it empty by
# construction, rather than merely small.
#
# Restore replays the exact captured path/mode arrays. The readable summary
# alongside them is for logs and coarse drift detection ONLY; a topology is
# never reconstructed from it.

function Get-NFocusActiveTargetKey {
    <# Stable signature of "which monitors are on", for coarse drift checks. #>
    $ids = @(Get-NFocusActiveTargets | ForEach-Object { $_.hardwareId } | Sort-Object)
    return ($ids -join ',')
}

function Measure-NFocusDisplay {
    [CmdletBinding()]
    param()

    $cfg = $null
    try { $cfg = Read-NFocusConfig } catch { }

    $tvId = $null
    if ($null -ne $cfg) { $tvId = $cfg.tvHardwareId }

    $active = @(Get-NFocusActiveTargets)
    $tvOnly = ($active.Count -eq 1 -and $null -ne $tvId -and $active[0].hardwareId -eq $tvId)

    return [pscustomobject]@{
        tvHardwareId = $tvId
        tvConnected  = (Test-NFocusTvPresent -HardwareId $tvId)
        activeCount  = $active.Count
        active       = $active
        tvOnly       = $tvOnly
        key          = (($active | ForEach-Object { $_.hardwareId } | Sort-Object) -join ',')
    }
}

function Test-NFocusTvPresent {
    <#
        Preflight. Deliberately only checks that the TV's target PATH EXISTS --
        not that it is active, and not that it is at a plausible resolution.
        Enabling the mode and then walking over to switch the TV on is a normal
        flow, and a TV behind a live HDMI link reports active whether or not the
        panel is lit, so a stricter check would block legitimate use without
        actually detecting a dark screen.
    #>
    [CmdletBinding()]
    param([string]$HardwareId)

    if ([string]::IsNullOrWhiteSpace($HardwareId)) { return $false }

    try {
        Import-NFocusInterop
        $all = [NFocus.Ccd]::Query([NFocus.Ccd]::QDC_ALL_PATHS)
        return ([NFocus.Ccd]::FindPathByHardwareId($all, $HardwareId) -ge 0)
    }
    catch {
        return $false
    }
}

function Get-NFocusDisplaySnapshot {
    <# Capture the current active topology as an opaque blob plus a summary. #>
    [CmdletBinding()]
    param()

    Import-NFocusInterop

    # ONLY_ACTIVE_PATHS is the clean payload to persist and replay. Feeding a
    # full all-paths array (354 entries here) back into SetDisplayConfig invites
    # validation failures over paths we never cared about.
    $cfg  = [NFocus.Ccd]::Query([NFocus.Ccd]::QDC_ONLY_ACTIVE_PATHS)
    $blob = [NFocus.Ccd]::Serialize($cfg)

    return [pscustomobject]@{
        captureMethod     = 'CCD.QueryDisplayConfig'
        blobFormatVersion = 1
        queryFlags        = [uint32]$cfg.QueryFlags
        pathCount         = $cfg.Paths.Length
        modeCount         = $cfg.Modes.Length
        topologyBlobBase64 = [Convert]::ToBase64String($blob)
        summary           = @(Get-NFocusActiveTargets)
    }
}

function Invoke-NFocusApplyTopologyBlob {
    <# Replay a captured blob, walking down a ladder of increasingly permissive
       flags. Logs which rung actually worked. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Base64)

    Import-NFocusInterop

    $cfg = [NFocus.Ccd]::Deserialize([Convert]::FromBase64String($Base64))

    # THE LUID TRAP: adapter LUIDs are regenerated every boot, so a blob saved
    # before a reboot carries stale ones and SetDisplayConfig fails with
    # ERROR_INVALID_PARAMETER. Re-resolve them by stable adapter device path.
    $unresolved = [NFocus.Ccd]::RemapAdapterIds($cfg)
    if ($unresolved -gt 0) {
        Write-NFocusLog -Level WRN -Step 'display' -Message "$unresolved adapter(s) in the saved topology no longer exist."
    }

    $C = [NFocus.Ccd]
    $base = $C::SDC_APPLY -bor $C::SDC_USE_SUPPLIED_DISPLAY_CONFIG -bor $C::SDC_SAVE_TO_DATABASE

    $ladder = @(
        [pscustomobject]@{ name = 'supplied';            flags = ($base -bor $C::SDC_ALLOW_CHANGES) }
        [pscustomobject]@{ name = 'supplied+pathorder';  flags = ($base -bor $C::SDC_ALLOW_CHANGES -bor $C::SDC_ALLOW_PATH_ORDER_CHANGES) }
    )

    foreach ($rung in $ladder) {
        $rc = $C::Apply($cfg.Paths, $cfg.Modes, [uint32]$rung.flags)
        if ($rc -eq 0) {
            Write-NFocusLog -Step 'display' -Message "Restored topology via '$($rung.name)'."
            return $true
        }
        Write-NFocusLog -Level WRN -Step 'display' -Message "Restore rung '$($rung.name)' failed: $rc ($($C::Describe($rc)))."
    }

    # Last resorts: forget the saved geometry, just get the monitors back on.
    $rc = $C::Apply($null, $null, [uint32]($C::SDC_APPLY -bor $C::SDC_TOPOLOGY_EXTEND))
    if ($rc -eq 0) {
        Write-NFocusLog -Level WRN -Step 'display' -Message 'Restored via SDC_TOPOLOGY_EXTEND (saved geometry was not usable).'
        return $true
    }
    Write-NFocusLog -Level WRN -Step 'display' -Message "SDC_TOPOLOGY_EXTEND failed: $rc ($($C::Describe($rc)))."

    try {
        Start-Process -FilePath 'DisplaySwitch.exe' -ArgumentList '/extend' -WindowStyle Hidden -Wait -ErrorAction Stop
        Write-NFocusLog -Level WRN -Step 'display' -Message 'Fell back to DisplaySwitch.exe /extend.'
        return $true
    }
    catch {
        Write-NFocusLog -Level ERR -Step 'display' -Message "DisplaySwitch.exe failed: $($_.Exception.Message)"
        return $false
    }
}

# ------------------------------------------------------------- deadman ------

function Get-NFocusDeadmanPath {
    return (Join-Path $script:NFocusStateDir 'deadman.json')
}

function Start-NFocusDeadman {
    <#
        Arm an auto-revert BEFORE touching the display. A detached process waits
        ConfirmTimeout seconds and, if the marker file still exists, replays the
        saved topology.

        What this actually protects against: the apply silently not taking, or
        this script dying between applying and verifying. It CANNOT detect "the
        TV is powered off" -- a dark TV behind a live HDMI link reports active,
        so that case is indistinguishable through the CCD API. The real rescue
        for a dark TV is the physical Disable binding plus the failure beep.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Base64,
        [int]$TimeoutSeconds = 40
    )

    $marker = Get-NFocusDeadmanPath
    $payload = [pscustomobject]@{
        armedUtc           = (Get-Date).ToUniversalTime().ToString('o')
        timeoutSeconds     = $TimeoutSeconds
        topologyBlobBase64 = $Base64
    }
    [System.IO.File]::WriteAllText($marker, (ConvertTo-Json $payload -Depth 5), $script:NFocusUtf8NoBom)

    $manifest = Join-Path $script:NFocusModuleRoot 'NFocus.psd1'
    $inner = @"
Start-Sleep -Seconds $TimeoutSeconds
if (-not (Test-Path -LiteralPath '$marker')) { exit 0 }
Import-Module '$manifest' -Force
& (Get-Module NFocus) {
    Initialize-NFocusLog -Operation 'deadman'
    Write-NFocusLog -Level WRN -Step 'display' -Message 'Deadman fired: the display switch was never confirmed. Restoring.'
    `$d = ConvertFrom-Json ([System.IO.File]::ReadAllText('$marker'))
    `$null = Invoke-NFocusApplyTopologyBlob -Base64 `$d.topologyBlobBase64
    Remove-Item -LiteralPath '$marker' -Force -ErrorAction SilentlyContinue
    try { [Console]::Beep(220,400) } catch { }
}
"@
    $b64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))

    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64) `
        -WindowStyle Hidden | Out-Null

    Write-NFocusLog -Step 'display' -Message "Deadman armed for ${TimeoutSeconds}s."
}

function Stop-NFocusDeadman {
    $marker = Get-NFocusDeadmanPath
    if (Test-Path -LiteralPath $marker) {
        Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
        Write-NFocusLog -Step 'display' -Message 'Deadman disarmed (switch confirmed).'
    }
}

# ---------------------------------------------------------------- enable ----

function Invoke-NFocusStepDisplay {
    [CmdletBinding()]
    param(
        [switch]$DryRun,
        [int]$ConfirmTimeout = 40
    )

    $step = New-NFocusStepResult
    $step.attempted = $true

    Import-NFocusInterop
    $C = [NFocus.Ccd]

    $cfg = Read-NFocusConfig
    if ($null -eq $cfg -or [string]::IsNullOrWhiteSpace($cfg.tvHardwareId)) {
        $step.status = 'NoTvRegistered'
        $step.error  = 'No TV registered. Run Register-NFocusTv.ps1 once with the TV connected.'
        return $step
    }
    $tvId = $cfg.tvHardwareId

    $prior = Get-NFocusDisplaySnapshot
    Add-Member -InputObject $step -NotePropertyName 'prior' -NotePropertyValue $prior

    Write-NFocusLog -Step 'display' -Message ("prior: {0} active -> {1}" -f `
        $prior.summary.Count, (($prior.summary | ForEach-Object { "$($_.hardwareId) $($_.width)x$($_.height)@($($_.x),$($_.y))" }) -join ' | '))

    $all = $C::Query($C::QDC_ALL_PATHS)
    $idx = $C::FindPathByHardwareId($all, $tvId)
    if ($idx -lt 0) {
        $step.status = 'TvNotConnected'
        $step.error  = "The TV ($tvId) has no display path -- it is not connected."
        return $step
    }

    # Already TV-only? Then there is nothing to do, and critically nothing to
    # capture either (capturing now would record our own end state as the
    # user's baseline).
    $activeNow = @(Get-NFocusActiveTargets)
    if ($activeNow.Count -eq 1 -and $activeNow[0].hardwareId -eq $tvId) {
        $step.changed = $false
        $step.status  = 'AlreadyInDesiredState'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{
            summary = $activeNow
        })
        return $step
    }

    if ($DryRun) {
        $step.changed = $true
        $step.status  = 'WouldSwitch'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ summary = @() })
        return $step
    }

    if ($ConfirmTimeout -gt 0) {
        Start-NFocusDeadman -Base64 $prior.topologyBlobBase64 -TimeoutSeconds $ConfirmTimeout
    }

    # Mode indices left invalid and no mode array supplied: Windows picks valid
    # modes itself under SDC_ALLOW_CHANGES. Hand-building mode arrays for the
    # enable direction is unnecessary risk; verbatim arrays are for restore.
    $paths = $C::BuildSingleTargetPaths($all, $idx)
    $flags = $C::SDC_APPLY -bor $C::SDC_USE_SUPPLIED_DISPLAY_CONFIG -bor `
             $C::SDC_ALLOW_CHANGES -bor $C::SDC_SAVE_TO_DATABASE

    $rc = $C::Apply($paths, $null, [uint32]$flags)
    if ($rc -ne 0) {
        Write-NFocusLog -Level ERR -Step 'display' -Message "SetDisplayConfig failed: $rc ($($C::Describe($rc)))"
        Stop-NFocusDeadman
        $step.changed = $false
        $step.status  = 'Failed'
        $step.error   = "SetDisplayConfig failed: $rc ($($C::Describe($rc)))"
        return $step
    }

    Start-Sleep -Milliseconds 400
    $after = @(Get-NFocusActiveTargets)
    $tvSole = ($after.Count -eq 1 -and $after[0].hardwareId -eq $tvId)

    if (-not $tvSole) {
        Write-NFocusLog -Level ERR -Step 'display' -Message ("Verification failed: active = {0}" -f `
            (($after | ForEach-Object { $_.hardwareId }) -join ','))
        $step.changed = $true
        $step.status  = 'VerificationFailed'
        $step.error   = 'The switch was applied but the TV is not the sole active display.'
        Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ summary = $after })
        # Leave the deadman armed on purpose -- it will put things back.
        return $step
    }

    Stop-NFocusDeadman

    $tv = $after[0]
    Write-NFocusLog -Step 'display' -Message ("TV is now sole display: {0} {1}x{2}" -f $tv.hardwareId, $tv.width, $tv.height)

    # The TV was seen at 1280x720 during development while the panel was off,
    # so a suspiciously low mode is worth recording even though we do not block.
    if ($null -ne $cfg.tvPreferredMode -and $cfg.tvPreferredMode.width -gt 0 -and
        $tv.width -lt $cfg.tvPreferredMode.width) {
        Write-NFocusLog -Level WRN -Step 'display' -Message ("TV came up at {0}x{1}, below its native {2}x{3}." -f `
            $tv.width, $tv.height, $cfg.tvPreferredMode.width, $cfg.tvPreferredMode.height)
    }

    $step.changed = $true
    $step.status  = 'Success'
    Add-Member -InputObject $step -NotePropertyName 'applied' -NotePropertyValue ([pscustomobject]@{ summary = $after })
    return $step
}

# ---------------------------------------------------------------- revert ----

function Revert-NFocusStepDisplay {
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
        return $result
    }
    if ($null -eq $StepData.prior -or [string]::IsNullOrWhiteSpace($StepData.prior.topologyBlobBase64)) {
        $result.status = 'NoSnapshot'
        $result.notes += 'No topology snapshot was recorded, so the layout cannot be restored.'
        return $result
    }

    # Coarse compare-and-swap. A true CAS on the opaque blob is impractical, so
    # compare the set of active monitors instead. If it has already drifted
    # somewhere else, the user (or Windows) has moved on and replaying a stale
    # topology would fight them.
    if (-not $Force -and $null -ne $StepData.applied) {
        $expected = (@(ConvertTo-NFocusArray $StepData.applied.summary |
                       ForEach-Object { $_.hardwareId } | Sort-Object) -join ',')
        $actual   = Get-NFocusActiveTargetKey
        if ($expected -ne '' -and $expected -ne $actual) {
            $result.status = 'Drifted'
            $result.notes += "Display layout changed outside NFocus (expected '$expected', found '$actual'); leaving it alone. Use -Force to restore anyway."
            Write-NFocusLog -Level WRN -Step 'display' -Message $result.notes[-1]
            return $result
        }
    }

    if ($DryRun) {
        $result.status = 'WouldRestore'
        return $result
    }

    if (Invoke-NFocusApplyTopologyBlob -Base64 $StepData.prior.topologyBlobBase64) {
        Start-Sleep -Milliseconds 400
        $result.status = 'Reverted'
        $now = @(Get-NFocusActiveTargets)
        Write-NFocusLog -Step 'display' -Message ("restored: {0}" -f (($now | ForEach-Object { "$($_.hardwareId) $($_.width)x$($_.height)" }) -join ' | '))
    }
    else {
        $result.status = 'Failed'
        $result.notes += 'Could not restore the display layout. Press Win+P to recover manually.'
    }

    return $result
}

function Register-NFocusTv {
    <#
    .SYNOPSIS
        Learn which display is the TV. Run once, with the TV connected.

    .DESCRIPTION
        Persists the TV's EDID hardware id (e.g. "TCL9653") to config.json.
        That id is the only stable identity available here:

          * targetId / UID is NOT unique -- on this machine the TV and the ASUS
            VG24V share the same physical port and therefore the same UID4352.
          * the adapter LUID is regenerated on every boot.
          * the GDI name (\\.\DISPLAY2) moves between monitors between boots.

        Config is stored separately from state.json so that learning the TV
        survives deleting or archiving a session state file.

    .PARAMETER HardwareId
        Pick a specific target instead of auto-detecting (e.g. "TCL9653").

    .PARAMETER List
        Show the candidates and exit without writing anything.

    .PARAMETER Force
        Overwrite an existing registration without prompting.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$HardwareId,
        [switch]$List,
        [switch]$Force
    )

    Initialize-NFocusLog -Operation 'register-tv'
    Import-NFocusInterop

    $candidates = Get-NFocusCandidateTargets
    if ($candidates.Count -eq 0) {
        throw 'No display targets could be enumerated at all. That should not happen -- check the graphics driver.'
    }

    Write-Host ''
    Write-Host 'Display targets known to Windows:' -ForegroundColor Cyan
    foreach ($c in $candidates) {
        Write-Host ('  ' + (Format-NFocusTargetLine $c))
    }
    Write-Host ''

    if ($List) { return }

    # --- choose the TV ---------------------------------------------------
    $chosen = $null

    if (-not [string]::IsNullOrWhiteSpace($HardwareId)) {
        $chosen = $candidates | Where-Object { $_.hardwareId -eq $HardwareId } | Select-Object -First 1
        if ($null -eq $chosen) {
            throw "No display target with hardware id '$HardwareId'. Run with -List to see the candidates."
        }
    }
    else {
        # Auto-detect: a TV is on HDMI and connected. Anything else is
        # ambiguous and the user should say which one explicitly.
        $hdmi = @($candidates | Where-Object { $_.techRaw -eq 5 -and $_.active })
        if ($hdmi.Count -eq 1) {
            $chosen = $hdmi[0]
            Write-Host ("Auto-detected the only connected HDMI display: {0} ('{1}')" -f $chosen.hardwareId, $chosen.friendly) -ForegroundColor Green
        }
        elseif ($hdmi.Count -gt 1) {
            throw ("Found {0} connected HDMI displays. Re-run with -HardwareId to say which is the TV." -f $hdmi.Count)
        }
        else {
            throw 'No connected HDMI display found. Switch the TV on, make sure Windows sees it, then re-run. Or pass -HardwareId explicitly.'
        }
    }

    if (-not $chosen.active) {
        Write-Warning "'$($chosen.hardwareId)' is not currently connected, so its preferred resolution cannot be read."
    }

    # --- preferred (native) mode ----------------------------------------
    # Worth capturing: the TV was observed running at 1280x720 during
    # development, which is the signature of an HDMI link that is up while the
    # panel is off. If SDC_ALLOW_CHANGES later picks a low mode we want a known
    # native target to fall back on.
    $prefW = 0
    $prefH = 0
    if ($chosen.active) {
        $all = [NFocus.Ccd]::Query([NFocus.Ccd]::QDC_ALL_PATHS)
        $idx = [NFocus.Ccd]::FindPathByHardwareId($all, $chosen.hardwareId)
        if ($idx -ge 0) {
            # Must be uint32 to bind to the C# `out uint` parameters.
            $w = [uint32]0; $h = [uint32]0
            $adapterId = $all.Paths[$idx].targetInfo.adapterId
            $targetId  = $all.Paths[$idx].targetInfo.id
            if ([NFocus.Ccd]::TryGetPreferredMode($adapterId, $targetId, [ref]$w, [ref]$h)) {
                $prefW = [int]$w
                $prefH = [int]$h
            }
        }
    }

    $existing = Read-NFocusConfig
    if ($null -ne $existing -and $existing.tvHardwareId -and -not $Force) {
        if ($existing.tvHardwareId -eq $chosen.hardwareId) {
            Write-Host "'$($chosen.hardwareId)' is already registered as the TV. Nothing to do." -ForegroundColor Green
            return
        }
        Write-Warning "A different TV is already registered: '$($existing.tvHardwareId)'. Re-run with -Force to replace it."
        return
    }

    $config = [pscustomobject]@{
        schemaVersion      = 1
        tvHardwareId       = $chosen.hardwareId
        tvFriendlyName     = $chosen.friendly
        tvOutputTechnology = [int]$chosen.techRaw
        tvLastDevicePath   = $chosen.devicePath
        tvPreferredMode    = [pscustomobject]@{ width = $prefW; height = $prefH }
        tvRegisteredUtc    = (Get-Date).ToUniversalTime().ToString('o')
    }

    # Carry forward anything an earlier config held that we do not own here.
    if ($null -ne $existing -and $existing.PSObject.Properties.Name -contains 'bluetoothInstanceId') {
        Add-Member -InputObject $config -NotePropertyName 'bluetoothInstanceId' `
                   -NotePropertyValue $existing.bluetoothInstanceId
    }

    Write-Host ''
    Write-Host 'About to register this display as the TV:' -ForegroundColor Cyan
    Write-Host ("  hardware id : {0}" -f $config.tvHardwareId)
    Write-Host ("  name        : {0}" -f $config.tvFriendlyName)
    Write-Host ("  connection  : {0}" -f $chosen.tech)
    if ($prefW -gt 0) {
        Write-Host ("  native mode : {0}x{1}" -f $prefW, $prefH)
    }
    else {
        Write-Host '  native mode : unknown (TV not connected)'
    }
    Write-Host ''

    if ($PSCmdlet.ShouldProcess((Get-NFocusConfigPath), 'Write TV registration')) {
        Write-NFocusConfig -Config $config
        Write-NFocusLog -Step 'register-tv' -Message ("Registered TV {0} ('{1}') native {2}x{3}" -f `
            $config.tvHardwareId, $config.tvFriendlyName, $prefW, $prefH)
        Write-Host "Saved to $(Get-NFocusConfigPath)" -ForegroundColor Green
    }
}

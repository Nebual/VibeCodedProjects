function Get-NFocusStatus {
    <#
    .SYNOPSIS
        Report what NFocus thinks is true and what the machine actually says.

    .DESCRIPTION
        Read-only, takes no mutex, safe at any time. Reports RECORDED state
        (from state.json) alongside MEASURED state (from the live machine), so
        drift is visible rather than inferred.

        Overall values: Inactive, Active, Stale, Partial, Drifted, Corrupt.
    #>
    [CmdletBinding()]
    param()

    Initialize-NFocusLog -Operation 'status'

    $state   = $null
    $corrupt = $null
    try {
        $state = Read-NFocusState
    }
    catch {
        $corrupt = $_.Exception.Message
    }

    $config = $null
    try { $config = Read-NFocusConfig } catch { }

    $measured = [pscustomobject]@{
        notifications = (Measure-NFocusNotifications)
        display       = (Measure-NFocusDisplay)
        bluetooth     = (Measure-NFocusBluetooth)
        discord       = (Measure-NFocusDiscord)
    }

    $overall = 'Inactive'
    if ($null -ne $corrupt) {
        $overall = 'Corrupt'
    }
    elseif ($null -ne $state) {
        $overall = 'Active'
        if ($state.partial) { $overall = 'Partial' }
        if (Test-NFocusStateStale -State $state) { $overall = 'Stale' }
    }

    # Drift: we believe the mode is active, but the world no longer matches
    # what we actually applied.
    if ($overall -eq 'Active') {
        $dstep = Get-NFocusStep -State $state -Name 'display'
        if ($null -ne $dstep -and $dstep.changed -and $null -ne $dstep.applied) {
            $expected = (@(ConvertTo-NFocusArray $dstep.applied.summary |
                           ForEach-Object { $_.hardwareId } | Sort-Object) -join ',')
            if ($expected -ne '' -and $expected -ne $measured.display.key) { $overall = 'Drifted' }
        }
    }

    $enabledAt = $null
    $sessionId = $null
    $partial   = $false
    $failures  = @()
    $recorded  = $null
    if ($null -ne $state) {
        $enabledAt = $state.enabledAtUtc
        $sessionId = $state.sessionId
        $partial   = [bool]$state.partial
        $failures  = @(ConvertTo-NFocusArray $state.failures)
        $recorded  = $state.steps
    }

    $tvId = $null
    if ($null -ne $config) { $tvId = $config.tvHardwareId }

    return [pscustomobject]@{
        overall       = $overall
        stateFile     = (Get-NFocusStatePath)
        stateExists   = (Test-NFocusStateExists)
        corruptReason = $corrupt
        enabledAtUtc  = $enabledAt
        sessionId     = $sessionId
        rebooted      = (Test-NFocusStateStale -State $state)
        partial       = $partial
        failures      = $failures
        tvRegistered  = (-not [string]::IsNullOrWhiteSpace($tvId))
        tvHardwareId  = $tvId
        btTasks       = (Test-NFocusBtTasksRegistered)
        elevated      = (Test-NFocusElevated)
        measured      = $measured
        recorded      = $recorded
    }
}

function Write-NFocusStatusReport {
    <# Human-readable rendering of Get-NFocusStatus. #>
    [CmdletBinding()]
    param([switch]$Json)

    $s = Get-NFocusStatus

    if ($Json) {
        ConvertTo-Json -InputObject $s -Depth 12
        return
    }

    $colour = 'Yellow'
    if ($s.overall -eq 'Active')   { $colour = 'Green' }
    if ($s.overall -eq 'Inactive') { $colour = 'Gray' }

    Write-Host ''
    Write-Host 'NFocus -- TV Gaming Mode' -ForegroundColor Cyan
    Write-Host ('  status      : {0}' -f $s.overall) -ForegroundColor $colour
    if ($s.enabledAtUtc)  { Write-Host ('  enabled at  : {0} UTC' -f $s.enabledAtUtc) }
    if ($s.rebooted)      { Write-Host '  note        : the machine rebooted while the mode was active' -ForegroundColor Yellow }
    if ($s.corruptReason) { Write-Host ('  problem     : {0}' -f $s.corruptReason) -ForegroundColor Red }

    foreach ($f in $s.failures) {
        Write-Host ('  failure     : [{0}] {1}' -f $f.step, $f.message) -ForegroundColor Red
    }

    Write-Host ''
    Write-Host '  Setup' -ForegroundColor Cyan
    $tvText = 'NOT REGISTERED -- run Register-NFocusTv.ps1 with the TV connected'
    if ($s.tvRegistered) { $tvText = $s.tvHardwareId }
    Write-Host ('    TV registered      : {0}' -f $tvText)
    $btText = 'no  (toggles will raise a UAC prompt -- run Install-NFocus.ps1)'
    if ($s.btTasks) { $btText = 'yes' }
    Write-Host ('    Bluetooth tasks    : {0}' -f $btText)

    Write-Host ''
    Write-Host '  Measured now' -ForegroundColor Cyan

    $d = $s.measured.display
    $tvOnlyNote = ''
    if ($d.tvOnly) { $tvOnlyNote = '  (TV only)' }
    Write-Host ('    displays active    : {0}{1}' -f $d.activeCount, $tvOnlyNote)
    foreach ($t in $d.active) {
        $pri = ''
        if ($t.primary) { $pri = ' primary' }
        Write-Host ('      {0,-9} {1}x{2} @({3},{4}){5}' -f $t.hardwareId, $t.width, $t.height, $t.x, $t.y, $pri)
    }
    Write-Host ('    TV connected       : {0}' -f $d.tvConnected)

    $b = $s.measured.bluetooth
    if ($b.found) {
        $bs = 'enabled'
        if ($b.enabled -eq $false) { $bs = 'disabled' }
        Write-Host ('    bluetooth          : {0}  ({1})' -f $bs, $b.name)
    }
    else {
        Write-Host '    bluetooth          : no present adapter'
    }

    $c = $s.measured.discord
    Write-Host ('    discord            : {0} process(es), {1} audio session(s), {2} muted' -f `
        $c.processCount, $c.sessionCount, $c.mutedCount)
    if ($c.processCount -gt 0 -and $c.sessionCount -eq 0) {
        Write-Host '                         (no audio session exists yet, so there is nothing to mute)' -ForegroundColor DarkGray
    }

    $n = $s.measured.notifications
    $toast = '<absent>'
    if ($n.toastEnabled.present) { $toast = $n.toastEnabled.data }
    $noc = '<absent>'
    if ($n.nocEnabled.present) { $noc = $n.nocEnabled.data }
    Write-Host ('    do not disturb     : {0}' -f $n.focusActive)
    Write-Host ('    ToastEnabled       : {0}' -f $toast)
    Write-Host ('    NOC_GLOBAL...      : {0}' -f $noc)
    Write-Host ''
}

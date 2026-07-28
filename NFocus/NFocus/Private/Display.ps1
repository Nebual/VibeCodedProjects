# Display.ps1 -- shared display helpers over the CCD interop.

$script:NFocusOutputTech = @{
    0  = 'VGA';        1  = 'S-Video';   2  = 'Composite'; 3  = 'Component'
    4  = 'DVI';        5  = 'HDMI';      6  = 'LVDS';      8  = 'D-JPN'
    9  = 'SDI';        10 = 'DisplayPort'; 11 = 'DisplayPort (embedded)'
    12 = 'UDI';        13 = 'UDI (embedded)'; 14 = 'SDTV dongle'
    15 = 'Miracast';   16 = 'Indirect (wired)'; 17 = 'Indirect (virtual)'
}

function Get-NFocusOutputTechnologyName {
    param([uint32]$Value)

    if ($Value -eq 0x80000000) { return 'Internal' }
    if ($Value -eq 0xFFFFFFFF) { return 'Other' }
    if ($script:NFocusOutputTech.ContainsKey([int]$Value)) { return $script:NFocusOutputTech[[int]$Value] }
    return "Tech$Value"
}

function Get-NFocusActiveTargets {
    <# Active display targets as plain objects, newest snapshot each call. #>
    [CmdletBinding()]
    param()

    Import-NFocusInterop
    $cfg = [NFocus.Ccd]::Query([NFocus.Ccd]::QDC_ONLY_ACTIVE_PATHS)

    $out = @()
    foreach ($t in [NFocus.Ccd]::ListTargets($cfg)) {
        if (-not $t.Active) { continue }

        $refresh = 0
        if ($t.RefreshDenominator -gt 0) {
            $refresh = [math]::Round($t.RefreshNumerator / $t.RefreshDenominator, 2)
        }

        $out += [pscustomobject]@{
            hardwareId = $t.HardwareId
            friendly   = $t.FriendlyName
            tech       = (Get-NFocusOutputTechnologyName $t.OutputTechnology)
            width      = [int]$t.Width
            height     = [int]$t.Height
            x          = [int]$t.PositionX
            y          = [int]$t.PositionY
            primary    = [bool]$t.IsPrimary
            refresh    = $refresh
        }
    }
    return $out
}

function Get-NFocusCandidateTargets {
    <#
        Every target the graphics stack can name, deduplicated by hardware id.
        QDC_ALL_PATHS returns hundreds of paths (354 on this machine) and the
        same monitor appears on many of them, so dedupe and prefer active.
    #>
    [CmdletBinding()]
    param()

    Import-NFocusInterop
    $cfg = [NFocus.Ccd]::Query([NFocus.Ccd]::QDC_ALL_PATHS)

    $seen = @{}
    foreach ($t in [NFocus.Ccd]::ListTargets($cfg)) {
        if ([string]::IsNullOrWhiteSpace($t.HardwareId)) { continue }

        $key = $t.HardwareId
        if ($seen.ContainsKey($key) -and -not $t.Active) { continue }

        $seen[$key] = [pscustomobject]@{
            hardwareId = $t.HardwareId
            friendly   = $t.FriendlyName
            tech       = (Get-NFocusOutputTechnologyName $t.OutputTechnology)
            techRaw    = [uint32]$t.OutputTechnology
            active     = [bool]$t.Active
            devicePath = $t.DevicePath
            pathIndex  = [int]$t.PathIndex
            targetId   = [uint32]$t.TargetId
        }
    }

    return @($seen.Values | Sort-Object -Property @{ Expression = 'active'; Descending = $true }, 'hardwareId')
}

function Format-NFocusTargetLine {
    param($Target)
    $flag = if ($Target.active) { 'connected' } else { 'not connected' }
    return ('{0,-10} {1,-18} {2,-12} {3}' -f $Target.hardwareId, $Target.friendly, $Target.tech, $flag)
}

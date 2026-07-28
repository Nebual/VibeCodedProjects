# State.ps1 -- state/config persistence and the tri-state capture primitives.
#
# The whole correctness story of this tool lives here. The governing rule:
#
#     Revert means "put back exactly what was there", NOT "write the default".
#
# This machine proves why. At the time of writing, ToastEnabled is PRESENT=1
# while NOC_GLOBAL_SETTING_TOASTS_ENABLED is ABSENT. One restores by writing a
# value; the other restores by DELETING it. A boolean cannot express that
# difference, so every captured value is a tri-state {present, kind, data}.

$script:NFocusSchemaVersion = 1

# ---------------------------------------------------------------- paths -----

function Get-NFocusStatePath  { return (Join-Path $script:NFocusStateDir 'state.json') }
function Get-NFocusConfigPath { return (Join-Path $script:NFocusStateDir 'config.json') }

function Confirm-NFocusStateDir {
    [CmdletBinding()]
    param()

    $dir = $script:NFocusStateDir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop | Out-Null
    }

    # State lives beside the scripts, so it can land somewhere read-only (a
    # locked-down folder, a synced share). Prove writability up front instead of
    # discovering it half-way through a toggle with the display already switched.
    $probe = Join-Path $dir ('.probe-' + [guid]::NewGuid().ToString('n').Substring(0, 8))
    try {
        [System.IO.File]::WriteAllText($probe, 'x', $script:NFocusUtf8NoBom)
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
    catch {
        throw "NFocus state directory is not writable: $dir -- $($_.Exception.Message)"
    }
}

# ------------------------------------------------- tri-state registry -------

function Get-NFocusRegistryValue {
    <#
        Reads a registry value as a tri-state capture. An absent value is a
        first-class result, not an error and not a $null-shaped guess.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $absent = [pscustomobject]@{ present = $false; kind = $null; data = $null }

    if (-not (Test-Path -LiteralPath $Path)) { return $absent }
    $key = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($null -eq $key) { return $absent }
    if ($key.GetValueNames() -notcontains $Name) { return $absent }

    return [pscustomobject]@{
        present = $true
        kind    = $key.GetValueKind($Name).ToString()
        data    = $key.GetValue($Name)
    }
}

function Set-NFocusRegistryDword {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Value
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
    }
    New-ItemProperty -LiteralPath $Path -Name $Name -Value $Value `
        -PropertyType DWord -Force -ErrorAction Stop | Out-Null
}

function Restore-NFocusRegistryValue {
    <#
        Puts a captured tri-state back. present:$false means Remove-ItemProperty
        -- this is the branch that makes revert honest.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Capture
    )

    if (-not $Capture.present) {
        if (Test-Path -LiteralPath $Path) {
            Remove-ItemProperty -LiteralPath $Path -Name $Name -Force -ErrorAction SilentlyContinue
        }
        return
    }

    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -Path $Path -Force -ErrorAction Stop | Out-Null
    }

    $kind = $Capture.kind
    if ([string]::IsNullOrWhiteSpace($kind) -or $kind -eq 'Unknown' -or $kind -eq 'None') {
        $kind = 'DWord'
    }
    New-ItemProperty -LiteralPath $Path -Name $Name -Value $Capture.data `
        -PropertyType $kind -Force -ErrorAction Stop | Out-Null
}

function Test-NFocusValueEqual {
    [CmdletBinding()]
    param($A, $B)

    if ($null -eq $A -or $null -eq $B) { return $false }
    if ([bool]$A.present -ne [bool]$B.present) { return $false }
    if (-not [bool]$A.present) { return $true }
    if ("$($A.kind)" -ne "$($B.kind)") { return $false }
    return ("$($A.data)" -eq "$($B.data)")
}

# ------------------------------------------------------------ identity -----

function Get-NFocusBootId {
    <# Free reboot detector: the boot timestamp doubles as a session identity. #>
    try {
        $boot = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
        return ([datetime]$boot).ToUniversalTime().ToString('o')
    }
    catch {
        return $null
    }
}

# ------------------------------------------------------- state objects -----

function New-NFocusStateObject {
    [CmdletBinding()]
    param()

    return [pscustomobject]@{
        schemaVersion = $script:NFocusSchemaVersion
        toolVersion   = $script:NFocusVersion
        sessionId     = $script:NFocusSessionId
        phase         = 'applying'    # two-phase commit: 'applying' -> 'active'
        enabledAtUtc  = (Get-Date).ToUniversalTime().ToString('o')
        bootId        = (Get-NFocusBootId)
        hostname      = $env:COMPUTERNAME
        user          = $env:USERNAME
        partial       = $false
        failures      = @()
        steps         = [pscustomobject]@{}
    }
}

function New-NFocusStepResult {
    [CmdletBinding()]
    param([string]$Status = 'NotAttempted')

    return [pscustomobject]@{
        attempted = $false
        changed   = $false
        status    = $Status
        error     = $null
    }
}

function Set-NFocusStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Value
    )

    if ($State.steps.PSObject.Properties.Name -contains $Name) {
        $State.steps.$Name = $Value
    }
    else {
        Add-Member -InputObject $State.steps -NotePropertyName $Name -NotePropertyValue $Value
    }
}

function Get-NFocusStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $State -or $null -eq $State.steps) { return $null }
    if ($State.steps.PSObject.Properties.Name -contains $Name) { return $State.steps.$Name }
    return $null
}

function Add-NFocusFailure {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Step,
        [Parameter(Mandatory = $true)][string]$Message
    )

    $State.partial  = $true
    $State.failures = @($State.failures) + @([pscustomobject]@{ step = $Step; message = $Message })
}

function Test-NFocusStateStale {
    <# True when the machine rebooted since the state file was written. #>
    [CmdletBinding()]
    param($State)

    if ($null -eq $State) { return $false }
    $now = Get-NFocusBootId
    if ([string]::IsNullOrWhiteSpace($now))            { return $false }
    if ([string]::IsNullOrWhiteSpace("$($State.bootId)")) { return $false }
    return ("$($State.bootId)" -ne $now)
}

# ------------------------------------------------------------- storage -----

function Write-NFocusState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$State,
        [switch]$CreateNew
    )

    Confirm-NFocusStateDir
    $path = Get-NFocusStatePath
    $json = ConvertTo-Json -InputObject $State -Depth 12

    if ($CreateNew) {
        # Anti-double-enable layer 3. If the file materialised between the
        # existence check and this write -- which is exactly what a Stream Deck
        # double-tap looks like -- CreateNew throws and we abort rather than
        # clobber a good baseline with an already-modified one.
        $stream = [System.IO.File]::Open(
            $path,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None)
        try {
            $bytes = $script:NFocusUtf8NoBom.GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
        }
        finally {
            $stream.Dispose()
        }
        return
    }

    # Torn JSON is unrecoverable, so never write in place. File.Replace is a
    # single NTFS transaction and hands us the .bak for free.
    $tmp = $path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $script:NFocusUtf8NoBom)
    if (Test-Path -LiteralPath $path) {
        [System.IO.File]::Replace($tmp, $path, ($path + '.bak'), $true)
    }
    else {
        [System.IO.File]::Move($tmp, $path)
    }
}

function Test-NFocusStateExists {
    return (Test-Path -LiteralPath (Get-NFocusStatePath))
}

function Read-NFocusState {
    <#
        Returns $null when no state file exists (mode is off). Throws when one
        exists but cannot be trusted -- callers translate that to exit 4 and
        archive it rather than risk misparsing a newer schema.
    #>
    [CmdletBinding()]
    param()

    $path = Get-NFocusStatePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }

    $raw = $null
    try {
        $raw = [System.IO.File]::ReadAllText($path)
    }
    catch {
        throw "NFocus state file could not be read: $($_.Exception.Message)"
    }

    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'NFocus state file is empty (a previous run was interrupted mid-write).'
    }

    $state = $null
    try {
        $state = ConvertFrom-Json $raw
    }
    catch {
        throw "NFocus state file is not valid JSON: $($_.Exception.Message)"
    }

    $ver = 0
    if ($null -ne $state.schemaVersion) { $ver = [int]$state.schemaVersion }
    if ($ver -gt $script:NFocusSchemaVersion) {
        throw "NFocus state file schemaVersion $ver is newer than this tool understands ($script:NFocusSchemaVersion)."
    }

    return $state
}

function Remove-NFocusState {
    [CmdletBinding()]
    param()

    $path = Get-NFocusStatePath
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
    $tmp = $path + '.tmp'
    if (Test-Path -LiteralPath $tmp) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
}

function Move-NFocusStateToArchive {
    [CmdletBinding()]
    param([string]$Reason = 'archived')

    $path = Get-NFocusStatePath
    if (-not (Test-Path -LiteralPath $path)) { return $null }

    $dir = Join-Path $script:NFocusStateDir 'archive'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $dest  = Join-Path $dir ("state-$stamp-$Reason.json")
    $i = 1
    while (Test-Path -LiteralPath $dest) {
        $dest = Join-Path $dir ("state-$stamp-$Reason-$i.json")
        $i++
    }

    Move-Item -LiteralPath $path -Destination $dest -Force
    return $dest
}

# -------------------------------------------------------------- config -----

function Read-NFocusConfig {
    [CmdletBinding()]
    param()

    $path = Get-NFocusConfigPath
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($path)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return (ConvertFrom-Json $raw)
    }
    catch {
        throw "NFocus config file is not valid JSON: $($_.Exception.Message)"
    }
}

function Write-NFocusConfig {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Config)

    Confirm-NFocusStateDir
    $path = Get-NFocusConfigPath
    $json = ConvertTo-Json -InputObject $Config -Depth 12
    $tmp  = $path + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $script:NFocusUtf8NoBom)
    if (Test-Path -LiteralPath $path) {
        [System.IO.File]::Replace($tmp, $path, ($path + '.bak'), $true)
    }
    else {
        [System.IO.File]::Move($tmp, $path)
    }
}

# --------------------------------------------------------------- utils -----

function Resolve-NFocusStepList {
    <#
        Normalise a -Only value into a clean list of step names.

        Invoking via `powershell -File script.ps1 -Only a,b,c` hands the whole
        thing over as ONE string, because -File does no array parsing -- and
        that is exactly how Stream Deck and Steam will call these scripts. So
        split on commas and whitespace rather than trusting the binder.
    #>
    param(
        [string[]]$Only,
        [Parameter(Mandatory = $true)][string[]]$Valid
    )

    if ($null -eq $Only -or $Only.Count -eq 0) { return @() }

    $wanted = @()
    foreach ($item in $Only) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        foreach ($piece in ($item -split '[,;\s]+')) {
            if (-not [string]::IsNullOrWhiteSpace($piece)) { $wanted += $piece.Trim().ToLowerInvariant() }
        }
    }

    $unknown = @($wanted | Where-Object { $Valid -notcontains $_ })
    if ($unknown.Count -gt 0) {
        throw "Unknown step(s) in -Only: $($unknown -join ', '). Choose from: $($Valid -join ', ')"
    }

    return @($wanted | Sort-Object -Unique)
}

function ConvertTo-NFocusArray {
    <#
        ConvertTo-Json/ConvertFrom-Json round-trips a single-element array as a
        bare scalar in PS 5.1. Everywhere we read a list back out of state we
        push it through here so .Count and foreach behave.
    #>
    param($Value)

    if ($null -eq $Value) { return @() }
    return @($Value)
}

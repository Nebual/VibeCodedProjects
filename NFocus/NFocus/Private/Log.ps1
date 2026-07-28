# Log.ps1 -- rotating file log.
#
# Deliberately not Start-Transcript: it is noisy, holds a lock on the file, and
# fights the .vbs hidden-window launchers.

function Get-NFocusLogDir {
    return (Join-Path $script:NFocusStateDir 'logs')
}

function Get-NFocusLogPath {
    return (Join-Path (Get-NFocusLogDir) 'nfocus.log')
}

function Initialize-NFocusLog {
    [CmdletBinding()]
    param(
        [string]$Operation = 'nfocus'
    )

    $script:NFocusOperation = $Operation
    if (-not $script:NFocusSessionId) {
        $script:NFocusSessionId = [guid]::NewGuid().ToString('n').Substring(0, 8)
    }

    $dir = Get-NFocusLogDir
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # Size-based rotation, checked once per run rather than per write.
    $path = Get-NFocusLogPath
    if (Test-Path -LiteralPath $path) {
        if ((Get-Item -LiteralPath $path).Length -gt 1MB) {
            $n3 = Join-Path $dir 'nfocus.3.log'
            $n2 = Join-Path $dir 'nfocus.2.log'
            $n1 = Join-Path $dir 'nfocus.1.log'
            if (Test-Path -LiteralPath $n3) { Remove-Item -LiteralPath $n3 -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $n2) { Move-Item -LiteralPath $n2 -Destination $n3 -Force -ErrorAction SilentlyContinue }
            if (Test-Path -LiteralPath $n1) { Move-Item -LiteralPath $n1 -Destination $n2 -Force -ErrorAction SilentlyContinue }
            Move-Item -LiteralPath $path -Destination $n1 -Force -ErrorAction SilentlyContinue
        }
    }

    $script:NFocusLogReady = $true
}

function Write-NFocusLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true, Position = 0)]
        [AllowEmptyString()]
        [string]$Message,

        [ValidateSet('INF', 'WRN', 'ERR', 'DBG')]
        [string]$Level = 'INF',

        [string]$Step = '-'
    )

    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    $line = '{0} [{1}] [{2}] [{3}] [{4}] {5}' -f `
        $ts, $Level, $script:NFocusSessionId, $script:NFocusOperation, $Step, $Message

    if ($script:NFocusLogReady) {
        try {
            [System.IO.File]::AppendAllText((Get-NFocusLogPath), ($line + "`r`n"), $script:NFocusUtf8NoBom)
        }
        catch {
            # Logging must never be the thing that breaks a toggle.
        }
    }

    if ($Level -eq 'WRN' -or $Level -eq 'ERR') {
        Write-Warning $line
    }
    else {
        Write-Verbose $line
    }
}

# Audio feedback. The user is across the room and the screen may have just gone
# dark, so sound is the only channel that reliably reaches them -- and unlike a
# toast it does not depend on the notification stack this tool disables.
function Invoke-NFocusBeep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('Enabled', 'Disabled', 'Failed')]
        [string]$Kind
    )

    try {
        switch ($Kind) {
            'Enabled'  { [Console]::Beep(880, 120); Start-Sleep -Milliseconds 60; [Console]::Beep(1175, 140) }
            'Disabled' { [Console]::Beep(660, 160) }
            'Failed'   { [Console]::Beep(220, 400) }
        }
    }
    catch {
        # No console / no speaker. Not worth failing over.
    }
}

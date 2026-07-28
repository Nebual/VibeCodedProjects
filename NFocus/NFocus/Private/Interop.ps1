# Interop.ps1 -- compile and load the C# interop, with an on-disk cache.
#
# Inline Add-Type shells out to csc.exe and costs roughly 0.7-2s on first use,
# which fights the "press a button, it happens" premise. So we compile once to
# Tools\NFocus.Interop.dll and reload that until a .cs file changes.

function Import-NFocusInterop {
    [CmdletBinding()]
    param([switch]$ForceRebuild)

    # Types cannot be redefined in a session, so this is also the re-entry guard.
    if (-not $ForceRebuild -and ('NFocus.Ccd' -as [type])) { return }

    $sources = @(
        (Join-Path $script:NFocusModuleRoot 'Private\Interop.Ccd.cs')
        (Join-Path $script:NFocusModuleRoot 'Private\Interop.Audio.cs')
    )
    foreach ($s in $sources) {
        if (-not (Test-Path -LiteralPath $s)) { throw "NFocus interop source missing: $s" }
    }

    $toolsDir = Join-Path $script:NFocusRoot 'Tools'
    $dll      = Join-Path $toolsDir 'NFocus.Interop.dll'

    $needBuild = $true
    if (-not $ForceRebuild -and (Test-Path -LiteralPath $dll)) {
        $dllTime = (Get-Item -LiteralPath $dll).LastWriteTimeUtc
        $newest  = ($sources | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc } |
                    Sort-Object -Descending | Select-Object -First 1)
        if ($dllTime -ge $newest) { $needBuild = $false }
    }

    if ($needBuild) {
        if (-not (Test-Path -LiteralPath $toolsDir)) {
            New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
        }
        try {
            Add-Type -Path $sources -OutputAssembly $dll -OutputType Library -ErrorAction Stop
        }
        catch {
            # The DLL can be locked by another PowerShell session that already
            # loaded it, or the folder can be read-only. Neither is fatal --
            # fall back to compiling into memory for this run.
            Write-NFocusLog -Level WRN -Step 'interop' -Message "Could not build ${dll}: $($_.Exception.Message). Falling back to in-memory compile."
            Add-Type -Path $sources -ErrorAction Stop
            return
        }
    }

    Add-Type -Path $dll -ErrorAction Stop
}

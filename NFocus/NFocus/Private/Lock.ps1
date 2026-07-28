# Lock.ps1 -- cross-process mutual exclusion.
#
# Anti-double-enable layer 2, and the most important one in practice. The whole
# product is a physical button, so the realistic way to corrupt the state file
# is a Stream Deck double-tap: two processes ~200ms apart. Both would pass the
# "does state.json exist?" check, both would capture, and the second would
# record the FIRST one's already-modified machine as the user's baseline --
# making a faithful revert impossible for good.

function New-NFocusLock {
    [CmdletBinding()]
    param()

    $names = @('Global\NFocus.TvGamingMode', 'Local\NFocus.TvGamingMode')

    foreach ($name in $names) {
        $mutex = $null
        try {
            $mutex = New-Object System.Threading.Mutex($false, $name)
        }
        catch {
            # A Global mutex can be refused depending on session/permissions.
            # Fall through to the Local one -- both toggles run as the same
            # user in the same session, so Local is sufficient.
            continue
        }

        $acquired = $false
        try {
            # Zero timeout: if someone else holds it, fail immediately rather
            # than queue up a second toggle behind the first.
            $acquired = $mutex.WaitOne(0)
        }
        catch [System.Threading.AbandonedMutexException] {
            # The previous holder died without releasing. We now own it.
            $acquired = $true
        }

        if ($acquired) {
            return [pscustomobject]@{ mutex = $mutex; name = $name; acquired = $true }
        }

        $mutex.Dispose()
        return [pscustomobject]@{ mutex = $null; name = $name; acquired = $false }
    }

    # Could not even create a mutex. Do not block the user over it.
    Write-NFocusLog -Level WRN -Step 'lock' -Message 'Could not create a mutex; continuing without cross-process locking.'
    return [pscustomobject]@{ mutex = $null; name = $null; acquired = $true }
}

function Remove-NFocusLock {
    [CmdletBinding()]
    param($Lock)

    if ($null -eq $Lock -or $null -eq $Lock.mutex) { return }
    try { $Lock.mutex.ReleaseMutex() } catch { }
    try { $Lock.mutex.Dispose() } catch { }
}

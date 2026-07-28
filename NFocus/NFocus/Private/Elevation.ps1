# Elevation.ps1 -- run the Bluetooth PnP call with admin rights.
#
# Disable-PnpDevice needs elevation, but a UAC prompt on every toggle defeats
# the whole "press one button" premise. So Install-NFocus registers two
# scheduled tasks running with highest privileges -- ONE UAC prompt, ever, at
# install time -- and the toggles just start them.
#
# Only the PnP call goes through the broker. The main scripts must NOT run this
# way: a scheduled task lands in a non-interactive session where the CCD and
# per-app audio APIs misbehave.

$script:NFocusTaskDisable = 'NFocus-BtDisable'
$script:NFocusTaskEnable  = 'NFocus-BtEnable'

function Test-NFocusElevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NFocusBtTaskName {
    param([bool]$Enable)
    if ($Enable) { return $script:NFocusTaskEnable }
    return $script:NFocusTaskDisable
}

function Test-NFocusBtTasksRegistered {
    foreach ($n in @($script:NFocusTaskDisable, $script:NFocusTaskEnable)) {
        if ($null -eq (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue)) { return $false }
    }
    return $true
}

function Invoke-NFocusElevatedBluetooth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][bool]$Enable,
        [int]$TimeoutSeconds = 25
    )

    $taskName = Get-NFocusBtTaskName -Enable $Enable

    if ($null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        try {
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

            # Starting a task only means "launched". The actual result arrives
            # asynchronously in LastTaskResult, so poll for it -- treating a
            # successful start as a successful disable is a classic mistake.
            $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
            Start-Sleep -Milliseconds 250
            while ((Get-Date) -lt $deadline) {
                $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
                $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

                if ($null -ne $task -and $task.State -ne 'Running') {
                    if ($null -ne $info -and $info.LastTaskResult -eq 0) {
                        Write-NFocusLog -Step 'bluetooth' -Message "Scheduled task '$taskName' completed successfully."
                        return $true
                    }
                    $rc = 'unknown'
                    if ($null -ne $info) { $rc = $info.LastTaskResult }
                    Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "Scheduled task '$taskName' returned $rc."
                    return $false
                }
                Start-Sleep -Milliseconds 250
            }

            Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "Scheduled task '$taskName' timed out after ${TimeoutSeconds}s."
            return $false
        }
        catch {
            Write-NFocusLog -Level WRN -Step 'bluetooth' -Message "Could not run '$taskName': $($_.Exception.Message). Falling back to a UAC prompt."
        }
    }
    else {
        Write-NFocusLog -Level WRN -Step 'bluetooth' -Message "Task '$taskName' is not registered. Run Install-NFocus.ps1 once to avoid a UAC prompt on every toggle."
    }

    return (Invoke-NFocusRunAsBluetooth -InstanceId $InstanceId -Enable $Enable)
}

function Invoke-NFocusRunAsBluetooth {
    <# Fallback: a one-shot elevated PowerShell. Costs a UAC prompt. #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InstanceId,
        [Parameter(Mandatory = $true)][bool]$Enable
    )

    $verb = 'Disable-PnpDevice'
    if ($Enable) { $verb = 'Enable-PnpDevice' }

    # -EncodedCommand avoids every quoting problem with the instance id, which
    # contains & and \ characters.
    $inner  = "$verb -InstanceId '$InstanceId' -Confirm:`$false -ErrorAction Stop; exit 0"
    $bytes  = [System.Text.Encoding]::Unicode.GetBytes($inner)
    $b64    = [Convert]::ToBase64String($bytes)

    try {
        $p = Start-Process -FilePath 'powershell.exe' `
            -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $b64) `
            -Verb RunAs -WindowStyle Hidden -PassThru -Wait -ErrorAction Stop

        if ($p.ExitCode -eq 0) { return $true }
        Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "Elevated $verb exited with $($p.ExitCode)."
        return $false
    }
    catch {
        # Most commonly: the user dismissed the UAC prompt.
        Write-NFocusLog -Level ERR -Step 'bluetooth' -Message "Elevation refused or failed: $($_.Exception.Message)"
        return $false
    }
}

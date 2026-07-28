function Install-NFocus {
    <#
    .SYNOPSIS
        One-time setup: register the elevated Bluetooth tasks.

    .DESCRIPTION
        Disabling a PnP device needs admin rights, but a UAC prompt on every
        toggle would defeat the point of a one-button mode. So this registers
        two scheduled tasks that run with highest privileges:

            NFocus-BtDisable    NFocus-BtEnable

        Enable/Disable then just start the right task. This is the ONLY UAC
        prompt in the tool's lifetime.

        Without this, NFocus still works -- it falls back to a RunAs relaunch
        and you get a UAC prompt on each toggle.

    .PARAMETER Uninstall
        Remove the tasks again.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [switch]$Uninstall
    )

    Initialize-NFocusLog -Operation 'install'

    if (-not (Test-NFocusElevated)) {
        Write-Host 'Registering scheduled tasks needs admin rights. Re-launching elevated...' -ForegroundColor Yellow

        $script = Join-Path $script:NFocusRoot 'Install-NFocus.ps1'
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
        if ($Uninstall) { $argList += '-Uninstall' }

        try {
            $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -PassThru -Wait -ErrorAction Stop
            if ($p.ExitCode -ne 0) { Write-Warning "Elevated installer exited with $($p.ExitCode)." }
        }
        catch {
            throw "Elevation was refused, so the tasks were not registered. $($_.Exception.Message)"
        }
        return
    }

    $helper = Join-Path $script:NFocusRoot 'Set-NFocusBluetooth.ps1'
    if (-not (Test-Path -LiteralPath $helper)) {
        throw "Helper script not found: $helper"
    }

    $tasks = @(
        [pscustomobject]@{ Name = $script:NFocusTaskDisable; Action = 'Disable' }
        [pscustomobject]@{ Name = $script:NFocusTaskEnable;  Action = 'Enable'  }
    )

    if ($Uninstall) {
        foreach ($t in $tasks) {
            if ($null -ne (Get-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue)) {
                if ($PSCmdlet.ShouldProcess($t.Name, 'Unregister scheduled task')) {
                    Unregister-ScheduledTask -TaskName $t.Name -Confirm:$false
                    Write-Host "Removed $($t.Name)" -ForegroundColor Green
                }
            }
        }
        return
    }

    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                    -LogonType Interactive -RunLevel Highest
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

    foreach ($t in $tasks) {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action {1}' -f $helper, $t.Action)

        if ($PSCmdlet.ShouldProcess($t.Name, 'Register scheduled task')) {
            Register-ScheduledTask -TaskName $t.Name -Action $action -Principal $principal `
                -Settings $settings -Description "NFocus TV Gaming Mode: $($t.Action) the Bluetooth adapter." `
                -Force | Out-Null
            Write-Host "Registered $($t.Name)" -ForegroundColor Green
            Write-NFocusLog -Step 'install' -Message "Registered scheduled task $($t.Name)."
        }
    }

    Write-Host ''
    Write-Host 'Done. Toggling TV Gaming Mode will no longer prompt for admin rights.' -ForegroundColor Green
}

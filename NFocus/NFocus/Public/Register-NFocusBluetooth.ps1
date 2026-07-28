function Register-NFocusBluetooth {
    <#
    .SYNOPSIS
        Pin which Bluetooth adapter is the DESK one, so TV Gaming Mode disables
        that one and hands over to the TV room's adapter.

    .DESCRIPTION
        There is more than one Bluetooth radio on this machine, and which ones
        report Present changes depending on what is powered up -- when the desk
        adapter is disabled a second radio appears. Auto-detection is therefore
        not trustworthy, so the desk adapter is pinned by PnP instance id in
        config.json and matched exactly from then on.

        A disabled adapter still reports Present, so the pin keeps working
        across enable/disable cycles.

    .PARAMETER InstanceId
        The adapter to pin. Omit to be shown the candidates.

    .PARAMETER List
        Show the candidates and exit.
    #>
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [string]$InstanceId,
        [switch]$List
    )

    Initialize-NFocusLog -Operation 'register-bt'

    $all = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
             Where-Object { $_.Present -and ($_.InstanceId -like 'USB\*' -or $_.InstanceId -like 'PCI\*') })

    if ($all.Count -eq 0) {
        throw 'No present Bluetooth adapters found. Switch the desk adapter on and try again.'
    }

    Write-Host ''
    Write-Host 'Present Bluetooth adapters:' -ForegroundColor Cyan
    foreach ($a in $all) {
        $state = 'enabled'
        if ([int]$a.Problem -eq 22) { $state = 'disabled' }
        Write-Host ('  {0,-52} {1,-9} {2}' -f $a.FriendlyName, $state, $a.InstanceId)
    }
    Write-Host ''

    if ($List) { return }

    $chosen = $null
    if (-not [string]::IsNullOrWhiteSpace($InstanceId)) {
        $chosen = $all | Where-Object { $_.InstanceId -eq $InstanceId } | Select-Object -First 1
        if ($null -eq $chosen) {
            throw "No present Bluetooth adapter with instance id '$InstanceId'. Run with -List to see the candidates."
        }
    }
    elseif ($all.Count -eq 1) {
        $chosen = $all[0]
        Write-Host "Only one adapter present; pinning it." -ForegroundColor Green
    }
    else {
        Write-Warning "$($all.Count) adapters are present. Re-run with -InstanceId to say which one is the desk adapter."
        return
    }

    $config = Read-NFocusConfig
    if ($null -eq $config) {
        $config = [pscustomobject]@{ schemaVersion = 1 }
    }

    if ($config.PSObject.Properties.Name -contains 'bluetoothInstanceId') {
        $config.bluetoothInstanceId = $chosen.InstanceId
    }
    else {
        Add-Member -InputObject $config -NotePropertyName 'bluetoothInstanceId' -NotePropertyValue $chosen.InstanceId
    }

    if ($config.PSObject.Properties.Name -contains 'bluetoothFriendlyName') {
        $config.bluetoothFriendlyName = $chosen.FriendlyName
    }
    else {
        Add-Member -InputObject $config -NotePropertyName 'bluetoothFriendlyName' -NotePropertyValue $chosen.FriendlyName
    }

    if ($PSCmdlet.ShouldProcess((Get-NFocusConfigPath), 'Pin desk Bluetooth adapter')) {
        Write-NFocusConfig -Config $config
        Write-NFocusLog -Step 'register-bt' -Message "Pinned desk adapter '$($chosen.FriendlyName)' ($($chosen.InstanceId))."
        Write-Host "Pinned desk adapter: $($chosen.FriendlyName)" -ForegroundColor Green
        Write-Host "Saved to $(Get-NFocusConfigPath)" -ForegroundColor Green
    }
}

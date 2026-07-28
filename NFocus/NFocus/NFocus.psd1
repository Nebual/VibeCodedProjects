@{
    RootModule        = 'NFocus.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = 'c6b0e6f2-7a4d-4a1e-9a6d-3f5f2c7b1e40'
    Author            = 'ben'
    Description       = 'TV Gaming Mode: suppress notifications, silence Discord, disable Bluetooth, and switch the display to the TV -- with a faithful revert.'

    PowerShellVersion = '5.1'

    FunctionsToExport = @(
        'Invoke-NFocusEnable'
        'Invoke-NFocusDisable'
        'Get-NFocusStatus'
        'Register-NFocusTv'
        'Register-NFocusBluetooth'
        'Install-NFocus'
        'Write-NFocusStatusReport'
    )
    CmdletsToExport   = @()
    VariablesToExport = @()
    AliasesToExport   = @()
}

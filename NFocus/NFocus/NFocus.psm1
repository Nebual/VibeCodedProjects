# NFocus.psm1 -- TV Gaming Mode.
#
# Imported by explicit manifest path from the entry scripts, never installed to
# $env:PSModulePath, so the whole thing stays portable and self-contained.

# Version 1.0, not 2.0: 2.0 also throws on reading a non-existent *property*,
# which is hostile to ConvertFrom-Json objects whose optional fields are simply
# missing -- and this module reads a lot of those.
Set-StrictMode -Version 1.0

$script:NFocusVersion    = '1.0.0'
$script:NFocusModuleRoot = $PSScriptRoot
$script:NFocusRoot       = Split-Path -Parent $PSScriptRoot
$script:NFocusStateDir   = Join-Path $script:NFocusRoot 'State'

# Out-File -Encoding utf8 emits a BOM in PS 5.1, which upsets anything that
# reads these files with a strict JSON parser. Always use this instead.
$script:NFocusUtf8NoBom  = New-Object System.Text.UTF8Encoding($false)

$script:NFocusSessionId  = $null
$script:NFocusOperation  = 'nfocus'
$script:NFocusLogReady   = $false

# Dot-source by glob rather than an explicit list: one less thing to forget to
# update. Private files must define functions only -- no top-level side effects,
# since load order here is alphabetical and not meaningful.
foreach ($folder in @('Private', 'Public')) {
    $dir = Join-Path $PSScriptRoot $folder
    if (-not (Test-Path -LiteralPath $dir)) { continue }

    foreach ($file in (Get-ChildItem -LiteralPath $dir -Filter '*.ps1' -File | Sort-Object Name)) {
        $path = $file.FullName
        try {
            . $path
        }
        catch {
            throw "NFocus: failed to load ${path}: $($_.Exception.Message)"
        }
    }
}

Export-ModuleMember -Function @(
    'Invoke-NFocusEnable'
    'Invoke-NFocusDisable'
    'Get-NFocusStatus'
    'Register-NFocusTv'
    'Register-NFocusBluetooth'
    'Install-NFocus'
    'Write-NFocusStatusReport'
)

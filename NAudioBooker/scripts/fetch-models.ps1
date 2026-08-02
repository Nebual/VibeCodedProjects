# Download the Kokoro weights (Windows).
#
# Run this on every machine that performs synthesis -- the primary host and any
# GPU node. The weights are not in the repository (340 MB, and they are
# immutable release artefacts), so a fresh checkout has none.
#
#   .\scripts\fetch-models.ps1 [-Target <dir>]
param(
    [string]$Target = (Join-Path (Split-Path $PSScriptRoot -Parent) 'models')
)

$ErrorActionPreference = 'Stop'
$base = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'

# fp32 only. The int8 build is a third of the size and measured about five
# times slower on every CPU tested, so it is not worth the download.
$files = @('kokoro-v1.0.onnx', 'voices-v1.0.bin')

New-Item -ItemType Directory -Force -Path $Target | Out-Null

foreach ($name in $files) {
    $dest = Join-Path $Target $name
    if ((Test-Path $dest) -and ((Get-Item $dest).Length -gt 0)) {
        Write-Host "have     $name"
        continue
    }
    Write-Host "fetching $name"
    # Download to .part and rename, so an interrupted download cannot leave a
    # truncated file that looks complete on the next run.
    $part = "$dest.part"
    Invoke-WebRequest -Uri "$base/$name" -OutFile $part
    Move-Item -Force $part $dest
}

Write-Host ""
Write-Host "models in $Target :"
Get-ChildItem $Target | ForEach-Object {
    '{0,-24} {1,8:N0} KB' -f $_.Name, ($_.Length / 1KB)
}

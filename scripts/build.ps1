# PowerMidiEditor one-shot build: frontend -> embedded zip -> VST3/Standalone.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1              # Debug
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Config Release
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipFrontend
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -DevUi       # UI from vite dev server
param(
    [string]$Config = "Debug",
    [switch]$SkipFrontend,
    [switch]$DevUi
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# Node.js may have just been installed; make sure it is on PATH.
$nodeBin = "C:\Program Files\nodejs"
if ((Test-Path $nodeBin) -and (-not (Get-Command node -ErrorAction SilentlyContinue))) {
    $env:PATH = "$nodeBin;$env:PATH"
}

if (-not $SkipFrontend) {
    Write-Host "== frontend: npm install ==" -ForegroundColor Cyan
    Push-Location "$root\frontend"
    if (-not (Test-Path node_modules)) { npm install }
    Write-Host "== frontend: build + zip ==" -ForegroundColor Cyan
    npm run package
    Pop-Location
}

$cmakeArgs = @("-B", "$root\build", "-DCMAKE_BUILD_TYPE=$Config")
if ($DevUi) { $cmakeArgs += "-DPME_DEV_MODE=ON" }

Write-Host "== cmake configure ($Config) ==" -ForegroundColor Cyan
cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== cmake build ==" -ForegroundColor Cyan
cmake --build "$root\build" --config $Config --parallel
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "== unit tests ==" -ForegroundColor Cyan
& "$root\build\PmeTests_artefacts\$Config\PmeTests.exe"

Write-Host ""
Write-Host "VST3 (MIDI-only): $root\build\PowerMidiEditor_artefacts\$Config\VST3\PowerMidiEditor.vst3" -ForegroundColor Green
Write-Host "VST3 (audio FX):  $root\build\PowerMidiEditorFX_artefacts\$Config\VST3\PowerMidiEditor FX.vst3" -ForegroundColor Green
Write-Host "Install both: scripts\install-vst3.cmd"

# Automated end-to-end test: loads the built VST3 in a minimal host, drives a
# fake transport, verifies MIDI output/pass-through and waits for the WebView
# bridge. No DAW needed.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\test.ps1                # Release
#   powershell -ExecutionPolicy Bypass -File scripts\test.ps1 -Config Debug
param(
    [string]$Config = "Release"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$host_ = "$root\build\PmeHost_artefacts\$Config\PmeHost.exe"
$vst3 = "$root\build\PowerMidiEditor_artefacts\$Config\VST3\PowerMidiEditor.vst3"

if (-not (Test-Path $host_)) { Write-Error "PmeHost not found: $host_ (build first)"; exit 1 }
if (-not (Test-Path $vst3))  { Write-Error "VST3 not found: $vst3 (build first)"; exit 1 }

Write-Host "== PmeHost end-to-end test ==" -ForegroundColor Cyan
& $host_ $vst3
exit $LASTEXITCODE

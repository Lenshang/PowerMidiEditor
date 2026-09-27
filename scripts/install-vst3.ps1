# Copies the built VST3 into the system VST3 folder (Bitwig/Cubase default).
# Requires admin rights for C:\Program Files\Common Files\VST3.
param(
    [string]$Config = "Release"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$src = "$root\build\PowerMidiEditor_artefacts\$Config\VST3\PowerMidiEditor.vst3"
if (-not (Test-Path $src)) { Write-Error "VST3 not found at $src — build first."; exit 1 }

$dst = "$env:COMMONPROGRAMFILES\VST3"
Copy-Item -Recurse -Force $src $dst
Write-Host "Installed: $dst\PowerMidiEditor.vst3" -ForegroundColor Green
Write-Host "In Bitwig: 打开设置 -> Plug-ins -> 扫描，然后在乐器轨的 Note FX 插槽加载 PowerMidiEditor。"

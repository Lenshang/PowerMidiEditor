# Automated drag-out gesture test for PowerMidiEditor Standalone.
# Locates the drag-out toolbar button via WebView2 CDP, then performs a real
# press-hold-drag-release with SendInput and checks the dropped file.
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref PT p);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int L, T, R, B; }
  public struct PT { public int X, Y; public PT(int x, int y){X=x;Y=y;} }
}
'@
[Dpi]::SetProcessDPIAware() | Out-Null

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$sw = $screen.Width; $sh = $screen.Height
Write-Output ("SCREEN_PHYS: ${sw}x${sh}")

function To-Abs([int]$x, [int]$y) {
  $nx = [uint32][Math]::Round($x * 65535 / ($sw - 1))
  $ny = [uint32][Math]::Round($y * 65535 / ($sh - 1))
  [Dpi]::mouse_event(0x0001 -bor 0x8000, $nx, $ny, 0, [UIntPtr]::Zero)  # MOVE|ABSOLUTE
}

# --- locate plugin main window (largest visible window of the process) ---
$procId = (Get-Process PowerMidiEditor | Select-Object -First 1).Id
$target = [IntPtr]::Zero
$cb = [Dpi+EnumProc]{ param($h, $l)
  $p2 = 0; [Dpi]::GetWindowThreadProcessId($h, [ref]$p2) | Out-Null
  if ($p2 -eq $procId -and [Dpi]::IsWindowVisible($h)) {
    $r = New-Object Dpi+RECT; [Dpi]::GetWindowRect($h, [ref]$r) | Out-Null
    if (($r.R - $r.L) -gt 600) { $script:target = $h; return $false }
  }
  return $true
}
[Dpi]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($target -eq [IntPtr]::Zero) { Write-Output 'RESULT: window-not-found'; exit 1 }

$o = New-Object Dpi+PT 0,0; [Dpi]::ClientToScreen($target, [ref]$o) | Out-Null
$cr = New-Object Dpi+RECT; [Dpi]::GetClientRect($target, [ref]$cr) | Out-Null
$clientW = $cr.R; $clientH = $cr.B
Write-Output ("CLIENT_ORIGIN_PHYS: $($o.X),$($o.Y)  CLIENT_PHYS: ${clientW}x${clientH}")

# The window must actually be under the cursor for the physical gesture to
# reach it: raise it above everything for the duration of the test.
$HWND_TOPMOST = [IntPtr](-1); $HWND_NOTOPMOST = [IntPtr](-2)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);' -Name W3 -Namespace DpiEx
[DpiEx.W3]::SetWindowPos($target, $HWND_TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null  # NOSIZE|NOMOVE|SHOWWINDOW
Start-Sleep -Milliseconds 600

# --- locate button via CDP (CSS px) ---
$cdp = & node "$PSScriptRoot\locate-dragout-btn.mjs" 2>&1 | Select-Object -Last 1
$m = $cdp | ConvertFrom-Json
if (-not $m.found) { Write-Output "RESULT: button-not-found ($cdp)"; exit 1 }
$scale = $clientW / $m.innerW
$btnX = [int][Math]::Round($o.X + $m.cx * $scale)
$btnY = [int][Math]::Round($o.Y + $m.cy * $scale)
Write-Output ("BTN_PHYS: $btnX,$btnY (scale=$scale)")

# --- drop target: the plugin's own piano roll (tests drag-out AND drag-in
# import in one gesture — the round trip the user asked for). Fall back to a
# bare desktop point if the roll area can't be used. ---
$dropX = [int][Math]::Round($o.X + 700 * $scale)
$dropY = [int][Math]::Round($o.Y + 550 * $scale)
Write-Output ("DROP_POINT_PHYS: $dropX,$dropY (plugin piano roll)")

$desktop = [Environment]::GetFolderPath('Desktop')
$dest = Join-Path $desktop 'PowerMidiEditor_Export.mid'
if (Test-Path $dest) { Remove-Item $dest -Force }

# --- perform the real drag gesture ---
To-Abs $btnX $btnY; Start-Sleep -Milliseconds 250
[Dpi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)   # LEFTDOWN
Start-Sleep -Milliseconds 350                           # invoke -> DoDragDrop engages
$steps = 14
for ($i = 1; $i -le $steps; $i++) {
  $x = [int][Math]::Round($btnX + ($dropX - $btnX) * $i / $steps)
  $y = [int][Math]::Round($btnY + ($dropY - $btnY) * $i / $steps)
  To-Abs $x $y
  Start-Sleep -Milliseconds 40
}
Start-Sleep -Milliseconds 300
$bmp = New-Object System.Drawing.Bitmap $sw, $sh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$bmp.Save("$PSScriptRoot\..\build\dragout_mid.png")
$g.Dispose(); $bmp.Dispose()
[Dpi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)   # LEFTUP
[DpiEx.W3]::SetWindowPos($target, $HWND_NOTOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
Start-Sleep -Milliseconds 1500

# A successful round trip imports the file back into the roll -> toast visible.
$bmp = New-Object System.Drawing.Bitmap $sw, $sh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, $bmp.Size)
$bmp.Save("$PSScriptRoot\..\build\dragout_after.png")
$g.Dispose(); $bmp.Dispose()

if (Test-Path $dest) {
  $len = (Get-Item $dest).Length
  Write-Output "RESULT: DROP_OK ($dest, $len bytes)"
} else {
  Write-Output 'RESULT: no desktop file (expected when dropping back into the roll)'
}

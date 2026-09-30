Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Start-Sleep -Milliseconds 200
$dialog = $null
for ($i = 0; $i -lt 40; $i++) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*MIDI*' -and $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if ($p) { $dialog = $p; break }
  Start-Sleep -Milliseconds 150
}
if (-not $dialog) {
  # fallback: enumerate top-level windows by title via shell
  $shell = New-Object -ComObject Shell.Application
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 200
    $w = (New-Object -ComObject Shell.Application).Windows() | Select-Object -First 1
  }
}
$allTitles = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.MainWindowTitle }
Write-Output ('TITLES: ' + ($allTitles -join ' | '))
# Try AppActivate by title fragment instead of process
[Microsoft.VisualBasic.Interaction]::AppActivate('MIDI')
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('Z:\CodeProject\drummap')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output 'keys sent'

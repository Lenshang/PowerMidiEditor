Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Start-Sleep -Milliseconds 200
$dialog = $null
for ($i = 0; $i -lt 20; $i++) {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*MIDI folder*' } | Select-Object -First 1
  if ($p) { $dialog = $p; break }
  Start-Sleep -Milliseconds 150
}
if (-not $dialog) { Write-Output 'DIALOG-NOT-FOUND'; exit 1 }
[Microsoft.VisualBasic.Interaction]::AppActivate($dialog.Id)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('Z:\CodeProject\drummap')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Write-Output 'keys sent to dialog'

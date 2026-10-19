$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if ($request.challenge -notmatch '^\d{6}$') { exit 1 }
$message = "Connect the Insula plugin on this computer?`n`nFile: $($request.file)`nConfirmation number: $($request.challenge)`n`nApprove only if this number matches the plugin you just opened. This remembers the connection for future Figma files."
$answer = [System.Windows.Forms.MessageBox]::Show($message, 'Insula - Connect this computer', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { [Console]::WriteLine('APPROVED') }

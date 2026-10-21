param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$StateDirectory, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Figma CLI Ultimate.lnk'
$description = "figma-cli-ultimate companion: $projectRoot"
$configurationPath = Join-Path $StateDirectory 'companion.json'
$shellObject = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
  $existing = $shellObject.CreateShortcut($shortcutPath)
  if ($existing.Description -ne $description) { $existing.Description -match ': (.*)$' | Out-Null; throw "Automatic start is already set up for another installation: $($Matches[1]). Run figma-ultimate autostart off from there first." }
}
if ($Uninstall) {
  if (Test-Path -LiteralPath $configurationPath) {
    $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
    if ($configuration.root -ne $projectRoot) { throw 'The companion configuration belongs to another installation.' }
    $configuration.enabled = $false
    [IO.File]::WriteAllText($configurationPath, ($configuration | ConvertTo-Json -Compress))
  }
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  Write-Output 'Automatic start is off. The companion exits shortly; open Figma work is not touched.'
  exit 0
}
if (Test-Path -LiteralPath $configurationPath) {
  $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
  if ($configuration.enabled -and $configuration.root -ne $projectRoot) { throw "Another installation owns automatic start: $($configuration.root)" }
}
$null = New-Item -ItemType Directory -Path $StateDirectory -Force
# Serialize canonical paths as data; only the fixed script runs at sign-in.
[IO.File]::WriteAllText($configurationPath, (@{enabled=$true;root=$projectRoot} | ConvertTo-Json -Compress))
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start-companion.ps1') + '" -NodePath "' + $NodePath + '" -StateDirectory "' + $StateDirectory + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = $description
$shortcut.Save()
Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WindowStyle Hidden
Write-Output 'Automatic start is on: the bridge starts at sign-in and restarts if it stops.'

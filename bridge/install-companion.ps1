param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$StateDirectory, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$startupDirectory = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDirectory 'Insula Figma Companion.lnk'
$configurationPath = Join-Path $StateDirectory 'companion.json'
$shellObject = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
  $existing = $shellObject.CreateShortcut($shortcutPath)
  if ($existing.Description -ne "Insula Figma companion: $projectRoot") { throw 'An Insula companion for another checkout is installed.' }
}
if ($Uninstall) {
  if (Test-Path -LiteralPath $configurationPath) {
    $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
    if ($configuration.root -ne $projectRoot) { throw 'Companion configuration belongs to another checkout.' }
    $configuration.enabled = $false
    [IO.File]::WriteAllText($configurationPath, ($configuration | ConvertTo-Json -Compress))
  }
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
  Write-Output 'Automatic startup disabled. The companion exits shortly; existing Figma work stays open.'
  exit 0
}
if (Test-Path -LiteralPath $configurationPath) {
  $configuration = Get-Content -LiteralPath $configurationPath -Raw | ConvertFrom-Json
  if ($configuration.enabled -and $configuration.root -ne $projectRoot) { throw 'Another checkout owns the companion.' }
}
$null = New-Item -ItemType Directory -Path $StateDirectory -Force
# Retire only this checkout's former supervisor configuration. Shared daemon
# PID/token files belong to other clients and must never be changed here.
$legacyConfigurationPath = Join-Path $env:USERPROFILE '.figma-ds-cli\companion.json'
if (($legacyConfigurationPath -ne $configurationPath) -and (Test-Path -LiteralPath $legacyConfigurationPath)) {
  $legacyConfiguration = Get-Content -LiteralPath $legacyConfigurationPath -Raw | ConvertFrom-Json
  if ($legacyConfiguration.root -eq $projectRoot) {
    $legacyConfiguration.enabled = $false
    [IO.File]::WriteAllText($legacyConfigurationPath, ($legacyConfiguration | ConvertTo-Json -Compress))
  }
}
# Serialize canonical paths as data; only the fixed script runs at sign-in.
[IO.File]::WriteAllText($configurationPath, (@{enabled=$true;root=$projectRoot} | ConvertTo-Json -Compress))
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
$shortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start-companion.ps1') + '" -NodePath "' + $NodePath + '" -StateDirectory "' + $StateDirectory + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "Insula Figma companion: $projectRoot"
$shortcut.Save()
Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WindowStyle Hidden
Write-Output 'Insula companion installed for this Windows user and started. It will also start at sign-in.'

param([Parameter(Mandatory=$true)][string]$NodePath, [Parameter(Mandatory=$true)][string]$StateDirectory)
$ErrorActionPreference = 'Stop'
$env:FIGMA_ULTIMATE_STATE_DIR = $StateDirectory
& $NodePath (Join-Path $PSScriptRoot 'companion.mjs')
exit $LASTEXITCODE

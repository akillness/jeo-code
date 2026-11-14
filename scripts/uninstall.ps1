# jeo (jeo-code) Windows uninstaller — removes jeo shims and isolated global without touching jeopi.
# Usage (PowerShell):
#   .\scripts\uninstall.ps1
#   .\scripts\uninstall.ps1 -Purge

[CmdletBinding()]
param(
  [switch]$Purge
)

$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath("UserProfile") }
$BunInstallDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HomeDir ".bun" }
$BunBinDir = if ($env:BUN_INSTALL_BIN) { $env:BUN_INSTALL_BIN } else { Join-Path $BunInstallDir "bin" }
$JeoConfigDir = if ($env:JEO_CONFIG_DIR) { $env:JEO_CONFIG_DIR } else { Join-Path $HomeDir ".jeo" }
$JeoGlobalDir = if ($env:JEO_GLOBAL_DIR) { $env:JEO_GLOBAL_DIR } else { Join-Path $JeoConfigDir "global" }
$InstallBinDir = if ($env:JEO_INSTALL_DIR) { $env:JEO_INSTALL_DIR } else { Join-Path $HomeDir ".local\bin" }

foreach ($dir in @($BunBinDir, $InstallBinDir)) {
  foreach ($name in @("jeo.exe", "jeo", "jeo.cmd", "joc.exe", "joc", "joc.cmd")) {
    $target = Join-Path $dir $name
    if (Test-Path $target) {
      Remove-Item -Force $target -ErrorAction SilentlyContinue
      Write-Output "Removed $target"
    }
  }
}

if (Test-Path $JeoGlobalDir) {
  Remove-Item -Recurse -Force $JeoGlobalDir -ErrorAction SilentlyContinue
  Write-Output "Removed isolated jeo global: $JeoGlobalDir"
}

$legacyPkg = Join-Path $BunInstallDir "install\global\node_modules\jeo-code"
if (Test-Path $legacyPkg) {
  Remove-Item -Recurse -Force $legacyPkg -ErrorAction SilentlyContinue
  Write-Output "Removed legacy jeo-code from bun global: $legacyPkg"
}

if ($Purge -and (Test-Path $JeoConfigDir)) {
  Remove-Item -Recurse -Force $JeoConfigDir -ErrorAction SilentlyContinue
  Write-Output "Removed $JeoConfigDir"
}

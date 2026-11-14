# jeo (jeo-code) Windows installer — isolated Bun global install.
#
# Installs `jeo-code` via Bun into an isolated directory (%USERPROFILE%\.jeo\global)
# and links `jeo.exe` into Bun's bin directory (%USERPROFILE%\.bun\bin) so `jeo`
# never shares or mutates %USERPROFILE%\.bun\install\global (e.g. jeopi).
#
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/akillness/jeo-code/main/scripts/install.ps1 | iex
#   .\scripts\install.ps1 -Npm
#   .\scripts\install.ps1 -Npm -Ref 0.12.40
#   .\scripts\install.ps1 -Registry https://registry.npmjs.org/
#   .\scripts\install.ps1 -Local
#   .\scripts\install.ps1 -Binary
#   .\scripts\install.ps1 -DryRun

[CmdletBinding()]
param(
  [switch]$Global,
  [switch]$Npm,
  [switch]$Local,
  [switch]$Binary,
  [string]$Repo = "",
  [string]$Package = "",
  [string]$Ref = "",
  [string]$Registry = "",
  [string]$Scope = "",
  [switch]$PersistRegistry,
  [switch]$ProjectNpmrc,
  [switch]$PrintRegistry,
  [switch]$DeleteRegistry,
  [switch]$DryRun,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$DefaultRepo = "https://github.com/akillness/jeo-code.git"
if (-not $Repo) { $Repo = if ($env:JEO_REPO) { $env:JEO_REPO } elseif ($env:JEO_REPO_URL) { $env:JEO_REPO_URL } else { $DefaultRepo } }
if (-not $Package) { $Package = if ($env:JEO_PKG) { $env:JEO_PKG } else { "jeo-code" } }
if (-not $Registry) { $Registry = $env:JEO_REGISTRY }
if (-not $Scope) { $Scope = $env:JEO_REGISTRY_SCOPE }

$MinBunVersion = [Version]"1.3.14"
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } elseif ($env:HOME) { $env:HOME } else { [Environment]::GetFolderPath("UserProfile") }
$BunInstallDir = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HomeDir ".bun" }
$BunBinDir = if ($env:BUN_INSTALL_BIN) { $env:BUN_INSTALL_BIN } else { Join-Path $BunInstallDir "bin" }
$JeoConfigDir = if ($env:JEO_CONFIG_DIR) { $env:JEO_CONFIG_DIR } else { Join-Path $HomeDir ".jeo" }
$JeoGlobalDir = if ($env:JEO_GLOBAL_DIR) { $env:JEO_GLOBAL_DIR } else { Join-Path $JeoConfigDir "global" }
$InstallBinDir = if ($env:JEO_INSTALL_DIR) { $env:JEO_INSTALL_DIR } else { Join-Path $HomeDir ".local\bin" }

function Show-Usage {
  Write-Output @"
jeo Windows installer (isolated Bun global install)
  (default)             install jeo-code via Bun into $JeoGlobalDir -> $BunBinDir\jeo.exe
  -Npm                  install $Package from npm registry
  -Repo <url|owner/repo> git source (default $DefaultRepo)
  -Package <name>       npm package name (default $Package)
  -Ref <ref>            tag, branch, commit, or npm version
  -Registry <url>       one-shot registry URL for this install
  -Scope <@scope>       registry scope for -PersistRegistry / -ProjectNpmrc
  -PersistRegistry      run 'npm config set registry <url>'
  -ProjectNpmrc         write registry=<url> to .\.npmrc
  -PrintRegistry        print configured npm registry and exit
  -DeleteRegistry       delete configured npm registry and exit
  -Local                install from current clone via 'bun link'
  -Binary               compile standalone jeo.exe into $InstallBinDir
  -DryRun               print commands without making changes
  -Help                 show this help
"@
}

if ($Help) { Show-Usage; exit 0 }

function Get-RegistryKey {
  if ($Scope) {
    if ($Scope.StartsWith("@")) { return "$Scope:registry" }
    return "@$Scope:registry"
  }
  return "registry"
}

function Assert-RegistryUrl {
  if (-not $Registry) { return }
  if ($Registry -notmatch '^https?://') {
    throw "-Registry must start with http:// or https:// (got '$Registry')"
  }
}

function Require-Npm {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required for npm config operations."
  }
}

if ($PrintRegistry) {
  Require-Npm
  & npm config get (Get-RegistryKey)
  exit $LASTEXITCODE
}

if ($DeleteRegistry) {
  Require-Npm
  $k = Get-RegistryKey
  if ($DryRun) { Write-Output "+ npm config delete $k" } else { & npm config delete $k }
  exit 0
}

if ($PersistRegistry) {
  Assert-RegistryUrl
  Require-Npm
  $k = Get-RegistryKey
  if ($DryRun) { Write-Output "+ npm config set $k $Registry" } else { & npm config set $k $Registry }
  Write-Output "Persisted npm config: $k=$Registry"
}

if ($ProjectNpmrc) {
  Assert-RegistryUrl
  $k = Get-RegistryKey
  if ($DryRun) { Write-Output "+ Set-Content .npmrc '$k=$Registry'" } else { Set-Content -Path ".npmrc" -Value "$k=$Registry" -Encoding UTF8 }
  Write-Output "Wrote project registry config: .npmrc ($k=$Registry)"
}

function Resolve-Bun {
  $cmd = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $cmd) {
    $candidate = Join-Path $BunBinDir "bun.exe"
    if (Test-Path $candidate) {
      $env:PATH = "$BunBinDir;$env:PATH"
      $cmd = Get-Command bun -ErrorAction SilentlyContinue
    }
  }
  if (-not $cmd) {
    if ($DryRun) {
      Write-Output "+ irm https://bun.sh/install.ps1 | iex"
      return "bun"
    }
    Write-Output "Installing Bun (required runtime)..."
    Invoke-RestMethod "https://bun.sh/install.ps1" | Invoke-Expression
    $env:PATH = "$BunBinDir;$env:PATH"
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "Bun installation finished, but 'bun' is still not on PATH." }
  }
  $verRaw = (& $cmd.Source --version).Trim()
  $verClean = ($verRaw -split '-')[0]
  if ([Version]$verClean -lt $MinBunVersion) {
    throw "Bun $MinBunVersion+ required (found $verClean). Upgrade with: bun upgrade"
  }
  return $cmd.Source
}

function Get-RepoSpec([string]$r) {
  $spec = if ($r -match '^(github:|git\+|ssh://|git@)') { $r }
    elseif ($r -match '^https?://') { "git+$r" }
    elseif ($r -match '/') { "github:$r" }
    else { $r }
  if ($Ref) { $spec = "$spec#$Ref" }
  return $spec
}

function Invoke-IsolatedBunAdd([string]$BunExe, [string]$Spec) {
  $stagingBin = Join-Path $JeoGlobalDir "bin"
  if ($DryRun) {
    if ($Registry) {
      Assert-RegistryUrl
      Write-Output "+ BUN_INSTALL_GLOBAL_DIR=$JeoGlobalDir BUN_INSTALL_BIN=$stagingBin NPM_CONFIG_REGISTRY=$Registry bun add -g $Spec"
    } else {
      Write-Output "+ BUN_INSTALL_GLOBAL_DIR=$JeoGlobalDir BUN_INSTALL_BIN=$stagingBin bun add -g $Spec"
    }
    Write-Output "+ BUN_INSTALL_GLOBAL_DIR=$JeoGlobalDir BUN_INSTALL_BIN=$BunBinDir bun add -g $Spec"
    return
  }

  New-Item -ItemType Directory -Force -Path $JeoGlobalDir, $stagingBin, $BunBinDir | Out-Null

  # Sweep stale .jeo-bak.* files from earlier updates.
  Get-ChildItem -Path $BunBinDir -Filter "*.jeo-bak.*" -ErrorAction SilentlyContinue | ForEach-Object {
    try { Remove-Item -Force $_.FullName -ErrorAction Stop } catch {}
  }

  $prevGlobal = $env:BUN_INSTALL_GLOBAL_DIR
  $prevBin = $env:BUN_INSTALL_BIN
  $prevRegUpper = $env:NPM_CONFIG_REGISTRY
  $prevRegLower = $env:npm_config_registry

  try {
    if ($Registry) {
      Assert-RegistryUrl
      $env:NPM_CONFIG_REGISTRY = $Registry
      $env:npm_config_registry = $Registry
    }

    # Step 1: Stage into isolated global dir first so existing jeo.exe stays intact on failure.
    $env:BUN_INSTALL_GLOBAL_DIR = $JeoGlobalDir
    $env:BUN_INSTALL_BIN = $stagingBin
    & $BunExe add -g $Spec --no-cache
    if ($LASTEXITCODE -ne 0) { throw "bun add -g $Spec failed with exit code $LASTEXITCODE" }

    # Step 2: Move aside existing jeo/joc shims (Windows allows renaming a running .exe).
    $backups = @()
    foreach ($name in @("jeo.exe", "jeo", "jeo.cmd", "joc.exe", "joc", "joc.cmd")) {
      $orig = Join-Path $BunBinDir $name
      if (Test-Path $orig) {
        $bak = "$orig.jeo-bak.$PID"
        try {
          Move-Item -Force -Path $orig -Destination $bak -ErrorAction Stop
          $backups += @{ Original = $orig; Backup = $bak }
        } catch {}
      }
    }

    # Step 3: Link native Windows shim in $BunBinDir pointing at $JeoGlobalDir.
    $env:BUN_INSTALL_BIN = $BunBinDir
    & $BunExe add -g $Spec
    if ($LASTEXITCODE -ne 0) {
      foreach ($b in $backups) {
        try { Move-Item -Force -Path $b.Backup -Destination $b.Original -ErrorAction SilentlyContinue } catch {}
      }
      throw "bun shim link into $BunBinDir failed with exit code $LASTEXITCODE"
    }

    foreach ($b in $backups) {
      try { Remove-Item -Force -Path $b.Backup -ErrorAction SilentlyContinue } catch {}
    }
  } finally {
    $env:BUN_INSTALL_GLOBAL_DIR = $prevGlobal
    $env:BUN_INSTALL_BIN = $prevBin
    $env:NPM_CONFIG_REGISTRY = $prevRegUpper
    $env:npm_config_registry = $prevRegLower
  }
}

$bunExe = Resolve-Bun

if ($Local) {
  $srcDir = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path (Join-Path $srcDir "src\cli.ts"))) {
    throw "-Local: expected src\cli.ts under $srcDir"
  }
  if ($DryRun) {
    Write-Output "+ Push-Location $srcDir; bun install --silent; bun link; Pop-Location"
  } else {
    Push-Location $srcDir
    try {
      & $bunExe install --silent
      & $bunExe link
    } finally {
      Pop-Location
    }
  }
} elseif ($Binary) {
  $srcDir = Split-Path -Parent $PSScriptRoot
  if (-not (Test-Path (Join-Path $srcDir "src\cli.ts"))) {
    throw "-Binary must be run from a clone (expected src\cli.ts under $srcDir)"
  }
  $outExe = Join-Path $InstallBinDir "jeo.exe"
  if ($DryRun) {
    Write-Output "+ Push-Location $srcDir; bun install --silent; bun build src\cli.ts --compile --outfile $outExe; Pop-Location"
  } else {
    New-Item -ItemType Directory -Force -Path $InstallBinDir | Out-Null
    Push-Location $srcDir
    try {
      & $bunExe install --silent
      & $bunExe build src\cli.ts --compile --outfile $outExe
      if ($LASTEXITCODE -ne 0) { throw "bun build --compile failed with exit code $LASTEXITCODE" }
    } finally {
      Pop-Location
    }
    Write-Output "Compiled standalone binary -> $outExe"
  }
} elseif ($Npm -or (-not $Global -and -not $PSBoundParameters.ContainsKey("Repo"))) {
  $spec = if ($Ref) { "$Package@$Ref" } else { $Package }
  Write-Output "Installing $Package into isolated Bun global ($JeoGlobalDir) from npm ($spec)..."
  Invoke-IsolatedBunAdd -BunExe $bunExe -Spec $spec
} else {
  $spec = Get-RepoSpec $Repo
  Write-Output "Installing $Package into isolated Bun global ($JeoGlobalDir) from $spec..."
  Invoke-IsolatedBunAdd -BunExe $bunExe -Spec $spec
}

if ($DryRun) {
  Write-Output "`nDry run complete; no install changes were made."
  exit 0
}

$exePath = Join-Path $BunBinDir "jeo.exe"
if (Test-Path $exePath) {
  Write-Output "`nInstalled jeo via Bun -> $exePath"
}
if (($env:PATH -split ';') -contains $BunBinDir) {
  Write-Output "Run: jeo --help"
} else {
  Write-Output "Add $BunBinDir to PATH, then run: jeo --help"
}

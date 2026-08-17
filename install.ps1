#requires -version 5.1
<#
.SYNOPSIS
  Installs the /goal command + goal-enforcer plugin into OpenCode's global
  config directory by symlinking (default) or copying the files from this
  repo checkout.

.PARAMETER Copy
  Copy the files instead of symlinking. Use this if symlink creation fails
  (requires Developer Mode or admin rights on Windows) or if you prefer a
  plain copy that won't change when you `git pull` later.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Copy
#>
param(
  [switch]$Copy
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$configDir = Join-Path $env:USERPROFILE ".config\opencode"

New-Item -ItemType Directory -Force -Path (Join-Path $configDir "plugin") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $configDir "command") | Out-Null

$targets = @(
  @{ Src = Join-Path $repoRoot "plugin\goal-enforcer.ts"; Dst = Join-Path $configDir "plugin\goal-enforcer.ts" },
  @{ Src = Join-Path $repoRoot "command\goal.md"; Dst = Join-Path $configDir "command\goal.md" }
)

foreach ($t in $targets) {
  $src = $t.Src
  $dst = $t.Dst

  if (Test-Path -LiteralPath $dst) {
    Remove-Item -LiteralPath $dst -Force
  }

  if ($Copy) {
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "Copied  $src -> $dst"
    continue
  }

  try {
    New-Item -ItemType SymbolicLink -Path $dst -Target $src -ErrorAction Stop | Out-Null
    Write-Host "Linked  $dst -> $src"
  } catch {
    Write-Warning "Symlink creation failed (needs Developer Mode or an elevated shell on Windows). Falling back to copy."
    Copy-Item -LiteralPath $src -Destination $dst -Force
    Write-Host "Copied  $src -> $dst"
  }
}

Write-Host ""
Write-Host "Done. Restart OpenCode (or start a new session) so it picks up the plugin."

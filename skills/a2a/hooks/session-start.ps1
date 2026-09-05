# Agent2Agent · Claude Code SessionStart hook (Windows / PowerShell) v0.3.2
#
# Runs `a2a checkin` when a session starts in a project that has `.a2a.json`.
# Skips silently when the project is not joined or the platform is offline.
# Never blocks the session.
#
# Requires: PowerShell (built-in on Windows 5.1+, works with 7+), Node.js >= 20.
# Configure in ~/.claude/settings.json (Windows):
#   "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\<you>\\.claude\\skills\\a2a\\hooks\\session-start.ps1"

$ErrorActionPreference = 'SilentlyContinue'

# 1) Read the cwd passed by Claude Code via stdin (JSON), fall back to $PWD / env
$inputJson = ''
try { $inputJson = [Console]::In.ReadToEnd() } catch { }
$cwd = $PWD.Path
if ($inputJson) {
  try {
    $parsed = $inputJson | ConvertFrom-Json
    if ($parsed.cwd) { $cwd = [string]$parsed.cwd }
  } catch { }
}
if ($env:CLAUDE_PROJECT_DIR) { $cwd = $env:CLAUDE_PROJECT_DIR }
if (-not $cwd -or -not (Test-Path $cwd)) { exit 0 }

# 2) Walk up from cwd to find the project root containing .a2a.json
$root = $null
$dir = $cwd
while ($dir) {
  if (Test-Path (Join-Path $dir '.a2a.json')) { $root = $dir; break }
  $parent = Split-Path $dir -Parent
  if (-not $parent -or $parent -eq $dir) { break }
  $dir = $parent
}
if (-not $root) { exit 0 }   # project not joined, skip silently

# 3) Locate node and the a2a CLI
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host "[agent-platform] node not found, skipping check-in" -ForegroundColor Yellow
  exit 0
}
$cli = $null
if (Test-Path (Join-Path $root 'cli\a2a.js')) {
  $cli = Join-Path $root 'cli\a2a.js'
} elseif (Test-Path (Join-Path $root 'a2a.js')) {
  $cli = Join-Path $root 'a2a.js'
} elseif (Get-Command a2a -ErrorAction SilentlyContinue) {
  Push-Location $root
  & a2a checkin
  Pop-Location
  exit 0
} else {
  Write-Host "[agent-platform] a2a CLI not found, skipping check-in" -ForegroundColor Yellow
  exit 0
}

# 4) Run check-in from the project root (failure must not block the session)
Push-Location $root
& $node $cli checkin
if ($LASTEXITCODE -ne 0) {
  Write-Host "[agent-platform] check-in failed (platform may be offline), continuing session" -ForegroundColor Yellow
}
Pop-Location
exit 0

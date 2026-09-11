# Fast real-data theme visual sweep orchestrator. Same safety model as
# run-ui-tests.ps1 (see that file's header comment for the full rationale):
# main-config.js's portableUserDataDir() hardcodes dev-mode config to
# <repo>/userData regardless of --user-data-dir, so this always moves the
# real one aside and works on a COPY of it (not the synthetic fixture
# run-ui-tests.mjs uses) so real media paths resolve and channel-flipping
# shows real content, while the original stays untouched on disk throughout.
#
# Usage: powershell -ExecutionPolicy Bypass -File test\theme-visual-sweep.ps1 [-Theme <id>] [-WindowSize WxH] [-Script name.mjs]
# -WindowSize overrides the real (maximized) window state with a specific
# non-maximized WxH (e.g. "900x600", the app's own enforced minimum) for
# testing responsive/small-window layout — omit it to use the real saved
# window state as-is (the default, and what you want for normal sweeps).
# -Script picks which driver script to run against the launched app —
# defaults to the full tab/subtab sweep (theme-visual-sweep.mjs); pass
# theme-guide-sweep.mjs for the lighter guide-only supplement (docked +
# full-page guide views only, for when you already have a full sweep and
# just need the guide screens refreshed without redoing everything else).
# Both scripts share this one wrapper rather than duplicating the
# userData backup/restore/process-cleanup safety logic below.

param(
  [string]$Theme = '',
  [string]$WindowSize = '',
  [string]$Script = 'theme-visual-sweep.mjs',
  [string]$UserDataSource = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$userDataDir = Join-Path $repoRoot 'userData'
$backupDir = Join-Path $repoRoot 'userData.sweep-backup'
$port = 9222

Set-Location $repoRoot

function Get-OurElectronProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($repoRoot) }
}

# Chromium's own runtime state, which is not config and is held open by a
# running app - copying a live install's userData failed outright on a locked
# Network\Cookies. Skipping these also takes the copy from ~534MB to a few,
# since the caches are almost all of it. Anything RerunTV itself cares about
# (channels.json, plugins, themes, backups, window-state.json) is kept.
$VolatileUserDataEntries = @(
    'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
    'Network', 'Local Storage', 'Session Storage', 'Shared Dictionary', 'blob_storage',
    'Crashpad', 'Dictionaries', 'Service Worker', 'component_crx_cache', 'extensions_crx_cache',
    'DIPS', 'Local State', 'SingletonCookie', 'SingletonLock', 'SingletonSocket',
    'LOG', 'LOG.old', 'lockfile'
)

function Copy-UserDataConfig {
    param([string]$SourceDir, [string]$DestDir)
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null
    $skipped = @()
    Get-ChildItem -LiteralPath $SourceDir -Force |
        Where-Object { $VolatileUserDataEntries -notcontains $_.Name } |
        ForEach-Object {
            try {
                Copy-Item -LiteralPath $_.FullName -Destination $DestDir -Recurse -Force -ErrorAction Stop
            } catch {
                # A stray lock on something non-essential should not sink the
                # whole run; the channels.json assertion below is what decides
                # whether the copy was actually usable.
                $skipped += $_.Name
            }
        }
    if ($skipped.Count) {
        Write-Host "  (skipped locked entries: $($skipped -join ', '))" -ForegroundColor Yellow
    }
    if (-not (Test-Path -LiteralPath (Join-Path $DestDir 'channels.json'))) {
        throw "Copy produced no channels.json in $DestDir - the source config did not come across."
    }
}

function Stop-OurElectronProcesses {
    $procs = Get-OurElectronProcesses
    if (-not $procs) { return }
    Write-Host "Stopping $($procs.Count) electron.exe process(es) for this repo..." -ForegroundColor Cyan
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-OurElectronProcesses)) { return }
        Start-Sleep -Milliseconds 300
    }
    $stragglers = Get-OurElectronProcesses
    if ($stragglers) {
        Write-Host "Warning: $($stragglers.Count) electron.exe process(es) did not exit in time." -ForegroundColor Yellow
    }
}

Stop-OurElectronProcesses
if (Test-Path $backupDir) {
    Write-Host "Found a leftover userData.sweep-backup - restoring it now before starting." -ForegroundColor Yellow
    if (Test-Path $userDataDir) { Remove-Item -Recurse -Force $userDataDir }
    Rename-Item -Path $backupDir -NewName 'userData'
}

$movedRealUserData = $false
if (Test-Path $userDataDir) {
    Write-Host "Backing up real userData to userData.sweep-backup" -ForegroundColor Cyan
    Rename-Item -Path $userDataDir -NewName 'userData.sweep-backup'
    $movedRealUserData = $true
}

$electronProc = $null
$exitCode = 2

try {
    $fixtureSource = $backupDir
    if ($UserDataSource) {
        $fixtureSource = (Resolve-Path -LiteralPath $UserDataSource).Path
        if (-not (Test-Path -LiteralPath (Join-Path $fixtureSource 'channels.json'))) {
            throw "-UserDataSource must contain channels.json: $fixtureSource"
        }
    }
    Write-Host "Copying audit userData from $fixtureSource into a throwaway working copy (source is never touched)..." -ForegroundColor Cyan
    Copy-UserDataConfig -SourceDir $fixtureSource -DestDir $userDataDir
    # Deliberately NOT overwriting window-state.json here (an earlier version
    # of this script did, with a hand-rolled '{"isMaximized":true,...}' that
    # omitted x/y) - main-window-state.js's boundsOnScreen() requires numeric
    # x/y to trust a saved state at all, so that stripped-down JSON silently
    # failed validation and every screenshot in the first real run of this
    # script was taken at the small un-maximized 1280x800 default instead of
    # the real monitor's full resolution. The real userData's own
    # window-state.json (just copied above) already has a valid, complete
    # maximized state - use that as-is.
    if ($WindowSize) {
        $parts = $WindowSize -split 'x'
        if ($parts.Count -ne 2) { throw "-WindowSize must be like 900x600, got: $WindowSize" }
        $wsJson = @{ isMaximized = $false; width = [int]$parts[0]; height = [int]$parts[1]; x = 40; y = 40 } | ConvertTo-Json -Compress
        $wsJson | Set-Content -Path (Join-Path $userDataDir 'window-state.json') -Encoding utf8 -NoNewline
    }

    Write-Host "Launching Electron with CDP on port $port ..." -ForegroundColor Cyan
    $electronCmd = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
    $stdout = Join-Path $PSScriptRoot 'sweep-electron-stdout.log'
    $stderr = Join-Path $PSScriptRoot 'sweep-electron-stderr.log'
    $electronProc = Start-Process -FilePath $electronCmd -ArgumentList @('.', "--remote-debugging-port=$port") `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Normal

    Write-Host "Waiting for the CDP endpoint to come up..." -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
            $ready = $true
            break
        } catch { }
    }
    if (-not $ready) {
        throw "Electron never opened its CDP port. Check $stdout and $stderr."
    }
    Write-Host "App is up. Running the sweep..." -ForegroundColor Green

    $scriptArgs = @()
    if ($Theme) { $scriptArgs += "--theme=$Theme" }
    & node (Join-Path $PSScriptRoot $Script) @scriptArgs
    $exitCode = $LASTEXITCODE
}
finally {
    Stop-OurElectronProcesses
    if (Test-Path $userDataDir) { Remove-Item -Recurse -Force $userDataDir -ErrorAction SilentlyContinue }
    if ($movedRealUserData) {
        Write-Host "Restoring real userData..." -ForegroundColor Cyan
        if (Test-Path $userDataDir) { Remove-Item -Recurse -Force $userDataDir }
        Rename-Item -Path $backupDir -NewName 'userData'
    }
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "Theme visual sweep DONE." -ForegroundColor Green
} else {
    Write-Host "Theme visual sweep FAILED (exit $exitCode) - see test\sweep-electron-*.log" -ForegroundColor Red
}
exit $exitCode

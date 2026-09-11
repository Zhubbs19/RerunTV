# RerunTV UI test suite orchestrator.
#
# SAFETY: this app hardcodes its dev-mode config location to <repo>/userData
# (main-config.js's portableUserDataDir - it ignores Electron's normal
# --user-data-dir switch entirely by design, for portable installs). That
# folder is the developer's REAL live config (channels, plugins, etc.), so
# this script always moves it aside before launching and restores it
# afterward, in a "finally", so a crashed test run or a killed script still
# gets the real data back. Never run tests against userData directly.
#
# Process cleanup finds every electron.exe whose command line mentions this
# repo (Win32_Process, not Stop-Process -Name, which would also kill an
# unrelated Electron app the user happens to have open) and waits for them to
# actually exit before touching userData again - Start-Process against
# electron.cmd returns the cmd.exe wrapper's PID, not any of the real
# electron.exe processes it spawns, so killing "the" PID from Start-Process
# does not reliably kill anything; this replaces that approach after it left
# orphaned processes holding file locks on userData during development of
# this script.
#
# -UserDataSource points the run at an existing config to start from (it is
# copied into the throwaway working copy; the source is only ever read). The
# installed app's own userData is the one worth testing against - a fresh,
# empty one has no channels, no installed plugins and no approved
# capabilities, so a sweep over it screenshots an empty app and passes checks
# that real data would fail. Same parameter, same semantics as
# theme-visual-sweep.ps1. Omit it only to test genuine first-run behaviour.
#
# Usage: powershell -ExecutionPolicy Bypass -File test\run-ui-tests.ps1 `
#          -UserDataSource "C:\Users\<you>\Apps\RerunTV\userData"

# -Script runs a different driver .mjs against the same launched app instead
# of the full sweep. It exists so a targeted, single-feature check gets the
# userData backup/restore and electron.exe cleanup above for free rather than
# tempting anyone to launch Electron by hand against the real config, which
# is the one thing this whole wrapper exists to prevent. The driver still
# takes the CDP port as its only argument.
# -PreApprovePlugin approves a plugin's declared capabilities inside the
# THROWAWAY copy (never the source), via the same lib/preapprove-plugin.js
# theme-visual-sweep.ps1 uses. Needed for a brand-new plugin, or any plugin
# whose manifest capabilities changed: without approval its main-process half
# never activates, so its renderer loads but every one of its ipcMain
# handlers is missing, which reads as a pile of unrelated failures. Accepts
# several ids.
param(
    [string]$UserDataSource = '',
    [string]$Script = 'run-ui-tests.mjs',
    [string[]]$PreApprovePlugin = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$userDataDir = Join-Path $repoRoot 'userData'
$backupDir = Join-Path $repoRoot 'userData.test-backup'
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

# Clean up after a previous run that did not finish (crashed, was killed,
# etc.) before doing anything else, same as the normal end-of-run cleanup.
Stop-OurElectronProcesses
if (Test-Path $backupDir) {
    Write-Host "Found a leftover userData.test-backup - restoring it now before starting." -ForegroundColor Yellow
    if (Test-Path $userDataDir) { Remove-Item -Recurse -Force $userDataDir }
    Rename-Item -Path $backupDir -NewName 'userData'
}

$movedRealUserData = $false
if (Test-Path $userDataDir) {
    Write-Host "Backing up real userData to userData.test-backup" -ForegroundColor Cyan
    Rename-Item -Path $userDataDir -NewName 'userData.test-backup'
    $movedRealUserData = $true
}

if ($UserDataSource) {
    $sourceDir = (Resolve-Path -LiteralPath $UserDataSource).Path
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'channels.json'))) {
        throw "-UserDataSource must contain channels.json: $sourceDir"
    }
    if ($sourceDir -eq $userDataDir -or $sourceDir -eq $backupDir) {
        throw "-UserDataSource must not be this repo's own userData (it is the folder being replaced): $sourceDir"
    }
    Write-Host "Copying userData from $sourceDir into a throwaway working copy (the source is never written to)..." -ForegroundColor Cyan
    Copy-UserDataConfig -SourceDir $sourceDir -DestDir $userDataDir
} else {
    New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
}

# Maximize on launch - main.js reads this file itself before any window
# exists. Screenshots capture the full scrollable page regardless, but a
# maximized window is closer to real usage and needs less of that virtual
# scrolling. Written unconditionally (including over a copied-in state) so
# every run screenshots at the same size; x/y are included because
# main-window-state.js's boundsOnScreen() rejects a saved state without
# numeric coordinates and silently falls back to the small default.
@{ isMaximized = $true; width = 1600; height = 1000; x = 40; y = 40 } |
    ConvertTo-Json -Compress |
    Set-Content -Path (Join-Path $userDataDir 'window-state.json') -Encoding utf8 -NoNewline

$electronProc = $null
$exitCode = 2

try {
    # Invoked through `powershell -File`, arguments arrive as plain strings
    # with no array parsing, so `-PreApprovePlugin a,b` lands as one string.
    # Splitting here makes both that and the native array form work.
    $approveIds = $PreApprovePlugin | ForEach-Object { $_ -split ',' } | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() }
    foreach ($pluginId in $approveIds) {
        & node (Join-Path $PSScriptRoot 'lib\preapprove-plugin.js') $repoRoot $userDataDir $pluginId
        if ($LASTEXITCODE -ne 0) { throw "Pre-approving $pluginId failed." }
    }

    Write-Host "Launching Electron against the throwaway userData copy, CDP on port $port ..." -ForegroundColor Cyan
    $electronCmd = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
    $stdout = Join-Path $PSScriptRoot 'electron-stdout.log'
    $stderr = Join-Path $PSScriptRoot 'electron-stderr.log'
    $electronProc = Start-Process -FilePath $electronCmd -ArgumentList @('.', "--remote-debugging-port=$port") `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Normal

    Write-Host "Waiting for the CDP endpoint to come up..." -ForegroundColor Cyan
    # Two distinct failures used to look identical here, and "never opened its
    # CDP port" sent three separate investigations down the wrong path: the app
    # can be alive and slow, or it can have exited during startup. Those need
    # opposite fixes, so tell them apart and say which one happened. The budget
    # is also generous now, because the app's own startup update check can
    # legitimately hold the window back for a while.
    $ready = $false
    $died = $false
    for ($i = 0; $i -lt 120; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
            $ready = $true
            break
        } catch { }
        # Only after a grace period: the process list is briefly empty while
        # cmd.exe is still handing off to the real electron.exe.
        if ($i -gt 6 -and -not (Get-OurElectronProcesses)) { $died = $true; break }
    }
    if (-not $ready) {
        Write-Host "--- electron stdout ---" -ForegroundColor Yellow
        if (Test-Path $stdout) { Get-Content $stdout -Tail 40 | ForEach-Object { Write-Host "  $_" } }
        Write-Host "--- electron stderr ---" -ForegroundColor Yellow
        if (Test-Path $stderr) { Get-Content $stderr -Tail 40 | ForEach-Object { Write-Host "  $_" } }
        if ($died) {
            throw "Electron exited during startup (no process left). Its output, if any, is above."
        }
        throw "Electron is still running but never opened its CDP port within 60s. Its output, if any, is above."
    }
    Write-Host "App is up. Running the test suite..." -ForegroundColor Green

    $driver = Join-Path $PSScriptRoot $Script
    if (-not (Test-Path -LiteralPath $driver)) { throw "Driver script not found: $driver" }
    & node $driver $port
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
    Write-Host "UI test suite PASSED." -ForegroundColor Green
} else {
    Write-Host "UI test suite FAILED (exit $exitCode) - see test\results.json and test\screenshots\" -ForegroundColor Red
}
exit $exitCode

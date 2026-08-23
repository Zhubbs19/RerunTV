@echo off
cd /d "%~dp0"
rem node_modules\.bin\electron.cmd resolves to node.exe running electron's
rem cli.js, and node.exe is a console-subsystem binary — that's what pops
rem the cmd.exe window with every console.log from boot (the ffmpeg-static
rem fallback line, etc.) every time this script runs. electron.exe itself
rem is a proper Windows GUI-subsystem binary — launching it directly, and
rem detaching it from this script's own console via `start`, means no
rem console shows at all, same as double-clicking the actual packaged app.
start "" "node_modules\electron\dist\electron.exe" .

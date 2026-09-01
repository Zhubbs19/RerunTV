@echo off
cd /d "%~dp0"
echo Starting RerunTV in SERVER mode.
echo No playback window will open. A small local control page will open in
echo your browser with the pairing code, TV viewer URLs, and Stop button.
echo.
echo Press Ctrl+C, or just close this window, to stop the server.
echo.
if exist "%~dp0RerunTV.exe" (
  "%~dp0RerunTV.exe" --server
) else (
  node_modules\.bin\electron.cmd . --server
)
echo.
echo Server stopped.
pause

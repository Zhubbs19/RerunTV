@echo off
cd /d "%~dp0"
echo Starting RerunTV fully headless.
echo No app or browser window will open. The console prints the local
echo control-panel URL and paired TV viewer URLs once the server is ready.
echo.
echo Press Ctrl+C, or close this window, to stop the server.
echo.
if exist "%~dp0RerunTV.exe" (
  "%~dp0RerunTV.exe" --headless
) else (
  node_modules\.bin\electron.cmd . --headless
)
echo.
echo Server stopped.
pause

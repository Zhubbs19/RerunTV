@echo off
cd /d "%~dp0"
echo Starting RerunTV in SERVER mode.
echo No window will open on this PC - other devices on your network can
echo still watch, using the URLs printed below (also shown in the app's
echo own Settings screen under WATCH ON OTHER DEVICES when run normally).
echo.
echo Press Ctrl+C, or just close this window, to stop the server.
echo.
node_modules\.bin\electron.cmd . --headless
echo.
echo Server stopped.
pause

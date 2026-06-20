@echo off
title Verdesakay Office System
cd /d "%~dp0"
echo Starting Verdesakay Office System...
echo.
echo Keep this window open while the system is in use.
echo Close it to stop the server.
echo.
node server.js
if errorlevel 1 (
  echo.
  echo The server stopped unexpectedly. Make sure Node.js is installed.
  pause
)

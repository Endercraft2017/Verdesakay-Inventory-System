@echo off
title Verdesakay Office System
cd /d "%~dp0"
echo Starting Verdesakay Office System...
echo.
if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  echo.
)
echo Keep this window open while the system is in use.
echo Close it to stop the server.
echo.
call npm start
if errorlevel 1 (
  echo.
  echo The server stopped unexpectedly. Make sure Node.js 22+ is installed.
  pause
)

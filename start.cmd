@echo off
setlocal EnableDelayedExpansion

rem ---------------------------------------------------------------------------
rem  Re-entry: when this script relaunches itself as "start.cmd __open <port> <url>"
rem  it just waits for the server to come up and then opens the browser.
rem ---------------------------------------------------------------------------
if /i "%~1"=="__open" goto :open_browser

title Verdesakay Office System
cd /d "%~dp0"

rem --- Work out the port + scheme the server will use -------------------------
if not defined PORT set "PORT=3000"
set /a "HTTP_PORT=PORT+1"
set "SCHEME=http"
if exist "%~dp0certs\cert.pem" set "SCHEME=https"
if /i "%SCHEME%"=="http" ( where openssl >nul 2>&1 && set "SCHEME=https" )
set "URL=%SCHEME%://localhost:%PORT%/"

echo Starting Verdesakay Office System...
echo.

rem --- Stop any previous instance still holding the ports --------------------
call :free_port %PORT%
call :free_port %HTTP_PORT%

if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  echo.
)

echo Keep this window open while the system is in use.
echo Close it to stop the server.
echo The browser will open at %URL% once the server is ready.
echo.

rem --- Helper window: waits for the port, then opens the browser ------------
start "Verdesakay - open browser" /min "%~f0" __open %PORT% "%URL%"

call npm start
if errorlevel 1 (
  echo.
  echo The server stopped unexpectedly. Make sure Node.js 22+ is installed.
  pause
)
exit /b 0

rem =========================================================================
rem  :free_port <port>
rem  Make sure nothing is LISTENING on <port> before we start. Each pass asks
rem  netstat who owns the port and kills exactly that PID (no /T, no walking
rem  the process tree - killing a "stray" node PID can cascade and take down
rem  an unrelated server). Then it waits for Windows to release the socket and
rem  checks again, because taskkill returns before the port is actually free
rem  and a watcher can respawn the listener. Give up loudly after a few tries
rem  rather than falling through into an EADDRINUSE crash.
rem =========================================================================
:free_port
setlocal
set "_p=%~1"
set /a "_try=0"
set "_did="
:free_port_scan
set "_hit="
for /f "tokens=5" %%P in ('netstat -a -n -o -p tcp ^| findstr /r /c:"[^0-9]%_p% .*LISTENING"') do (
  if not "%%P"=="0" (
    set "_hit=1"
    set "_did=1"
    echo   Port %_p% is held by PID %%P - stopping it...
    taskkill /f /pid %%P >nul 2>&1
  )
)
if not defined _hit (
  if defined _did echo   Port %_p% is now free.
  endlocal & goto :eof
)
set /a "_try+=1"
if %_try% geq 6 (
  echo   WARNING: port %_p% is still in use after several attempts - the server may fail to start.
  endlocal & goto :eof
)
timeout /t 1 /nobreak >nul 2>&1
goto :free_port_scan

rem =========================================================================
rem  :open_browser  (entered as: start.cmd __open <port> <url>)
rem  Poll until something is LISTENING on <port>, then launch the URL.
rem =========================================================================
:open_browser
set "_p=%~2"
set "_url=%~3"
set /a "_tries=0"
:open_wait
netstat -a -n -p tcp | findstr /r /c:"[^0-9]%_p% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto :open_go
set /a "_tries+=1"
if %_tries% geq 120 exit /b 0
timeout /t 1 /nobreak >nul 2>&1
goto :open_wait
:open_go
rem small grace period so the TLS listener is fully accepting connections
timeout /t 1 /nobreak >nul 2>&1
start "" "%_url%"
exit /b 0

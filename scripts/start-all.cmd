@echo off
rem One click: core + discord runner + hub, each in its own window,
rem each restarted automatically if it exits. Reads .env from the repo
rem root (tokens stay there). Close a window to stop that process.
rem The repo path contains a space: `call "<path>"` keeps it intact.
cd /d "%~dp0.."
start "index-messenger core"    cmd /k call "%~dp0keep-alive.cmd" core node --env-file=.env --experimental-strip-types .\core\server.ts
ping -n 4 127.0.0.1 >nul
start "index-messenger discord" cmd /k call "%~dp0keep-alive.cmd" discord node --env-file=.env --experimental-strip-types .\adapters\discord\runner.ts
start "index-messenger hub"     cmd /k call "%~dp0keep-alive.cmd" hub node node_modules\vite\bin\vite.js --config hub\vite.config.ts --port 5173 hub
echo core :8787, discord runner, hub http://localhost:5173 started.

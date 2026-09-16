@echo off
rem One click: core + discord runner + hub, each in its own window,
rem each restarted automatically if it exits. Reads .env from the repo
rem root (tokens stay there). Close a window to stop that process.
cd /d "%~dp0.."
start "index-messenger core"   cmd /k "%~dp0keep-alive.cmd core node --env-file=.env --experimental-strip-types .\core\server.ts"
%SystemRoot%System32	imeout.exe /t 3 /nobreak >nul
start "index-messenger discord" cmd /k "%~dp0keep-alive.cmd discord node --env-file=.env --experimental-strip-types .\adapters\discord\runner.ts"
start "index-messenger hub"     cmd /k "%~dp0keep-alive.cmd hub node node_modules\vite\bin\vite.js --config hub\vite.config.ts --port 5173 hub"
echo core :8787, discord runner, hub http://localhost:5173 started.

@echo off
rem keep-alive <label> <command...>: run the command, and if it exits for
rem any reason, wait 5 s and run it again. Ctrl+C twice (or closing the
rem window) stops it for good.
set LABEL=%1
shift
set CMD=%1
:collect
shift
if "%~1"=="" goto run
set CMD=%CMD% %1
goto collect
:run
echo [%LABEL%] %date% %time% starting: %CMD%
%CMD%
echo [%LABEL%] %date% %time% exited (code %errorlevel%), restarting in 5 s...
ping -n 6 127.0.0.1 >nul
goto run

@echo off
title GrowBetter OpenAlgo Persistent Background Service Manager
cd /d "c:\Users\goutham\openalgo\broker"

echo ========================================================
echo GROWBETTER OPENALGO BACKGROUND SERVICE CONTROLLER
echo ========================================================
echo.
echo Starting Node Server in 100%% Silent Background Mode...
wscript.exe "c:\Users\goutham\openalgo\broker\start_background.vbs"

timeout /t 2 /nobreak >nul
echo.
echo Checking server status on http://localhost:4000...
powershell -Command "try { $res = Invoke-RestMethod -Uri 'http://localhost:4000/api/portfolio'; Write-Host '[SUCCESS] GrowBetter Broker Server is ACTIVE and running silently in the background!' -ForegroundColor Green } catch { Write-Host '[ERROR] Server failed to start.' -ForegroundColor Red }"

echo.
echo Press any key to exit this window. The server will CONTINUE RUNNING in the background.
pause >nul

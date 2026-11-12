@echo off
title Grow Better 24/7 Engine + Cloud Access
cd /d "c:\Users\goutham\openalgo"

echo ========================================================
echo   GROW BETTER - 24/7 LIVE CLOUD ENGINE (FREE MODE)
echo ========================================================
echo.

REM 1. Enforce Windows Keep-Awake / Lid Closed = Do Nothing
echo [CONFIG] Configuring laptop for 24/7 background operation...
powercfg /setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0 >nul 2>&1
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
powercfg /setactive SCHEME_CURRENT >nul 2>&1
echo [OK] Laptop sleep disabled on AC power. Lid close set to 'Do Nothing'.
echo.

REM 2. Check if server is already running on port 4000
powershell -NoProfile -Command "try { $res = Invoke-RestMethod -Uri 'http://localhost:4000/health' -TimeoutSec 2; Write-Host '[OK] Trading Engine is already ACTIVE on port 4000.' -ForegroundColor Green } catch { Write-Host '[STARTING] Launching background trading engine on port 4000...' -ForegroundColor Yellow; Start-Process -FilePath 'wscript.exe' -ArgumentList 'start_background.vbs' -WindowStyle Hidden; Start-Sleep -Seconds 3 }"

echo.
echo Starting secure Cloudflare Cloud Tunnel with Auto-Reconnect...
echo.

node scripts/start-cloud-tunnel.js

pause

# Run doc — OpenAlgo dev server

## Reproduce uncommitted artifacts
- No env copying needed: this thread runs in the main checkout (`C:\Users\goutham\openalgo`), where `.env` already exists (gitignored). In a fresh worktree, copy `.env` from the main checkout first.
- Dependencies: `npm install` if `node_modules` is missing.

## Run the server
- Entry: `node Server.js`. Port comes from `process.env.PORT` → `.env` (`PORT=4000`) → fallback 4000. **Note:** `.env` already sets `PORT=4000`; do NOT set `PORT=0` in the environment (earlier sessions did, making the server bind a random port).
- Start detached (PowerShell, stdout/stderr to SEPARATE files — PS fails if both share a path):
  ```
  powershell -NoProfile -Command '$env:PORT="4000"; (Start-Process -FilePath "node.exe" -ArgumentList "Server.js" -RedirectStandardOutput "<log>" -RedirectStandardError "<log>.err" -WindowStyle Hidden -PassThru).Id'
  ```
  Use single quotes around the whole -Command so bash does not expand `$env:PORT`.
- Verify: `curl http://127.0.0.1:4000/api/status` → 200; log shows `[server] listening on http://0.0.0.0:4000` (server takes ~10–15 s to boot: DB load, broker login, instrument master).
- Known boot warnings (harmless): `node-cron module not installed` fallback, `[autoRecorder] looksComplete is not defined`.

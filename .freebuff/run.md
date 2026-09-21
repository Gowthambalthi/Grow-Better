# Run doc — OpenAlgo dev server

## Reproduce uncommitted artifacts
- No env copying needed: this thread runs in the main checkout (`C:\Users\goutham\openalgo`), where `.env` already exists (gitignored). In a fresh worktree, copy `.env` from the main checkout first.
- Dependencies: `npm install` if `node_modules` is missing.

## Run the server
- Entry: `node Server.js`. Port comes from `process.env.PORT` → `.env` (`PORT=4000`) → fallback 4000. **Note:** `.env` already sets `PORT=4000`; do NOT set `PORT=0` in the environment (earlier sessions did, making the server bind a random port).
- **Current port: 4200.** A long-lived browser tab at the old 4000 origin kept serving its own cached page after code changes, so every UI fix looked like a rollback. Running on a fresh origin forces a clean load; a new origin is the reliable way to show the user current UI.
- Start detached (PowerShell, stdout/stderr to SEPARATE files — PS fails if both share a path):
  ```
  powershell -NoProfile -Command '$env:PORT="4200"; (Start-Process -FilePath "node.exe" -ArgumentList "Server.js" -RedirectStandardOutput "<log>" -RedirectStandardError "<log>.err" -WindowStyle Hidden -PassThru).Id'
  ```
- Use single quotes around the whole -Command so bash does not expand `$env:PORT`.

## Identifying the running version
- **As of the full rollback to `c7625d33` (10:29), the build chip is gone**: `GET /api/gb/build` returns 404 and the page has no `build <sha>` chip, because both were added later and were rolled back with the rest. There is no longer any in-page way to tell whether a browser tab is stale.
- Confirm the checked-out version instead:
  ```
  git diff c7625d33 -- Server.js common/market/liveCallEngine.js \
    common/market/liveStockQuoteService.js common/market/tickBoard.js public/index.html
  ```
  Empty output = the whole app is byte-identical to the 10:29 version.
- Because the auto-reload guard is gone too, a long-lived tab will keep showing its old DOM. After a code change, close the tab and reopen, or hard-refresh (`Ctrl+Shift+R`).
- Verify: `curl http://127.0.0.1:4000/api/status` → 200; log shows `[server] listening on http://0.0.0.0:4000` (server takes ~10–15 s to boot: DB load, broker login, instrument master).
- Known boot warnings (harmless): `node-cron module not installed` fallback, `[autoRecorder] looksComplete is not defined`.

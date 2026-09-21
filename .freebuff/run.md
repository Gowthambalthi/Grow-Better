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
- The build chip is gone (it was rolled back with the rest): `GET /api/gb/build` returns 404 and the page prints no `build <sha>` stamp. Check the checkout instead with `git log -1 --format=%h`, then reload - if the Terminal still shows a panel the current commit removed, that tab is stale.
- The auto-reload guard is gone too, so a long-lived tab keeps its own DOM and its own JS. After a code change, close the tab and reopen it, or hard-refresh (`Ctrl+Shift+R`).
- Tick-dependent UI: the ROC 10s/20s/30s columns and the 10-second BUY/SHORT rule read the Angel tick board (`data/live_tick_movers.json`). When the feed is dark (`/api/gb/movers` returns `stocks: 0`, Angel login 403), those cells render `-` and no fast signal can fire. That is the feed, not the UI.

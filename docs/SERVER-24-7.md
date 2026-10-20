# Running the server 24/7

**State before 2026-10-20:** `Server.js` was running on port 4000 from a `start_background.vbs`
launcher. It served fine, but **nothing supervised it** — no PM2 entry, no boot task, no logon
shortcut. A crash or a reboot left the box with no server and no alert, and only the virus-free
`node.exe` in Task Manager to notice.

## What is in place now

| Piece | File | Job |
|---|---|---|
| Process manager | `ecosystem.config.js` | PM2 app `growbetter-live`, `autorestart: true`, `max_memory_restart: 1G`, logs in `logs/`, env identical to the old launcher (`PORT=4000`, `GB_TICK_CAPTURE=1`, `GB03_SIDES=short`) |
| Cut-over | `scripts/pm2-switch.js` | Moves the running server under PM2 once |
| Logon restore | `scripts/pm2-boot.js` + Startup shortcut | `pm2 resurrect`, verifies `/health`, starts from the ecosystem file if PM2 did not bring it up |
| Switch schedule | Windows task `OpenAlgoPM2Switch` | Runs the cut-over at **15:35 IST on 2026-10-20**, after the session closes |

## Why the switch is a scheduled task, not a background command

It needs a restart, and it was 14:4x IST — inside the session. Restarting a live trading server
mid-session is a gap in the feed, so the cut-over waits for the 15:30 close. A task also survives
the end of the editing session, which a background process does not.

## What the switch will not do

* **It verifies the process is ours before stopping anything.** A port number is not proof of
  ownership: it reads the listener's command line and refuses unless it is `node.exe Server.js`.
* **It refuses to run inside the session** (09:15–15:30 IST, Mon–Fri) unless `--force`.
* **It will not start a second server on a held port.**
* **It does not save a broken state.** `pm2 save` writes the list restored at boot, so it only runs
  after `/health` answers.
* **It restores the old launcher if PM2 cannot serve**, so the box is never left with nothing.

## Verified on 2026-10-20 (after the 15:30 close)

| Test | Result |
|---|---|
| Cut-over | Ran at 15:35 via the scheduled task. Old pid stopped (graceful refused, forced after 10s), `pm2 start` brought the app up in ~1.7s, `/health` 200, `pm2 save` ok. |
| Crash recovery | `taskkill /F` on the running pid → PM2 respawned it in 9s, restart counter 1, `/health` 200. |
| Reboot recovery | `pm2 kill` (daemon **and** app down, nothing on port 4000) → `node scripts/pm2-boot.js` resurrected from the dump: online, `/health` 200, exactly one app. |
| Logon script | Ran twice; never created a second app, never touched a healthy server. |

The one-shot `OpenAlgoPM2Switch` task was deleted after it ran — it is not needed again.

## Checking it

```bash
pm2 list                          # growbetter-live should be online, restart counter not climbing
curl -s http://localhost:4000/health
pm2 logs growbetter-live --lines 50
type logs\pm2-switch.log          # what the cut-over did
type logs\pm2-boot.log            # what the last logon restore did
schtasks /query /tn OpenAlgoPM2Switch /fo LIST
```

## Undo

```bash
pm2 delete growbetter-live
wscript start_background.vbs      # back to the old unsupervised launcher
schtasks /delete /tn OpenAlgoPM2Switch /f
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OpenAlgo-PM2-Boot.cmd"
```

## What "24/7" does and does not mean for alerts

The **process** runs around the clock and restarts itself. The **alerts** still only fire during the
session: both live engines have session gates (`armEndMinute`, `sessionCloseMinute`, the blocked
windows), so a call armed at 02:00 is not a thing the strategy can produce. 24/7 supervision buys
you the thing that actually breaks overnight — a crash at 23:00 leaving nothing running at 09:15.

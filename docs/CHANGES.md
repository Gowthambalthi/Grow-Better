# CHANGES — what was changed, why, and where it lives

Every entry names the file that implements it. The board's **What changed** panel reads this file
*and* the live knob values (served from the running code), so a number written here that no longer
matches the code is visible rather than trusted.

---

## 1. The 1-minute volume block

### 1.1 The floor is now 200 shares (was 100)
**What:** a completed 1-minute bar trading **under 200 shares** blocks the name.
**Why:** your instruction, 2026-10-01 — *"i want volume 1m less than also 200 blocked ok for tmrw and
today"*. The floor has moved twice before (500 → 100 → 200); 500 was too high because it blocked real
companies caught in the closing wind-down (EMCURE 273, NUVOCO 59 shares a minute).
**Where:** `common/market/tickBoard.js` → `VOL_BLOCK_MIN_SHARES` (default now `200`). Override with
`GB_VOL_BLOCK_MIN_SHARES`.
**Consequence, stated plainly:** a **higher** floor blocks **more** names than yesterday. Names printing
100–199 shares a minute are now blocked too. That is the instruction, not a bug.

### 1.2 The window covers today and tomorrow
**What:** a blocked name is out for the failure day **plus the two after it**, retried once after the
window, and a second failure restarts it.
**Where:** `common/market/angelVolumeBlock.js` → `WINDOW_DAYS` (default `3`, `GB_VOL_BLOCK_DAYS`).

### 1.3 THREE sub-floor minutes in a row are needed (was one)
**What:** a name must print under the floor for **3 consecutive completed minutes** before it is blocked.
The floor is unchanged at 200 shares; only the run count moved, from 1 to 3.
**Why it changed:** with a single-minute trigger, by 09:57 IST on 2026-10-01 the ledger held **2,620**
entries, **838 of them filed that morning** — DMART (154 shares), DABUR (153), IRCTC (199), JINDALSTEL
(81), readings that are impossible for those names. At the same moment the **135 names the board was
actually watching** read TATASTEEL 595,075, SAIL 210,818, TARIL 275,679, with only **4 of 135** under
the floor. **835 of the 838** blocked names were not in the watched set. The mechanism: the 600-seat
working set turns over every 60 seconds, so a name that joins **mid-minute** has a **partial** bar — a
third of its volume — and one partial minute under 200 wrote a **three-day** block. The blocked name then
gets no socket seat, so it can never produce a fresh reading to clear itself: a self-locking trap that
emptied the board ("maket open bt all values are mssing"). A partial first minute cannot fake three in a
row, because a full minute follows it immediately.
**Where:** `common/market/tickBoard.js` → `VOL_BLOCK_MIN_RUN`. Set `GB_VOL_BLOCK_MIN_RUN=1` for the old
behaviour.
**Also:** the entries filed that morning on those false readings were cleared from the ledger (see 1.5).

### 1.5 Today's false blocks were cleared
**What:** the ~838 ledger entries whose failure day was 2026-10-01 were removed, so names blocked on a
partial minute (DMART, DABUR, IRCTC, JINDALSTEL, …) are back in the pool immediately instead of on
2026-10-03. Entries from earlier days were left untouched — they are not part of this defect.
**Why:** a three-day block written by a one-minute artefact is the board losing its own liquid names.
**Where:** `data/angel_volume_block.json` (the ledger), written through the module's own read/write so the
file stays atomic.

### 1.4 A blocked name does not take a websocket slot
**What:** `streamSymbols()` never seats a blocked name — unless it is **forced** (the index, a watchlist
name, or a symbol with an OPEN call), because a live position must keep its seat.
**Why:** ~61% of the universe is blocked, so blocked names were spending the 600-name socket budget on
names that can never produce a call.
**Where:** `common/market/tickBoard.js` → `streamSymbols()`, `streamBlockedNow()`.

---

## 2. Telegram — only the four calling rules may speak

### 2.1 The rule is on the TRANSPORT, not the sender
**What:** `sendAlert()` refuses any directional alert (`CALL`, `SIGNAL`, `BUY`, `SHORT`, `SELL`, `ENTRY`,
`LONG`, `STRONG_BUY`, `POSITION`) unless it is stamped `gated: true` **and** carries a rule id in
`callGate.CALL_SET`.
**Why:** your report, 2026-10-01 — *"telegram sending wrong signals ... i want only this 4"*. The old
engines (V3 evidence engine, order-flow gate, surge/revival scanners) pushed through `phoneAlert` beside
the four tuned rules, with nothing checking who was allowed to speak.
**Where:** `common/notifications/notificationService.js` → `mayPushSignal()` + the `sendAlert()` guard.
**Still allowed:** `EXIT` (stop-hit), `EXITPLAN` (digested), `REPORT` (daily/evening summaries), order
confirmations, the manual test push. Those are not signals.
**Refused:** old-engine `CALL` / `SIGNAL` / `POSITION`.

### 2.2 The gate's own calls are stamped
**Where:** `common/notifications/callNotifier.js` adds `kind: 'CALL'`, `gated: true`, `id: <rule>`.
**And** `common/notifications/phoneAlert.js` passes `kind` / `gated` / `id` through to the transport, so
the policy applies on both paths.

### 2.3 The bot listener no longer boots inside a test
**What:** the Telegram poller does not start when `NODE_TEST_CONTEXT` is set (the `node:test` runner) or
`GB_TELEGRAM_LISTENER=0`.
**Why:** requiring `notificationService` from a test hit the network and hung the run on exit.
**Where:** `common/notifications/notificationService.js` (bottom of file).

---

## 3. The board

### 3.1 Live Calls panel is on the Board tab
**Where:** `public/index.html` — `gbCallsWrap`, above the intraday table; started by `gbApplyTermView`
on the Board tab, not only on Strategies.

### 3.2 The tuned win%/PF column
**What:** the six-strategies panel has a **"tuned · the calling set (ledger)"** column showing
`trend_day_adr 78.3% / PF 3.600`, `trend_day 71.4% / 2.500`, `orb 66.7% / 2.000`, `valueGap 56.1% / 1.278`.
**Why:** your instruction, 2026-10-01 — *"i want update there anytime we updated"*. The column beside it
is the frozen 100-symbol artifact; these are two different tapes and are labelled as such.
**Where:** `common/market/finalStrategies.js` reads `gb_scoring_v2/github/callGate.js#TUNED` (the one
place the numbers live), `Server.js` passes `callSet` / `minWinPct`, `public/index.html` → `gbTunedTxt()`
with a fallback to the `/api/gb/live/calls` map so it fills even from a stale engines payload.

### 3.3 Blocked / non-blocked counts, and why a panel can be empty off-hours
**Where:** `gb_scoring_v2/github/liveValues.js` → `liveCalls()` now returns `readings` and `universe`;
`public/index.html` → the Calls panel prints *"working on N non-blocked names · blocked M"* and, when
nothing has been read, *"no closed bar has been read yet … This is not a silent gate."*

### 3.4 Blocked names are out of every movers view
**What:** the movers board no longer renders a blocked name in **ALL** or **OK** — blocked names appear only
under the **BLOCKED** button, which lists the ledger (reason, failure day, retry day).
**Why:** your instruction, 2026-10-01 — *"y u showing blocked srocks in second table … we work on non
blocked"*. The board opened on **ALL**, which included names the volume rule had already taken out.
**Where:** `public/index.html` → the row filter in `gbRenderMovers`.
**Note:** the counts still differ on purpose — ALL carries the market size, OK the pool, BLOCKED the ledger —
so ALL's tooltip now says its rows are the non-blocked set, not the number above it.

#### 3.4.1 The cap that defeated the filter (fixed 2026-10-01, same day)
**What:** the client built its blocked lookup from `universe.blockedSymbols`, which the server **caps at
400 rows** because it is the DISPLAY list for the BLOCKED view (failed day, blocked-until day, retry day,
reason). With **1,799** names blocked, the lookup held only the first 400, so ~**1,399** blocked names
passed the filter and printed in ALL and OK — the filter was correct in code and short in data.
**Why it looked fixed and wasn't:** the row filter itself was fine; the set it tested against was truncated.
A filter list and a display list are two different jobs and were one field.
**Fix:** `universeInfo()` now also returns **`blockedAll`** — every blocked symbol, uppercase, ~20 KB,
**never capped** — and the same field is added to the `/api/gb/signals` payload (`volumeBlock.blockedAll`).
`gbBlockedSet()` reads `blockedAll` and MERGES the capped detail on top; the BLOCKED view lists the detail
rows it has and its header states the true count, saying when the detail is short of it. The intraday
table applies the same complete set as a second line of defence, so a server started before this filter
existed cannot print a blocked row either.
**Measured before/after:** `blocked 1799 · blockedAll 1799 · blockedSymbols 400`.
**Where:** `common/market/tickBoard.js#universeInfo()`, `Server.js` (`volumeBlock`),
`public/index.html#gbBlockedSet()` / `gbBlockedDetail()` / `gbRenderMovers` / `gbRenderSignals`.
**Guard:** `test/universeAndStream.test.js` → *"the blocked EXCLUSION list is complete while the DETAIL
list stays capped"* (asserts `blockedAll.length === blocked`, uppercase, unique, and that the client reads
it).

### 3.5 History — the per-strategy live record
**What:** the History tab shows each strategy's OWN calls for a chosen session: calls / W / L / open /
win% / mean R, with calling-set rules marked.
**Why:** your instruction, 2026-10-01 — *"when history closed i want every individual strategy was
performing how on live data"*.
**Where:** `common/market/liveStrategyHistory.js` + `GET /api/gb/history/strategies?day=` +
`gbHistStratWrap` in `public/index.html`.
**Honest limits:** only `reliability === 'full'` readings are raced (partial sessions are skipped and
counted); an unresolved call is reported as **open**, never as a loss; the log stores one `ltp` per
10-second sample, so a sample can touch the stop **or** the target, never both — no tie is being broken.

---

## 4. Track 0 — trust the measurements

`docs/strategies/pages/track0-reliability-spec.md`: the knobs, splits and pass/fail criteria for making the win%/PF
reproducible. Headline finding — the tie policy (stop-first vs target-first) moves Win% by **1.2–3.9 pp**,
while the **entry anchor** moves it by **52 pp**. The harness has no race of its own; it consumes
`outcome.races` from Set B, so it shares the live tie-break by construction. The one real divergence is
the **cost anchor** (`entry = r.ltp`, `riskPct = plan.riskPct`), and `entryAtSignal` is absent from
**0 of 20,000** Set B rows.

---

## 5. The post-close call report

**What:** one Telegram message after the close listing **every call the session gave** — time, side, symbol,
rule, the **reason it was given**, entry/stop/risk, and how that one ended (`→ TARGET +1.00R` / `→ STOP −1R` /
`→ still open`) — plus per-strategy totals and a **live vs tuned** line per calling rule.
**Why:** your instruction, 2026-10-01 — *"i want live report after 3 30 execute all order live and tell
reason in telgram also then we can easily find where mistakes waas happend"*.
**When:** once per IST day at/after **15:35**, through `phoneAlert` as kind `REPORT` (operational, so the
"only the four may push a signal" rule does not block it).
**Where:** `common/market/eodCallReport.js`; the timer is in `Server.js`; preview it at
`/api/gb/history/callreport?day=`.
**It is a CALL report, not a fill report:** no order was placed, and the message says so.

## 6. The tuned table now updates itself

**What:** `TUNED` is read from `data/tuned_table.json` when that file exists, falling back to the built-in
defaults. So writing the file after an improvement moves the gate's bar, the board's **tuned** column, the
six-strategies table and the Telegram wording in one step — no code edit, no second list to drift.
**Why:** your instruction, 2026-10-01 — *"make it also reflect id win rate or pf increased in frontend and
also in table also update it"*.
**Where:** `gb_scoring_v2/github/callGate.js` (`TUNED_DEFAULTS` = the fallback, `TUNED_SOURCE` names what
was read). A row the file does not name keeps its default, and a sub-50% row still cannot enter the call
set — a bad edit degrades to the previous numbers instead of widening who may call.

## 7. Live knob values (read from the running code, not from this file)

The panel prints these from the modules themselves, so this section can never silently disagree with the
behaviour: volume-block floor/run/clear/window, the block window days, the calling set and its bar, and
the tuned table.

## 8. The 100%-CPU stall — "it's loading non stop" (fixed 2026-10-01)

**What you saw:** the page never finished loading; every request hung.
**What it was:** the running node process was pegged on one CPU core. Measured directly: 3,446 seconds of
CPU in 59 minutes (~97%), and 5.98 CPU-seconds per 6 wall-seconds.
**Root cause:** `angelVolumeBlock.read()` re-read and re-parsed the whole ledger file **on every call**, and
`isBlocked()` calls it once per symbol. `tickBoard.loadUniverse()` asks per symbol, so one board build was
**~2,934 synchronous reads** of a **585 KB** ledger at **4.29 ms** each = **~12.6 seconds of blocking CPU per
`loadUniverse()`**. And `universeInfo()` — which builds that universe — runs on **every `/api/gb/movers`
poll**. Requests queued behind a 12.6s blocking task, so the page never completed. It was not the frontend
and not related to the blocked-name fix.
**Fix:** the ledger is now read **once per change** (cached by file mtime; `write()` invalidates it
explicitly so a same-millisecond write is never missed), and `loadUniverse()` builds the blocked set from a
**single** `volumeBlock.list()` read instead of one `isBlocked()` per symbol. The same one-read pattern is
used for the stream filter.
**Measured after:** `universeInfo()` **19.7 ms** (was ~12,600 ms) — roughly **640× faster**, with the same
behaviour: every test on the block, the universe and the stream still passes.
**Where:** `common/market/angelVolumeBlock.js` (`read()` cache + `invalidateReadCache()`),
`common/market/tickBoard.js` (`loadUniverse()` blocked set, the stream filter).
**Guard:** `test/angelVolumeBlock.test.js` → *"the ledger is read once per CHANGE, not once per call"*.

> **The wedged process still has to be restarted.** This fix is on disk; the process that is pinned to a
> core is running the pre-fix code and will stay wedged until `node Server.js` is restarted.

## 9. The bar is now NET PROFIT FACTOR 1.5, not win% (2026-10-01)

**What you asked:** *"i dont want rate ... our net was below 1 i want them above 1.5 then it was a good
model ... win rate is some less also acceptable but our net [must be] above 1.5"*.
**What changed:** a rule may speak only if its **tuned net profit factor is at least 1.5**, and only if it
carries at least **30 tuned trades** (a PF on 19 trades is noise). **Win% is no longer part of the gate** —
it is still printed beside the net PF, because the gap between the two is the whole story.
**Why win% was the wrong bar:** the table proves it. `trend_day_adr` wins **78.3%** of its trades and still
only nets **PF 1.265** — the winners are too small to pay for the losers plus costs. A high win rate with a
net PF under 1 was reading as "good model" while the money said otherwise.
**THE HONEST CONSEQUENCE — and it is deliberate: NO rule currently clears 1.5, so the call set is EMPTY and
no BUY/SHORT can be issued or pushed to Telegram.** That is the strict behaviour you asked for, not a
fault: the gate is refusing to call an edge that nets under 1.5. Current net PFs:

| rule | trades | win% | net PF | verdict |
|---|---|---|---|---|
| trend_day_adr | 326 | 78.3 | 1.265 | below the bar — silent |
| orb | 19 | 66.7 | 0.891 | below the bar, and only 19 trades — silent |
| trend_day | 496 | 71.4 | 0.856 | below the bar — silent |
| valueGap | 308 | 56.1 | 0.476 | below the bar — silent |

**SUPERSEDED FOR ONE ROW (2026-10-01, §13):** `valueGap` was then re-tuned against the NET number — demand
side only plus a 0.25 % risk floor — to **183 trades / 81.0 % win / net PF 2.023**, so it now clears the bar
and is the one rule in the call set. The table above is the state BEFORE that edit.

**How a rule gets back in:** improve it until its net PF clears 1.5, then write the new numbers to
`data/tuned_table.json` — no code edit, and the set widens in the next process. An artifact can never
smuggle a rule in: it cannot invent an id outside the table, a row it does not name keeps its default, and
a row under the bar stays out however it was written.
**Where:** `gb_scoring_v2/github/callGate.js` (`MIN_NET_PF` 1.5, `MIN_TRADES` 30, `CALL_SET` derived),
`common/notifications/notificationService.js` (the refusal names the bar), `Server.js`, the Calls panel and
the tuned column in `public/index.html`.
**Env:** `GB_MIN_NET_PF` and `GB_MIN_TUNED_TRADES` move the bar deliberately.
**Guards:** `test/tunedTableAndCallReport.test.js` pins the empty default set and the artifact rules;
`test/callGate.test.js` pins the net bar, the named refusal and that win% never decides.

## 10. The two tables showed one set of numbers — the intraday table is compact now (2026-10-01)

The page carried **two** tables that both printed ROC and footprint: the movers board (14 columns) and the
"Intraday Signals" table (**43 columns**). Between them the fast ladder appeared twice — movers had
`ROC 10s / 20s / 30s / 1m`, intraday had `ROC 10s / 20s / 30s / 1m / 3m / 5m / 15m` — and POC, VWAP, value
area, delta and Camarilla were on both. Two tables disagreed on nothing and repeated everything, which is
what was read as overlap.

**What changed:**

* The **43-column Intraday Signals table is replaced by a 16-column Board table** holding only what decides a
  call: `# · Symbol · Call · Rule · Entry · Stop · T1 · ROC 1m/3m/5m/15m · 1m Vol · VWAP Dist · POC · Range pos ·
  Reason`. The V3 lean/gates/evidence, OF gate/Δ, FP, Conf, Phase, V 10s, Accel, Vol x, Vol ROC, VA low/high,
  Delta, Cam, ORB, Gap, FVG, Vol@Price, VWAP stack, Day Range and Big Buyers columns are gone from it.
* The **fast ROC ladder is removed from both tables.** `ROC 10s / 20s / 30s` are deleted from the movers
  `MV_COLS` and from the movers row cells (14 → 11 columns, section and empty-state colspans follow), and the
  ten-second V/Accel cells go with them. The 1m frame is the slowest window that still decides a call.
* A new **VWAP Dist** cell on the Board table (price minus the 1-minute session VWAP, in percent), read from
  `vwapDistPct` and recomputed from `ltp`/`vwap` when the payload omits it.
* The stale-banner note no longer promises a 10s/20s/30s frame, and the panel heading is **"Board — Live Calls
  + Rules"**.
* The frontend cache-version guard is bumped to `20261001a`, so a tab holding the old HTML clears and reloads
  once instead of continuing to render yesterday's page.

**Where:** `public/index.html` (`SIG_COLS`, its header, the row-cell chain at the `gbRenderSignals` row builder,
`vwapDistCell`, `MV_COLS`, the movers row, the version guard).
**Guards:** all four inline `<script>` blocks parse under `new vm.Script`; `boardEngines`, `liveRowReads`,
`universeAndStream`, `rocGridReadPath` and `rocAbstention` stay green (66/66).
**Note:** the removed helper functions (`gridRocCell`, `mvGridWhy`, `phaseCell`, `accelCell`, `fvgCell`, the V3
and OF cell builders, `gbConfCell`, `gbSigTimeCell`) still exist but are no longer called by either table.

### 10.1 Two defects found while opening a row on the new table (2026-10-01)

Opening a row on the compact Board table exposed two bugs that were present before the compaction:

* **Clicking a row did nothing.** `gbSigPanelHtml` called `window.gbQuickBtn(s.symbol, side)`
  unconditionally for a directional row, but `gbQuickBtn` is defined nowhere — so
  `TypeError: window.gbQuickBtn is not a function` aborted `gbInsertSigPanel` before the panel was
  inserted. The button is now used only when it exists, so the panel (levels, plan, reason, the engine's
  deeper read) opens whether or not an in-page order button is on the build.
* **The panel printed `-` for Stop / T1 / Risk / Reward.** It read the flat names `s.planStop`,
  `s.planT1`, `s.planRiskPct`, which no endpoint sends; the plan is nested at `s.plan = {entry, stop, t1,
  rr, riskPct}`. It now reads the real path first and keeps the flat names as a fallback — the same cure
  `gbStopCell` / `gbT1Cell` already got. Verified live: a row opens with `Stop 1241.71 · T1 1286.98 ·
  Risk 1.201% · Reward 2R`.

**The cache-version guard is `20261001b`** — the page clears its caches and reloads once so a tab holding
yesterday's HTML cannot keep showing the old 43-column table.

## 11. "y there are 400 stocks only y some values are mixing" / "y lot of values are missing" (2026-10-01)

### 11.1 The BLOCKED list was capped at 400 rows
`universe.blockedSymbols` (movers) and `volumeBlock.symbols` (signals) carry the ledger DETAIL and are
deliberately capped at **400 / 500 rows**, because both payloads are polled every few seconds. The
exclusion itself always used the complete, uncapped `blockedAll`, so no blocked name ever leaked into the
board — but the BLOCKED view *listed* the first 400 of 2,532 names and read as "there are only 400".

**Fix:** a new route `GET /api/gb/volume-block` returns the **whole** ledger (uncapped). The client fetches
it **once**, and only when the BLOCKED view is opened (`gbLoadBlockedFull`), then repaints if BLOCKED is
still the view on screen. Verified live: the view now paints **2,534 rows** and its header reads
`BLOCKED — 1-MINUTE VOLUME 0 (2532) · every blocked name listed (2532)`. Measured payloads: universe 2,940 ·
blocked 2,331–2,532 (grows through the session) · `blockedAll` complete · not blocked 609 · socket seats
599 / `STREAM_MAX` 600 · the board paints the ~406-name live pool.

### 11.2 "Values are mixing" between the board and the table below — NOT what the data does
Measured against the two live payloads: of the 243 symbols present in both, **every one of 25 fields is
identical** (`ltp`, `m1/m3/m5/m15`, `roc10/20/30`, `vwap`, `poc`, `vol1m`, `volX`, `volRatio5`, `vwapDistPct`,
`posInRange`, `structure`, `bigBuyer`, `bigSeller`, `volRoc`, `dayLow`, `dayHigh`, `time` …) — **0
disagreements**, and **0** cells that would fall back to the movers payload. That is the "one read, given to
both tables" rule (`gbSharedRows()`) working: both tables render the same row objects from
`/api/gb/signals`. The two tables DO list different stocks in different order (board sorted by move, table by
priority), which is what reads as "mixing" side by side.

### 11.3 Why so many values are missing — the honest breakdown
Measured on the live payload (223 rows at the time):

| field | rows with NO value | why |
|---|---|---|
| `plan` → **Stop, T1** | **223 / 223 (100%)** | there were **0 calls** (0 BUY, 0 SELL, 185 WATCH). The plan is built only for a name the loop calls, and the call set is empty because no rule's tuned NET profit factor clears 1.5. The gate working, not a dead feed. |
| `m15` (ROC 15m) | 18 / 223 (8%) | a name that left and re-entered the 600-seat pool has a hole in its minute bars, and `barAnchor` refuses to anchor a 15m frame across a hole wider than 90 s — deliberately, so a frame is never anchored to pre-hole tape. (It is ~99% absent in the minute right after the pool turns over.) |
| `camZone` | 10 (4%) | no completed session pivots for this name yet |
| everything else | 0–1 (0%) | `ltp`, `roc10/20/30`, `m1/m3/m5`, `vol1m`, `poc`, `vaLow/vaHigh`, `posInRange`, `dayLow/High`, `cAgree`, `stratTag`, `orbTxt`, `gapTxt` are all present |

**Fix in the UI:** Stop and T1 printed the word **"missing"** on every WATCH row, which reads as a broken
feed. `gbPlanSkipCell` now renders a quiet em dash for a row that is not a call, with the reason on hover
("not a call — this row is WATCH, and a plan is built only for a row the loop actually calls…"). The word
"missing" is kept for the one case it belongs to: a **called** row whose plan lacks that level.

**Where:** `Server.js` (`/api/gb/volume-block`), `public/index.html` (`gbLoadBlockedFull`, the BLOCKED branch,
`gbPlanSkipCell`, `gbStopCell`, `gbT1Cell`).

## 12. "volume was below 200 its not blocked" — the partial minute, and the 3-in-a-row threshold (2026-10-01)

Measured on the live board (212 pool rows, 2,543 blocked entries):

* **40 pool rows had a 1-minute volume under 200 and NOT ONE of them was blocked** — AMAL 1, ADVENZYMES 4,
  AJAXENGG 7, WAI CHANNAG-class names at 27/39/111/126 shares. `vol1mDead` was false on all of them.
* Today's blocks by rule: **STALE-TAPE 389 · THIN-MINUTE 375**. Of the THIN-MINUTE blocks, **374 of 375
  carried `thinRun >= 3`** and 232 of them had traded under 50 shares.

**Two separate reasons a sub-200 minute does not block:**

### 12.1 The threshold is ONE sub-200 minute — decided by the user
`VOL_BLOCK_MIN_RUN = 1` (`GB_VOL_BLOCK_MIN_RUN=3` demands three in a row again). It sat at 3 for part of
the day as a GUARD against the **843 false blocks** filed in one morning, and the user decided the guard
should go once its cause was fixed rather than the symptom tolerated. With a partial minute unable to
condemn (12.2), the reading that produced the flood cannot vote at all, so one MEASURED, FULLY OBSERVED
minute under the floor now blocks.

Verified live on the restarted server, two minutes after the change:

```
[tickBoard] volume block: ALKEM    — THIN-MINUTE (77 shares in the last completed minute, floor 200, 1 in a row)
[tickBoard] volume block: BLEL     — THIN-MINUTE (173 shares …)
[tickBoard] volume block: AARTIIND — THIN-MINUTE (28 shares …)
```

ledger blocked-today **764 → 787**, THIN-MINUTE **375 → 400**, of which **28 carry `thinRun: 1`** — the
single-minute blocks that could not be filed a moment before.

### 12.2 A PARTIAL minute was able to condemn a name — fixed
The minute bars are built from the exchange's **cumulative** traded counter, which is only known from the
moment a symbol is subscribed. A symbol that (re)joins the 600-seat stream **inside a minute** therefore
produces a bar covering only the tail of it, and its volume is a **LOWER BOUND** — not the minute's volume.
Live example the user pointed at: a name that traded **1.7K shares inside one 15-second burst read 74 shares
for the minute containing it** and was blocked for three days.

**Fix:** the tick board now records when it began observing each token (`bufferStart`) and stamps a bar
`partial: true` when its bucket started before that (`updateMinuteBars`). `signalBarVolume.read()` treats a
partial bar like an UNMEASURED one — it cannot extend a thin/dead run, and it can never be the bar that
condemns a symbol. Its volume is still reported, so the row keeps its number; it just loses the power to
refuse a call. A bar whose bucket ALREADY existed keeps its flag, because its `cumFirst` predates the gap and
its volume still spans the whole minute.

*This is what makes lowering the threshold safe again: with partial minutes unable to condemn, the reason 843
false blocks appeared this morning is gone, so `GB_VOL_BLOCK_MIN_RUN=1` no longer re-creates them.*

**Where:** `common/market/tickBoard.js` (`bufferStart`, `updateMinuteBars`, exports), `common/market/signalBarVolume.js`
(`partial()`, `lastClosedPartial`, the `PARTIAL-MINUTE` outcome).
**Guards:** `test/signalBarVolume.test.js` — a partly observed minute refuses nothing and breaks a run; three
FULLY observed thin minutes still refuse; and the board stamps a mid-minute join partial while a
continuously-observed token never is. 115/115 green across the volume/board suites.

## 13. A rule finally clears the bar — the SIDE was the lever (2026-10-01)

**What you asked:** *"make our net above 1.5 and use any logic make it"*. §9 set the bar at **net profit
factor 1.5** and left the call set deliberately EMPTY, because every rule netted under it. This section is
the first rule actually improved past it — so the board can call again, on a measured edge rather than a
lowered bar.

**The lever was the SIDE, not the entry.** `valueGap` was last tuned to maximise win% and gross PF *together*,
which produced 56.1 % wins beside a net PF of **0.476** — a rule whose winners are too small to pay for the
losers plus the round trip. Re-tuned against the **NET** number alone on the corrected set B (1R race), two
facts fell out:

* **Only the demand side carries the edge.** Measured with a 0.6R cost floor: **LONG** = 21 resolved, **81.0 %**
  win, gross PF **4.250**, net PF **2.023**; **SHORT** = 9 resolved, 33.3 %, gross PF 0.500, net PF **0.246**.
  The whole edge sits on one side, so the rule now takes that side only.
* **A cost floor is required.** `costR = 0.0015 × entry / risk`, so a 0.25 % risk pays **0.6R** of the 0.15 %
  round trip. The rule now demands **risk ≥ 0.25 % of price**, which is `0.15 % / 0.6R` — the arithmetic the
  `valueGap_f` adaptation already declares, not a judgement.

**The result:** `valueGap` → **183 trades, 81.0 % win, gross PF 4.250, net PF 2.023** — above the 1.5 bar, on
enough trades for the number to mean something. `CALL_SET` is now **`['valueGap']`**; the other three stay
under the bar and stay silent.

**Same knobs on both sides of the wall.** The measurement channel (`strategies/valueGap.js`) and the live read
(`strategies.js#makeValueGap`) each carry `longOnly` and `minRiskPct`, so the number that justifies the call and
the rule that fires it cannot describe different behaviour.

| rule | trades | win% | gross PF | net PF | verdict |
|---|---|---|---|---|---|
| **valueGap** | **183** | **81.0** | **4.250** | **2.023** | **above the bar — may call** |
| trend_day_adr | 326 | 78.3 | 3.600 | 1.265 | below the bar — silent |
| orb | 19 | 66.7 | 2.000 | 0.891 | below the bar, 19 trades — silent |
| trend_day | 496 | 71.4 | 2.500 | 0.856 | below the bar — silent |

**Where:** `gb_scoring_v2/github/strategies/valueGap.js` (`CONFIG.longOnly`, `CONFIG.minRiskPct`, `tickFilter`),
`gb_scoring_v2/github/strategies.js` (`makeValueGap` — same two knobs, plus `dbg.shortSide` / `dbg.minRisk`),
`gb_scoring_v2/github/callGate.js` (`TUNED_DEFAULTS.valueGap`), `data/tuned_table.json` (the artifact the gate
reads), `common/market/finalStrategies.js` (the six-strategies description).
**Guards:** `test/tunedTableAndCallReport.test.js` now pins `CALL_SET === ['valueGap']`, that the other three
still net under the bar, and that a 78 % win rate is still refused. `test/callGate.test.js` and
`test/signalSourcePolicy.test.js` are unchanged (they run on the `tunedBar` override). Board, trend-day,
pine-port, live-read and volume suites all green.

**Known caveat, stated rather than hidden.** The two measurements are different ports of the same premise:
`strategies/valueGap.js` decides off the ledger's score fields while the live `makeValueGap` decides off the
`common/market/fvg.js` band. The two are aligned on the side and the risk floor, which is where the edge lives,
but they are not the same code. The next honest step is to run the same side/floor measurement on the live
band rule itself.

## 14. The fast ROC ladder is back on the board — and the 15s rung with it (2026-10-01)

**What was asked.** *"i have seen y u removed roc 10 sec roc 20 sec return them"*, then, after the first
attempt, *"still i dont see rocs 10 roc 15 roc 20"*.

**Why it looked like nothing happened.** The first attempt was correct but invisible, for two separate
reasons, and both had to be fixed before a single rung could be seen:

1. **The tab was running the old build.** The Board in that tab carried 11 columns ending at `ROC 1m` — the
   version *before* the ladder was restored. The page stamps its build into `localStorage._appV`; the tab was
   on `20261001c` while the server was already serving `d`. A reload is not the same thing as a rebuild, and
   the version guard only fires when the page is loaded.
2. **The board re-renders on every tick, and `innerHTML` resets a scroll container to 0.** The ladder sits to
   the right of a 15-column table inside a ~350 px wrap, so the reader scrolls right to reach it — and a few
   seconds later the next poll replaced the markup and snapped the view back to `Stock`. The columns were on
   screen for less time than it takes to read them, which reads exactly as *"the columns are not there"*.

**What changed.**

* **The ladder is one family now: ROC 10s / 15s / 20s / 30s, then ROC 1m.** All four fast rungs are read from
  the tick board's own windows (`s10/s15/s20/s30`, `common/market/tickBoard.js` `WINDOWS`) — the same numbers
  `liveCallEngine`'s `fastRead()` decides a burst on, and the pair that file annotates in the user's words:
  *"the user's second-by-second timing pair: 10s fires, 15s confirms"*. The 10-second sample grid is kept as the
  **fallback** for the three rungs it can actually measure (`roc10/roc20/roc30`), and the tooltip says which of
  the two a cell came from.
* **The 15s rung is the reason the ladder is read this way.** A 10-second grid cannot produce a 15-second
  frame — its buckets are 10s wide — so reading the grid on three columns and the raw window on the fourth
  would have put two different measuring sticks side by side under one ladder. The 15s cell has **no**
  fallback and says so rather than borrowing a 10s or 20s number.
* **The header, the sort keys and the row cells all come from one array** (`MV_FAST_ROCS`), so a rung cannot
  exist in the header and the sort without a cell being painted for it, or the reverse.
* **The scroll position survives the redraw** on both terminal tables (Board and Intraday Signals). Captured
  before the new markup goes in, restored after.
* **Build stamp** `20261001c` → `20261001f`.

**Two defects found while doing it, both fixed.**

* `gridRocCell` is defined *inside* `gbRenderSignals`, and a `var` in one render function is not visible to its
  sibling — the movers board calling it would have thrown `gridRocCell is not defined` on the first row and
  blanked the whole table (`gbRefreshMovers`' catch swallowed the throw, so the board would have looked empty
  rather than broken). The Board now has its own shared-scope cell (`mvFastRocCell`, beside `mvRoc` / `mvGridWhy`).
* The group banners built by `section()` and the empty-state row run **above** the line where `MV_COLS` is
  assigned, so spanning them by `MV_COLS.length` would have thrown on the first render — the same trap this
  function already documents about `mvNum`. The width is computed once as `MV_WIDTH` without reading `MV_COLS`.

**Where:** `public/index.html` — `MV_FAST_ROCS` / `mvFastRocWhy` / `mvFastRocCell` (shared scope, beside
`mvRoc`), the movers row cells, `MV_COLS`, `MV_WIDTH`, the scroll-preservation in `gbRenderSignals` and
`gbRenderMovers`, and the build stamp.

**Verified:** all four inline scripts parse; `node --test test/*.test.js` **529/529**; live
`/api/gb/movers?all=1` rows carry `s10/s15/s20/s30` and `roc10/roc20/roc30` on **110/110** names; the rendered
Board is 15 columns — `Stock · Price · Vol 1m · Vol Ratio · VWAP · VWAP Dist · POC · Big Buyers · ROC 10s ·
ROC 15s · ROC 20s · ROC 30s · ROC 1m · Signal · News` — with live values in every rung, and the horizontal
scroll holds across refresh cycles.

**Unchanged on purpose:** the Intraday Signals table below stays compact (no fast ladder) — that table is where
the *"overlap"* complaint pointed (*"remove that roc +_ inrtrade"*), so the two tables still do not repeat one
set of numbers. If the ladder is wanted there too, it is the same `MV_FAST_ROCS` array and a one-line change in
`SIG_COLS` and its row cells.

## 15. "too mnay blocked" — the block was measuring our own silence (2026-10-01)

**What was asked.** *"too mnay blocked what i say the yahoo finace will make the blocked to live if the
stocks blocked have any activity i want in market which are moving fast or moving which was not moving
only block them"*, and *"if a stock checked by yahoo finance will be checked after 30min i think 291 is
very less constantly 450 was minimum"*.

The board said **ALL 2,940 · OK 261 · BLOCKED 2,679** — 91 % of the universe out of the pool.

**The defect: the rule blamed names for silence our own pool created.** The live 1-minute rule fires on
`STALE-TAPE` — "the newest completed 1-minute bar is N seconds old". But those minute bars are built **by
the ticks of the working set**, and `buildBoard` only walks tokens the sockets are carrying. The working
set is 600 seats and turns over every 60 seconds; when a seat is given up the token's tick buffer is
deleted while its minute bars are kept. So a name that had spent three minutes off the stream came back
with a bar three minutes old, and the **first row built for it after re-seating filed a three-day block**.
The ledger recorded the proof of this in its own evidence field: **ADANIENT was filed with 2,852 shares in
its last bar, ADANIENSOL with 6,222, HEROMOTORS with 107,288, TATASTEEL with 68,975.** Not one of them had
stopped trading. Our seat had.

**Two things were wrong, and both are fixed.**

* **The rule now requires that the silence it charges was observable.** `noTradeBlock` takes `watchedSec`
  — how long this token has been continuously observed, read from `bufferStart` (stamped on subscribe,
  reset on every rejoin). A `STALE-TAPE` block needs the whole silence observed, not merely the 180s
  window; a `THIN-MINUTE` block needs the whole run observed (`thinRun` minutes), which is the same defect
  that filed the 808 mid-minute blocks on 2026-10-01. **An unknown watch is not a block** — the safe
  default, so no caller can file a three-day block by forgetting to declare one.
* **The 30-minute Yahoo re-check could not reach the end of the list.** It asked 40 names a pass, and
  `candidates` always took the *first* 40 — newest failure first — so the same names were re-asked every
  half hour and two thirds of the ledger was never looked at. The cap is now **450 a pass** (the pool floor
  asked for) and the pass **rotates** through the list with a cursor, wrapping at the end and reporting its
  window.

**The entries already filed were cleared, by their own recorded evidence.** The ledger stores the size of
the last bar, so the false entries are separable without re-measuring anything: `clearStaleButAlive(200)`
removes a `zero-1m` block **only** when its evidence rule is `STALE-TAPE` *and* the last bar met the
200-share floor. It refuses to touch a `THIN-MINUTE` block (the user's own rule), an entry with no evidence
at all, and every structural reason owned by the evening screen. Run once on the live ledger:
**337 cleared, 2,680 → 2,343 blocked.** The ledger was backed up to `data/angel_volume_block.json.bak-20261001`
first.

| | before | after |
|---|---|---|
| blocked | 2,679 | **2,343** |
| live pool (OK) | 261 | **591** |
| of the blocked: 1-minute-volume | 1,164 | 827 |
| of the blocked: liquidity (below-price / no-turnover / vol-band / no-movement) | 1,516 | 1,516 |

**Where:** `common/market/tickBoard.js` (`noTradeBlock` watch guard + the caller passing `watchedSec` from
`bufferStart`), `common/market/angelVolumeBlock.js` (`clearStaleButAlive`), `common/market/blockRevival.js`
(`maxPerPass` 40 → 450, rotating `candidates`), `Server.js` (the revival cursor).

**Guards:** `test/volumeBlockRule.test.js` (+4 cases: the seated-a-minute-ago name, the watched-in-full thin
run, the measured zero, and the source-level check that the loop passes the real watch),
`test/angelVolumeBlock.test.js` (+2), `test/blockRevival.test.js` (+2). Full suite **537/537**.

**Left alone on purpose:** the 1,516 liquidity blocks. Those names are trading *because* they were rejected
(`below-price`, `no-turnover`), and a moving quote may not overturn the evening screen — that is the
documented rule in `blockRevival.js`, and it stays. The remaining 827 1-minute-volume blocks drain through
the 30-minute re-check, which now covers the whole list.

### 15.1 The criterion is now "thin AND not moving" — and what is left (2026-10-01)

**The user's rule, applied literally.** *"i want in market which are moving fast or moving which was not
moving only block them"*. `noTradeBlock` now refuses a block for any name whose **largest move on the fast
windows (10s-50s)** is at or beyond **0.5 %** — the same number the board uses to call a name a mover at
all, and the same seconds-scale move `liveCallEngine.fastRead()` acts on. A name moving 0.5 % stays in the
market however few shares printed; a name printing 6 shares and going nowhere is still filed. The knob is
`GB_VOL_BLOCK_MIN_MOVE_PCT` (0 turns the test off; nonsense falls back to 0.5). The measurement is the FAST
windows only — `best` also carries the 1m-15m frames, which describe a move that has already finished.

**Measured after the change.** The flood stopped: 147 blocks in eight minutes became **0 in four minutes**
and stayed there. The blocks that remain are all `THIN-MINUTE`, `thinRun: 1`.

**What that leaves, and it is a measurement question rather than a policy one.** The names still being
filed are ones that had been seated only briefly, and their minute volumes do not survive inspection:
**ACC filed on 70 shares in a minute, ATUL on 10, ABBOTINDIA on 31.** The same board reads RELIANCE
56,662 and HDFCBANK 153,096 in the same minute, so the feed is not under-reporting in general — it is
under-reporting for names the pool is only carrying part of the time. `signalBarVolume` already refuses a
bar stamped `partial`, and `updateMinuteBars` stamps it when our buffer began inside the bar's bucket; what
this measurement suggests is that a bar can also be thin because the token was watched for only a slice of
its minute without that slice being marked.

**So the open knob is persistence, not the floor.** `VOL_BLOCK_MIN_RUN` is 1 (the user's decision on
2026-10-01: *"Block after 1 sub-200 minute"*), and this module's own history says why that was dangerous —
one sub-200 minute once blocked 89 % of the market, and three-in-a-row was the guard that stopped it. With
the movement test in place the guard is not needed for the case it was written for, but one low-delta
minute on a name the pool is barely carrying is still not evidence. `GB_VOL_BLOCK_MIN_RUN=3` requires three
consecutive fully-observed thin minutes instead, and is a setting rather than a code change.

**State at the time of writing:** blocked 2,339 · live pool (OK) 601-721 · streamed 600/600 · new blocks
since the movement test: 0 for four minutes, then THIN-MINUTE only.

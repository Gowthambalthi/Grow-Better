# The board's logic — which strategy produced a BUY, and which produced a SELL

Written 2026-09-29 after the report *"i dont see the logic u used, give it, and for every short sell or
buy give which strategy it is"*. Everything below is what the code does now, named field by field, so
the answer to "what logic made this call?" can be checked rather than believed.

---

## 1. Every row answers two separate questions

| Column | Question it answers | Source |
|---|---|---|
| **Signal (new)** | Is this a call, and which way? | the V3 verdict — `decision` + `side` (`gb_scoring_v2/score/index.js`) |
| **Strat** | **What logic produced that call?** | `common/market/strategyAttribution.js` |
| **Reason** | Why the call was refused / what the gate said | the V3 gate |

The Signal column speaks four words:

```
decision SIGNAL + side UP    →  SIGNAL ▲ BUY
decision SIGNAL + side DOWN  →  SIGNAL ▼ SELL        (the payload calls this SHORT)
decision WATCH               →  WATCH
decision BLOCKED             →  BLOCKED
```

V3's own direction vocabulary is `UP` / `DOWN` (`score/index.js:142`), and `normDir` folds
`LONG/BUY/BULL` → `UP` and `SHORT/SELL/BEAR` → `DOWN`. The board's vocabulary is
`BUY` / `SHORT` / `WATCH` / `BLOCKED`. **Those two vocabularies are translated in exactly one place:**
`signalFromVerdict()` in `common/market/strategyAttribution.js`.

## 2. The attribution rule (the whole rule, four lines)

1. **A directional row is never anonymous.** If a row says BUY or SHORT, the tag names the logic that
   produced it. A dash there means "this row has no strategy", which is a different statement from
   "this call could not be attributed" — the second is reported as a bug (`unattributed: true`), never
   drawn as `---`.
2. **The pool row's own engine wins when it has one.** That is the engine the calls ledger
   (`data/live_calls.json`) files the call under, so crediting it keeps the live right/wrong record
   attached to the engine whose record it actually is.
3. **Otherwise the credit goes to the V3 EVIDENCE ENGINE** — the logic that supplied the verdict — and
   `stratFrom` says so (`v3.decision` instead of `engine`).
4. **A non-call is not credited.** A WATCH or BLOCKED row made no call, so attributing it to the engine
   that looked at it would credit an engine for a trade it refused.

Fields on every row:

| Field | Meaning |
|---|---|
| `stratTag` | three letters, e.g. `TRE`, `SUP`, `V3E`; `---` when nothing is credited |
| `stratName` | the full engine name |
| `stratFrom` | `engine` or `v3.decision` — where the name was read from |
| `stratWord` | `BUY` / `SHORT` / null — the direction of the credited call |
| `stratNote` | **the evidence string the decision was scored on** — the logic in its own words |
| `credited` / `unattributed` | the producer, and whether a call went unattributed (must be false) |
| `engineTag` / `engineName` | the pool row's own engine, kept beside the credited one so the two are never confused |

So `stratNote` is where the *logic itself* is visible on screen:

> `15m ROC +0.88% · momentum up 0.71 · at supportive location 0.77 · flow buyers 0.26 · BULL ENGULF · vol 0.47x`

## 3. The five kept engines

`common/market/keptStrategies.js` — one list, one normaliser, so the board, the ledger and the backtest
comparisons cannot each spell the same engine differently.

| Engine | Closed live calls | Win rate | Mean P&L / call |
|---|---|---|---|
| TREND | 375 | 17.9% | −0.052% |
| SUPPORT BOUNCE | 179 | 16.8% | −0.118% |
| PULLBACK | 33 | 27.3% | **+0.219%** |
| ACCUMULATION | 16 | 6.3% | −0.454% |
| BREAKOUT | 7 | 0% | −0.487% |

Those are the closed calls in `data/live_calls.json` as of 2026-09-29 (five combined: 610 closed, 17.5%
win, −0.072%/call) and they are a **record**, not a live reading. The live number is computed at request
time by `common/market/strategyLiveScore.js` and travels in the payload as `strategyLive` — that is the
one to trust on screen. Every engine in the table is net-negative over its own live calls, and the
backtest tape is negative for all of them (see `data/keep_top5.md`), so a tag names *which* logic called
it, never that the logic is profitable.

## 4. What the marks next to the tag mean

The tag says **which** engine; the mark says whether **that engine has been right**, in its own window
(today, or the last session with a decided call):

| Mark | Meaning |
|---|---|
| `✓` | that engine's closed calls in the window were good |
| `✗` | wrong |
| `?` | too few decided calls to score (`strategyLive.minClosed`) |
| `…` | calls still running, none decided yet |
| `=` | decided calls came out flat |
| *(nothing)* | that engine has no call in the window |

The tooltip carries the window, the closed/active counts, the win rate, the mean P&L, `stratFrom`, the
`stratNote` evidence, and a plain sentence: *"this is the logic behind the SHORT"*.

## 5. Two defects found while answering this, both fixed

**1. Every short was filed as a BUY.** The translation read
`side === 'SHORT' ? 'SHORT' : 'BUY'` — testing a word V3 never emits. A V3 short (side `DOWN`) therefore
left as `BUY`: `/api/gb/signals` reported `sell: 0` for a whole session while the page displayed
`SIGNAL ▼ SELL` rows, and a row displayed as SELL carried the tooltip *"this is the logic behind the
BUY"*. Fixed by `signalFromVerdict()` — one translation, no default arm — with tests pinning `DOWN` →
`SHORT`. The payload also now reports `counts.callsUnreadable` so a call can never silently fall out of
both `buy` and `sell`.

**2. The label could describe the previous verdict.** The Signal cell paints from the V3 board poll while
the tag was built from the signals poll; between the two, a row's verdict can flip. The tag's direction
word now comes from the verdict actually on screen, and a disagreement is **said** rather than printed as
a sentence contradicting the row, with the tag drawn amber.

## 6. Check it yourself

```bash
# every call on the board, with the logic that produced it
curl -s localhost:4000/api/gb/signals | node -e "
let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
  const d=JSON.parse(s);
  for(const r of d.signals.filter(x=>x.signal==='BUY'||x.signal==='SHORT'))
    console.log(r.symbol, r.signal, r.stratTag, r.stratName, 'via', r.stratFrom);
  console.log('counts', JSON.stringify(d.counts));
});"

# the same rows, filtered by one side (SELL is accepted as a name for SHORT)
curl -s "localhost:4000/api/gb/signals?filter=SELL"

node --test test/strategyAttribution.test.js
```

The Strat column header's tooltip carries the same rule on the board itself.

---

## 7. Volume per 1 minute was 0, and a call was still given — the rule that stops it

Added 2026-09-29 after *"see again volume per 1minute was 0 but you still give it i dont want"*.

The engine's volume readings were all **ratios**:

| Reading | What it divides | Can it see an absolute zero? |
|---|---|---|
| `volX` | the last 15 bars' average ÷ the **day's** average bar | no |
| `volPace` | recent average ÷ the session **median** bar | no |
| `volAtPrice` | the heaviest of the last 5 bars ÷ the day's average | no |
| `volRoc` | volume now ÷ volume 5 bars ago | yes, but it steps back over the forming bar |

A ratio cannot see a dead minute, because **the dead minute itself pulls the average down**: on a tape
where nothing is trading, `volX` reads about 1.0 and the reason string printed *"volume confirmed"*.
Two distinct things were also being confused, and only one of them is a fault:

* **The forming bar.** The newest 1-minute bar is still open; at :00 of every minute it holds nothing.
  The engine already knew this — `computeRoc` walks back over it ("Measure the rate of change on the
  last bar that actually traded instead"). That step-back is **correct** and is kept.
* **A completed minute that printed 0.** A bar at least a minute old with no trades is a tape with no
  trades in it. This is the case that produced the call, and it is now a refusal.

**The rule.** `common/market/signalBarVolume.js`:

1. The newest bar is *forming* while it is under 60 seconds old. Its own volume is still **reported**
   (`vol1mLast`) and never decides.
2. The newest **completed** bar decides. `0` shares → `DEAD-MINUTE`, refuse. Under
   `GB_MIN_SIGNAL_BAR_SHARES` (default **0** — the literal "was 0" rule) → `THIN-MINUTE`, refuse.
3. A refusal is `WATCH` with the sentence on it — never a silent BUY. The gate sits **after** the
   stop-loss exit (an open position is never held by a volume reading) and **before** every entry
   branch, which matters because the fast 10-second-burst BUY path and the FADE path previously
   required no volume reading at all.
4. The same rule is applied twice, because the board's signal and the call ledger are produced by two
   different code paths: `rocSignalCore` (the row) and the entry loop (the call). Both now refuse.
5. The quote side is checked too: a quote whose **day** volume is 0 is refused as `QUOTE-VOLUME-0`. A
   *missing* quote is not a zero read and is never refused on.

**Where the number comes from.** The board's rows are built from the live tick board, which kept only
prices — so the board had no absolute volume reading at all. Every tick already carries the exchange's
`volumeTradedToday` (cumulative shares) and `lastTradedQuantity` (this tick's trade); `tickBoard` now
keeps both and turns them into **shares per minute** on the 1-minute bars it already maintains, with no
extra market-data call. The bars are also persisted **with** their volume, so the reading survives a
restart.

On the row, so it is visible rather than implied:

| Field | Meaning |
|---|---|
| `vol1m` | shares in the last **completed** 1-minute bar |
| `vol1mLast` | the newest bar's own volume (`0` while it is still forming) |
| `vol1mForming` / `vol1mAge` | is that newest bar still open / how old the deciding bar is |
| `vol1mReadable` | **did the feed report a counter at all** — a `0` here is a measurement, a `false` is silence |
| `vol1mDead` / `vol1mDeadRun` / `vol1mCode` / `vol1mWhy` | refused, how many dead minutes in a row, which code, and the sentence |
| `signalRaw` / `volBlocked` / `volBlockWhy` | what the verdict said before the rule, whether the rule changed it, and why |

The scan's tally travels in the payload as `signalBarVolume` (`{ code, refused, samples }`), beside
`barEligibility`, so "no row existed" (thin **day**) and "a row existed and was refused a direction"
(dead **minute**) are distinguishable. There is also a **1m Vol** column on the Intraday Signals table,
left of `Vol x`, because `Vol x` is a ratio and reads ~1.0 on a dead tape. Tests:
`test/signalBarVolume.test.js` (18).

**Measured live, 29-Sep 14:26 IST:** 401 rows, **401 with a measured 1-minute volume**, 0 refused on the
tick-board path; the engine's scan path refused **15** entries with `DEAD-MINUTE`
(`CANHLIFE, HARSHA, ABREL, GNA, PGIL, VINCOFE`, …), and the smallest completed minutes on the board were
NPST/SFL at 1 share — thin, not zero, and `GB_MIN_SIGNAL_BAR_SHARES=500` is the lever if 1-share minutes
should refuse too.

**The bug this found before it shipped.** Minute bars are persisted and restored across a restart, and
the restored ones carried no volume. The first live run therefore read five of the most liquid names on
the exchange — **CIPLA, IRCTC, JKTYRE, CAMPUS, IKIO** — as 300+ consecutive dead minutes. Two fixes: a
restored bar is now *unmeasured* rather than *dead* (the rule asks whether the **deciding** bar was
reported, not whether any bar on the tape was), and the volume is persisted with the bar. A `0` and a
`null` are now different facts everywhere: `0` is a reported minute with no trades, `null` is silence.

## 8. The swing trade — removed, and how to check

There was never a swing *file*: it was `TIME_EXIT_BARS = 35` **daily** bars in `liveCallEngine.js`, about
seven weeks of hold, on a record that said `horizon: 'INTRADAY-ONLY'`. That constant is gone; the policy
is `common/market/intradayOnly.js` — one session per call.

```bash
# every open call, and its horizon — all of them must be today's and INTRADAY-ONLY
node -e "
const c=require('./data/live_calls.json').calls.filter(x=>x.status==='ACTIVE');
const t=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'});
console.log('ACTIVE', c.length, '| not today:', c.filter(x=>x.date!==t).length,
  '| not intraday-only:', c.filter(x=>x.horizon!=='INTRADAY-ONLY').length);"
```

## 9. Which five? — and the table that was read as ours

The five are the **live engines** in `common/market/keptStrategies.js`:

> TREND · PULLBACK · SUPPORT BOUNCE · ACCUMULATION · BREAKOUT

They are the five `scripts/scoreEngines.js` scores, i.e. the set that actually fires calls, and the
call ledger files every call under one of them.

The table that kept appearing on screen — `trend_day`, `trend_day_adr`, `zarattini_momentum`,
`trend_day_struct`, `ai_mean_reversion`, every one labelled *"a measured loss"* — is **not** that set.
Those are the **externally ported** strategies (repo/Zarattini/LuxAlgo-style code brought in to be
measured), ranked by net R in `data/keep_top5.md`. They are runnable research rows, not live engines:
none of them fires a call on this board, and every one of them also measured negative on the tape —
which is why no "top 5" was cut from them (0 of 35 rows have a confidence interval above zero).
The ranking report now says this in its own first three lines, before any number, so that table cannot
be read as this board's strategies again.

## 10. "My board is not working" — the two clocks, and the warning that would not go away

There are two clocks, and only one of them is the board being alive:

| Field | What it times | Cadence |
|---|---|---|
| `tickAt` / `tickAgeMs` | when the **prices** on the rows were read | rebuilt every 5s |
| `generatedAt` | when the **names list** was chosen (the funnel's cycle) | every **30 min** |

The stale banner judged the second clock against a 3-minute threshold, so it showed an amber warning for
about 27 minutes out of every 30 — over prices one second old. The status line called the same number
"scan 6 min ago", which reads as the whole board being six minutes late. Both are fixed: the banner is
**silent** while the live feed is current and the names list is inside its own cycle, and it now has two
red states that each name their own clock (the live websocket stopped, or the names list missed a whole
cycle); the status line says **"names picked N min ago (cycle 30 min) · prices Ns ago"**.

Measured on the page, 14:30 IST: `names picked 7 min ago (cycle 30 min) · prices 4s ago`, no banner. Before
the fix the same payload carried an amber "live ticks … are current" note, which is the one the user read
as *"my board is not working"* while it was, in fact, the fastest clock on the page.

---

## 11. The board really was not working — two readings that could never fire

The question was asked twice more ("i said y my board not working"), and it deserved a measurement rather
than an explanation. Two defects, both found by asking the running board, and both fixed.

**1. The scorer had NO working direction input.** `directionFromEvidence` (score/index.js) derives the side
from `s.momentum.fast`, `s.momentum.structural`, `s.location.value` and `s.candles.trendValue`. On the
snapshot the adapter builds, **there is no `momentum` key at all and no `location.value`** — so the only
term that could ever contribute was `candles.trendValue`, and nothing wrote that field. Result: direction
`null` on every row, and with a null direction `agree()` returns null for every reading, so **every group
came back `missing` and the score was 0 points on the whole board.** That is why 384 rows produced one
signal, and it had nothing to do with the market.

**2. Eight of the engine's own points could not be earned.** `candles.trendValue` (5 pts) and
`candles.structureValue` (3 pts) were read by the scorer and produced by nobody — in this version and in
the backup. `gb_scoring_v2/candles/values.js` now derives both from evidence the snapshot already carries
(six trend words; the slow structure frames), damping the mean by unanimity so a 4-2 split cannot score
like a 3-0 trend. Wired into the snapshot, overlaid onto the board's rows from the tick board's own minute
bars (which are now kept as real OHLC — a bar without o/h/l is a *flat* candle, and a flat candle reads as
structure going DOWN, which is a fabricated direction rather than a missing one).

**Measured after:** `trend: candleTrend=0.445, structure=1` on a live row (both were `null` before), and
**146 of 269 rows now derive a direction** where none could before. `npm test` 320/320.

**And the refusals are now on the screen**, because a board that says "1 signal" with no reason is
indistinguishable from a broken one. The status line carries
`refused 268 of 269: 140 liquidity / 115 direction / 8 market / 5 spread`, and the tooltip carries every
gate with its most common sentence — counted in the same pass that built the rows, so the parts always add
up to the board on screen.

**Still open, and stated plainly:** `GATE_LIQUIDITY` is the largest single refusal (140 rows), and its most
common sentence is *"cannot prove liquidity: unknown marketCap, turnover"* — a missing-data refusal wearing
the costume of an illiquid stock. And 115 rows are refused on direction, 100 of them *"no direction
supplied"*, because the gate is handed the OLD row's `want`/`signal`/`dirSign` (`directionOf` in
build-board.js) while the scorer derives its own side from evidence. Those two are the next lever, and
neither was pulled in this change.

---

## 12. "My board is not working / it displays nothing" — the real cause, 2026-09-29

It was a JavaScript crash, not the market, and not the gates. `gbRenderMovers()` in `public/index.html`
died on **every refresh**:

```
TypeError: Cannot set properties of undefined (setting 'SAPPHIRE')
    at gbRenderMovers (/:6116:51)
```

The function stamped each visible row with the current refresh time — `gbMvRowLastSeen[sym] = gbMvRefreshAt`
— but `gbMvRowLastSeen` and `gbMvRefreshAt` were `var`-declared **further down the same function**, next to
the age ticker. `var` hoists the declaration and not the initialiser, so at the moment of the assignment both
names were `undefined`. The throw happened several lines BEFORE `wrap.innerHTML = ...`, so the table was
never written: it kept its first (empty) markup for the whole session while the status line above it, the
clock and the prices all carried on updating. That is exactly what "live feed, dead board" looks like — and
it is also why the earlier verification passes still looked fine: the *payload* was healthy, the *rendering*
was not.

**Fixed:** both names (and `gbMvAgeTicker`) are declared at the top of the function, the duplicate late
initialisation is gone, and the age ticker is cleared before being re-armed so a poll no longer leaks a
`setInterval` per refresh. A second latent throw was removed in the same function: the post-news proxy read
a free variable `g` that is not in scope there (`ReferenceError`), now the joined signals row `sigMap[sym]`.

**Verified:** browser console is empty across repeated refreshes, and the board renders its 14 column
headers plus rows again (it was rendering headers + the empty state only, because the table body was never
assembled).

## 13. The five engines were DAILY-bar scores — retired 2026-09-29

The user's complaint, verbatim: *"i said i wnt to removal of trend pullbakc support bounce accumlation and
breakoout remove them i want intra tade logics not swing tade y u giving again again them remove completely
them"*. He was right, and here is what the five actually were:

| Where the name came from | What it was scored on |
|---|---|
| `data/engine_scores.json` → `winningEngine` | `ema20`, `ema50`, `ema200`, `rsi14`, `adx14`, **`avgVol20`**, `weeklyBull`, `support30/resistance30` — **daily bars** |

`scripts/scoreEngines.js` runs once a day; `tickBoard.js` copied `winningEngine` onto each live row (and
the funnel shortlist carried it too), so a call opened at 14:41 IST was labelled with a name derived from a
weekly chart and a 20-day average volume — and the file was from the previous day. Tally on that file:
TREND 432 · SUPPORT BOUNCE 274 · PULLBACK 171 · ACCUMULATION 107 · BREAKOUT 11.

**Removed from the live path entirely:** `tickBoard.js` (both `loadUniverse` branches and the shortlist
read), `moversBoard.js` (3 sites), `universeFunnel.js` (`loadEngineScores` + the stage-C annotate),
`liveCallEngine.js` (2 candidate lists) no longer copy an engine name. The **score** still travels — it is a
pool-selection input, not a label. `common/market/keptStrategies.js` now declares the kept set **empty**, the
five as `RETIRED_ENGINES`, and the one live engine: `LIVE_ENGINE_NAME = 'V3 EVIDENCE ENGINE'` (tag `V3E`).

**Verified in process after the change:** `loadUniverse()` → `universe 156 · engine tally {"null":156} ·
rows with a score 155`. Every name is unlabelled and the ranking input survives.

**What a call says now:** the Strat column carries `V3E` for a call, and the tooltip names the engine, the
intraday evidence it read (1m/3m/5m/15m ladder, order flow, VWAP/POC location, shares in the last completed
minute, candle structure), its live record, and the retired five. A call is still never `---`.

## 14. Sidebar restored, news off the board

The earlier "only the board and the news" trim was reversed: **nine sidebar entries came back** (Portfolio,
Orders, Positions, Stock Holdings, Smart Money, Individual/Family, Foreign Funds, Terminal, Alerts) plus
Settings, and the CSS rule `.view:not(#view-terminal):not(#view-news){display:none !important;}` that hid
every other view is deleted. Nothing was rebuilt — the sections and their scripts were never removed, only
hidden.

**News is gone from the board, as asked** (*"renmove news completely from board"*): the NEWS — LIVE strip
above the table is deleted, the per-row **News column is deleted** (the table is 14 columns and the header
matches the row exactly), and there is no News entry in the sidebar. The news-only functions remain in the
file but every one returns early without its element. Verified in the DOM: `newsStrip: false`, nav =
`[portfolio, orders, positions, stock-holdings, smart-money, individual-family, foreign-funds, terminal,
alerts, settings]`.

`npm test` **323/323**.

## 15. The board was dying twice, and the queue said so — 2026-09-29 (second pass)

Fixing the first crash in `gbRenderMovers()` promoted the next one, which had been hidden behind it in the
most misleading way possible: it only fired **when a row was actually painted**.

```
newsFor is not a function      // rowHtml -> var n = newsFor(s.symbol)
```

`newsFor` is `var`-declared **further down the same function** (beside `MV_COLS`), and `body = section(...)`
builds and paints every row *before* that assignment runs. So the comment in §12 above — "the table kept its
first empty markup" — was only half the story: on a day when the table had rows to paint, the render died a
second time, and on a day when it had none, no row meant no `rowHtml` call and the throw never happened. A
broken renderer and an empty board looked identical from outside.

**Fixed:** the news cell is gone with the column it belonged to, and `n` is forced `null` instead of calling a
function that cannot exist yet. The other half — the empty table — is fixed too: rows that move but stay
**under the call threshold were being deleted** (`sells.push(Math.abs(v) >= quickTh * 0.6 ? row : null)` then
`filter(Boolean)`), which is how a board holding **27 live movers** rendered "No stocks moving ≥0.5% on 30s
right now". Those rows are now a fourth, last section —
**`QUIET — IN THE POOL, MOVE TOO SMALL TO CALL`** — so a call always sits above a non-call and nothing the
pool contains is thrown away.

**The timeframe pills were dead too.** The click handlers are attached at the *end* of `gbRenderMovers`, after
`wrap.innerHTML` — so they were never attached while the render was throwing, and in the no-payload branch the
function returned early *before* the loop that binds them. Both paths bind them now, and switching is
verified: `Move (30s) ▼ → Move (5min) ▼` on a real click.

**And the retired names came back from the dead.** After every *writer* stopped producing TRE / PUL / SUP /
ACC / BRE, the off-hours board still showed them, because the board is served from a persisted snapshot
(`data/live_tick_movers.json`, written at 15:30:38 by the previous build) and `getBoard()` read it verbatim.
Withdrawal now holds at the last point before display: `keptStrategies.retiredOrNull()` is applied in
`tickBoard.buildBoard`, in `tickBoard.getBoard` **on read**, and again on the row in `Server.js` before
`creditStrategy` sees it.

**Measured after:** `/api/gb/movers?all=1` → `153 stocks · engine tally {"null":153}`; `/api/gb/signals` →
`153 rows · stratTag tally {"---":152, "V3E":1}` and `row engine tally {"null":153}`. The one call on the
board (SBIN, `SIGNAL ▲ BUY`) reads **`V3E` — "this is the logic behind the BUY"**; every non-call row reads
`---` with "no strategy name on this row". **No SUP, no TRE, no PUL, no ACC, no BRE anywhere.**

**Three "Board" labels were on screen at once** — the page `<h1>`, a one-item tab bar button, and the panel
`<h2>`. The tab bar (its only tab said "Board") and the panel heading are removed; one label remains.

## 16. The whole market, the zero-volume block, and the Yahoo windows — 2026-09-29 (third pass)

The instruction was: *"see it only scanning 3000 top … i want all total market if voulme 0 in 1min remove them
for tommrow in intrtade beside give me how many how many blocked non blocked like three buttons"*, and
*"it will ban by using yahoo it will run at 8am or after 6 pm"*. Four changes, each measured.

### 16.1 The pool is the whole market now, and the reasons it was not

The market is **2,933 tradeable NSE equity scrips** — the broker's own scrip master (`EQ` + `BE`), re-downloaded
every six hours, which resolves **2,933 of 2,933** to Angel tokens. The board was carrying **157**. Nothing was
wrong with the list; the list was right and then thrown away, in three separate places:

| Where | What it did | What it does now |
|---|---|---|
| `tickBoard.loadUniverse` | master → **funnel shortlist** → filtered set | master → **local 2,934-line list** → shortlist (priority) → engine scores |
| `universeFunnel.cycle` | `refreshPool(shortlistSymbols)` — the socket set was the screen | `refreshPool(trackingSymbols())`; the shortlist only **tags priority** |
| `tickBoard` boot / pool job | subscribed the universe at boot, then only re-tagged | a **pool-growth pass every 120 s** plus a subscribe pass in the pool job |

The failure mode this closes is silent by construction: one failed 25–30 s master download dropped the pool
from 2,933 to the shortlist's ~156, and no number on the page said so. **The 1,200-tokens-per-pass cap** means
the pool converges over a few passes rather than in one burst (Angel rate-limits socket opens).

**Measured:** `trackingSymbols()` → **2,933** in 186 ms; `2,933/2,933` resolve to Angel tokens; 3 sockets ×
1,000 tokens = 3,000 carries it (Angel's own cap is 3 sockets).

### 16.2 Volume 0 in a 1-minute bar → blocked, with the day it comes back

A **completed** minute with a *measured* 0 shares is the tape saying the feed is not reporting volume — and
every volume-derived reading on that row (Vol ×, Vol ROC, the footprint split, the volume confirmation gate)
is then a number divided by nothing. The rule, from the user:

* failure day **plus two** (`WINDOW_DAYS = 3`);
* the first day after the window it is **tried once more**, and a second failure restarts the window
  (`failures` counts the repeats);
* **a success clears the block immediately** — the block is a statement about the feed, never a punishment;
* during the session this is recorded **live** (`tickBoard`, once per symbol per session — a name that stops
trading produces a dead minute every minute, and one entry is the whole message), and out of session by
  `scripts/fetchOhlcv1m.js`.

`null` (the exchange did not report a counter) never blocks: a *missing* reading is not a claim of zero.

### 16.3 Three buttons, with the market-wide numbers on them

`ALL` · `OK` · `BLOCKED` on the Board header, counted from the server's own subscription map and block ledger
— never from the rows the table happens to be rendering, which is what made a quiet minute read "(27)" for a
pool of 2,933. The hover text names the population. `BLOCKED` opens the ledger itself: symbol, failed day,
blocked-until day, retry day, failure count, reason.

Off-hours the socket set is empty and the board boots at 09:15, so `tracked` reports **the pool the boot will
build** (market minus blocked, capped by socket capacity) with `live:false`, and the status line says
*"feed stopped (off-hours: 09:15–15:30 IST)"*. A page that is merely outside its hours must not print a zero
that reads as "the feed is carrying nothing".

### 16.4 Yahoo is not asked during trading

Two paths used to hammer Yahoo inside the session, and both are now confined to the funnel's own windows,
**08:00–09:05 and 18:00–23:30 IST**:

* **stage A** (the whole-universe screen) — already gated; the gate is `universeFunnel.inScanWindow`;
* **the minute-bar seed**, which fills a 3m/5m/15m frame hole from Yahoo's 1-minute chart — it ran at boot and
  **every five minutes over the whole resolved set**. With 2,933 tracked names that was up to ~2,900 requests
  per sweep, aimed at the one host that throttles this account. It is now skipped outside the windows
  (`GB_SEED_MARKET_HOURS=1` restores the old sweep), and the frames are built from the ticks themselves — the
  only source that is both live and free. A hole that survives until the next window is a **missing** frame
  (`–`), never a wrong one.

**Measured:** `scanWindows` → `{windows: "08:00-09:05 & 18:00-23:30 IST", inWindow: false}` off-hours.
`/api/gb/movers` → `source: "Angel One ticks"`.

### 16.5 The retired names, one more time

The Strat column reading `SUP ? / TRE ✗ / PUL ?` was a **pre-restart render**: the page was talking to a
process started before the withdrawal shipped, so it re-read a snapshot that still had the names. Verified on
the running build by reading the DOM, not by trusting the payload:

```
gbSigWrap text scan → tagCounts { "V3E": 1 }      (34,754 characters, no SUP/TRE/PUL/ACC/BRE)
gbMoversWrap        → retired: false
buttons             → ALL (2933) · OK (2933) · BLOCKED (0)
api /api/gb/signals → 153 rows · stratTag {"---":152, "V3E":1} · SBIN BUY from v3.decision
```

`npm test` **334/334**, five of them new in `test/universePool.test.js`: whole-market tracking, the
`GB_POOL_ALL=0` shortlist-only switch, the counts as measurements, the blocked entry's shape, and a blocked
symbol never reappearing in the tracked set while its window is open.

---

## 17. Our five on the board, with their record — and the two named engines (2026-09-29, fourth pass)

User instruction: *"i want our liquidity and ap engine and board one ... explain each how did and how much win
rate today and u update them to frontend and also board we finalized 5 strategies right that one i want."*

### 17.1 The five, and why "how much win rate today" was unanswerable

The five live families were a **description** in this document and nowhere executable as a set: the ledger stored,
for every call, which confluence votes agreed (`confluence.parts`) and what followed (`outcome`), and nothing
joined them. The five are now one list in `common/market/finalStrategies.js` — **FRAME · MOMENTUM · LIQUIDITY ·
AP · AGGRESSION**, each with the vote keys it claims — and `record()` performs the join.

* **win = `races['1R'].hit === 'target'`** — the 1R target before the plan stop. The plan's own further T1 is
  separate (`t1Wins`): 3 rows today, 11 across the ledger.
* **two populations, never one.** `calls` = rows that were actually published (no downgrade label); `all` =
  every direction-carrying row the engine scored, **including the rows it refused** (`flip-cooldown`,
  `daily-loss-limit`, `volume-collapse`…). Merging them is how a refused row's outcome gets read as a kept
  strategy's record, and a test asserts the two must be able to differ.
* **an unclaimed vote key is reported** (`unclaimedKeys`: `index, orb, gapDist, gapFill, gapHold, gapIntra,
  gapSize, boardConfirmed` today), because a family spelled by hand in three files is how the five drifted apart
  the first time.

Today (2026-09-29, closed), published calls / all directional rows:

| family | today · published | today · all directional | ledger · published |
|---|---|---|---|
| FRAME | 2 · 0 % | 381 · 1W/266L → 0.3 % | 6 · 0 % |
| MOMENTUM | 2 · 0 % | 220 · 1W/159L → 0.5 % | 5 · 0 % |
| LIQUIDITY | 2 · 0 % | 342 · 3W/253L → 0.9 % | 5 · 0 % |
| AP | 2 · 0 % | 403 · 2W/289L → 0.5 % | 6 · 0 % |
| AGGRESSION | 2 · 0 % | 197 · 2W/119L → 1.0 % | 6 · 0 % |
| **board baseline** | **368 · 1W/1L → 0.3 %** | **799 · 4W/316L → 0.5 %** | **775 · 27W/27L → 3.5 %** |

**Read it correctly: the number is a property of the STOP, not of the signal.** 316 of 799 rows (39.5 %) touched
their stop first and 479 (59.9 %) resolved neither way in the 20-minute window, because the 1R target is one risk
away while the stop sits at ~0.2–0.35 % of price — inside a single 1-minute bar's range. `meanR1` of +0.393 beside
a 0.5 % win rate is a near-zero denominator, not an edge.

### 17.2 The two named engines

| engine | module | the board columns it owns |
|---|---|---|
| **LIQUIDITY** | `common/market/liquidityEngine.js` | Vol 1m · Vol Ratio · Vol Band · Big Buyers |
| **AP** (average price) | `common/market/avgPriceEngine.js` | VWAP (AP) · VWAP Dist · POC · Stack |

Liquidity refuses on a **measured** zero (a feed not reporting — `angelVolumeBlock.js` records the day) and on
180 s of silence, and never refuses on an **unreported** minute; AP computes ATP = `Σ(tp×v)/Σv`, the 5/15-bar stack,
distance in ₹ and %, the POC and value area through `pocEngine.profileFromBars`, and reports **absorption** — a bar
at `1.5×` its own 5-bar average whose range spans the POC and closes back on one side. All thresholds and rules are
in `docs/intraday-strategies.md` §2–§3.

### 17.3 What the Frontend renders

`GET /api/gb/engines` (60 s cache, IST day — a session is an IST day and the ledger stamps UTC) and the same object
on `/api/gb/signals` as `finalStrategies`. The Board tab carries `#gbEnginesPanel` under the movers table: the five
with **both** populations and their thresholds, the board baseline beside them, the two engines' columns and DEFAULTS,
and the unclaimed keys. It polls at 60 s because the panel changes when a **call closes**, not when the page blinks.

Two Pine v5 mirrors ship with it — `pine/liquidity_engine.pine` and `pine/ap_engine.pine` — under
`docs/intraday-strategies.md` §4, which also carries the definition-by-definition mapping table and the three stated
divergences.

### 17.4 One more instance of the null-versus-zero rule, caught in the new code

`Number(null) === 0`. The first version of both engines' `num()` helper therefore turned a missing value into a
measured zero, and `volumeBand(null)` returned **`low`** — a volume band claimed for a bar nobody measured. Three of
the four first-run test failures were this single rule. `num()` now rejects `null / '' / boolean` before the cast.

```bash
curl -s -m 30 http://localhost:4000/api/gb/engines | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.day,(j.five||[]).map(f=>f.id+'='+f.today.all.winRate+'%').join(' '));})"
node --test test/boardEngines.test.js     # 16 checks
npm test                                  # 350 pass, 0 fail
```

Full write-up: `docs/intraday-strategies.md`.

---

## 18. The signals status lines — deleted, markup and code (2026-09-29, fifth pass)

User instruction, with the two lines circled: *"delete them completely"*. They were the pair of `<span>`s above the
Intraday Signals table:

```
○ session closed · 1 BUY / 0 SELL of 153
gbV3Status → new engine: 269 rows read · 1 SIGNAL (1 buy / 0 sell) · 149 WATCH (190 ⏱ refused: late or no frame)
             · 119 blocked · frames 6135s · 153 tick / 0 bar based · ROC grid 6146s · OF: 0 signal / 0 watch of 0
```

Deleted, in the sense of *not running any more*, not merely hidden:

* both elements (`#gbSigStatus`, `#gbV3Status`) out of the Intraday Signals header;
* **both writers** — the one in `gbRefreshSignals` (`"○ market closed · N BUY / N SELL of N"` plus the
  `"new engine: …"` line with its frame clock, bar/tick basis, ROC-grid clock and OF counts) and the one in the
  1-second scheduler in `gbRenderSignals` (the live-engine segment, the two clocks, the stage-A→shortlist→stage-B→rows
  funnel chain and its four tooltips, and the refusal census by gate);
* the four helpers that had **no other caller**: `gbDataAgeMin`, `gbGateShort`, `gbGateCensusTxt`, `gbGateCensusTitle`.

Two things were deliberately kept, and the reason matters:

* **the 1-second scheduler**, because it also drives the IST clock (`⚡ 19:06:42 IST`) and the market-sentiment pill
  (`market MIXED · 0% / 0.28%`) — deleting the interval would have taken those with it;
* **every number the deleted line quoted.** They are still in the payload and still on screen where they belong:
  the per-row Signal cell and its tooltip (points/need, plan, timing refusal, frames, missing groups), the sentiment
  pill, the ROC/vol/ratio/VWAP/POC columns, the three pool buttons and the engines panel. What is gone is the
  paragraph of telemetry above the table — not the measurements.

**Verified on the running build by reading the DOM**, not by assuming:

```
document.getElementById('gbSigStatus')           → null
document.getElementById('gbV3Status')            → null
body.innerText match /new engine: N rows read/   → false
body.innerText match /(session|market) closed…BUY/→ false
gbLiveClock.textContent                          → "19:06:42 IST"   (scheduler alive)
gbMktSent.textContent                            → "market MIXED · 0% / 0.28%"
#gbMoversWrap rows                               → 51               (the board still renders)
#gbEnginesPanel                                  → present
browser console                                  → empty
```

`npm test` **350/350**.

---

## 19. After the close: who blocks, who lets a name back — and the four guards that were missing (2026-09-29, sixth pass)

The instruction was a division of labour, not a feature: *"that yahoo finance evng logic will run daily
automatically after market close; in market open we taking volume 1minute for board so we remove it by angel
one ok; and yahoo finance did one thing after block if its moving then it gets back; remember angel one will
remove for next day it will block it; yahoo finace will do this work for blocked every 30min it do
automatically when market open"*.

So: **Angel One decides the block** (its own 1-minute volume, live in the session and again from the tape after
the close), **Yahoo decides the way back** (a 30-minute re-check of the blocked names while the market is open),
and **the evening chain owns everything that has to be true before tomorrow opens**.

### 19.1 What the live state actually said, before anything was changed

| Reading | Value | Meaning |
|---|---|---|
| block ledger (`data/angel_volume_block.json`) | **did not exist — 0 entries** | the BLOCKED button was telling the truth: nothing had ever been blocked |
| `data/eod_scan.json` (tonight's 18:05 run) | `ok: true`, `fetched: true` | the evening job considered itself done |
| its four steps | **all failed**, status `3221225786` | `0xC000013A` = killed. The chain died and reported success |
| `data/ohlcv/` newest candle | 2026-09-24 (2,483 files behind) | so the F5 gate rejected 2,933 of 2,933 names |
| `data/ohlcv_1m/` newest session | 2026-09-25 | the after-close Angel pass had nothing from today to judge |
| `scripts/refreshDailyFromYahoo.js` | **never called by anything** | "the Yahoo evening logic" did not run at all |
| `scripts/fetchOhlcv1m.js` | **never called by anything** | the 1-minute tape had stopped advancing on 2026-09-25 |

This is the failure mode §16.1 describes in another place: a chain that skips its work looks exactly like a
chain that found nothing to do.

### 19.2 The evening chain (`common/market/eodScan.js`) — the Yahoo step now runs, and the tape advances

```
1. daily candles (Yahoo)   refreshDailyFromYahoo.js      ← NEW: was never called by anything
   daily candles (Angel)   fetchUniverseOhlcv --stale    ← now a fast no-op that only backfills what Yahoo missed
2. 15m candles             fetchUniverseOhlcv15m --stale
3. universe filter         filterUniverse.js
3b. 1-minute tape          fetchOhlcv1m.js               ← NEW: the day the after-close block pass reads
4. engine scores           scoreEngines.js
5. FREEZE base list        (preopenPicks)
6. BLOCK LIST              scanDeadNames.js              ← NEW: Angel 1m tape + the whole-market screen
```

The Yahoo step goes **first** because the Angel daily endpoint answers `403` on this session (measured: the
recorded run burned 132 s in retries and was killed) while `refreshDailyFromYahoo.js` **merges by date** into the
same store, so nothing is lost and a symbol Yahoo cannot resolve is left alone rather than truncated.

**Measured, running it for real tonight:** `refreshed 2,729 · skipped 203 · failed 2 in 75 s` — the store went
from 450 to 2,979 files current, the screen then passed **1,004 of 2,934** instead of 0, and the 1-minute tape
went to 1,006 files carrying **2026-09-29** (7.5 M bars, 0 failed, ~21 sessions each).

### 19.3 The two halves of the block list, and what they wrote tonight

| Half | Source | Judged | Result |
|---|---|---|---|
| whole market | the quality screen's own rejections | 2,934 scrips | **1,517** blocked — `below-price` 889, `no-turnover` 599, `out-of-vol-band` 23, `no-movement` 6; the 412 `F5 stale` rejections **skipped**, because that is our history missing, not the names dead |
| 1-minute tape | Angel One's own tape | 1,004 tapes | **2** blocked — `GOACARBON` (₹0.60 Cr) and `SIGNPOST` (₹0.94 Cr) under the ₹1 Cr turnover floor |

Ledger: **1,519 entries, all blocked today**, and the board's three buttons read
**ALL (2933) · OK (1414) · BLOCKED (1519)** live, with no server restart — `universeInfo()` reads the ledger at
request time.

**`ALL` was printing the same number as `OK`.** `tracked` is the pool the feed carries, and the pool is already
the market minus the blocked names, so two of the three buttons answered one question and the market's own size
lived only in a tooltip. `ALL` is now `total` (the market), `OK` is `notBlocked` (the pool), `BLOCKED` is the
ledger, and each carries its own title.

### 19.4 Four guards that were missing — each one found by running it, not by reasoning about it

1. **A stale session was going to be judged as today.** The tape's reference day was "the newest day any file
   has", so with the tapes ending 2026-09-25 and the market closed 2026-09-29, Friday's verdict would have been
   written as `lastFail 2026-09-25 / until 2026-10-01` — a four-day-old measurement displayed as "blocked today".
   The session is now **derived from the clock** (`expectedSession`: today after the close, the previous trading
   day pre-open, so a Monday looks past the weekend) and the pass **refuses** when the tape does not reach it.
2. **A partial tape is not a dead market.** `classify()` calls "no bars for the session" `zero-1m-day`, so a
   fetch that died halfway blocks every name it never reached for a week. Measured mid-refresh: 1 of 1,004
   names had today's tape. The pass now counts names **measured for that session** and refuses under 50 %
   coverage (`GB_DEAD_MIN_COVERAGE`).
3. **A file the fetcher never reached is not a dead name.** The 1-minute fetcher drops zero-volume bars, so a
   name that did not trade and a file that was never fetched look identical from the bars alone. The file says
   which: it is judged only when its window reaches the session **or** its `fetchedAt` does (`measuredFor()`).
4. **A liquidity block is a decision, not a fault.** Measured on the real 1,519-name ledger: a first bounded
   revival pass would have cleared **4 of 4** — `20MICRONS` (`no-turnover`), `21STCENMGM` and `3IINFOLTD`
   (`below-price`), `3PLAND` (a 3.4 % move). All four are alive by construction and all four are meant to stay
   out. The 30-minute pass now revives **feed faults only** (`zero-1m`, `zero-1m-day`) and reports the rest as
   `held by liquidity` (1,519 tonight); structural blocks are cleared only by the evening screen, when the name
   passes it again — the same "neither family may erase the other's record" rule `angelVolumeBlock` already
   enforces on the writing side.

The fifth was an existing guard, mis-calibrated by measurement: `universeBlock.maxRejectFraction` was **0.5**,
but a *correct* ₹1 Cr-turnover screen on this market rejects **66 %** (1,929 of 2,934). The guard was refusing
every healthy run while reporting a guard as the reason, which silently disabled the whole feature. It is now
**0.9** — the pathological case it must catch is the all-F5 run (2,933 of 2,933); the data gates keep their own,
sharper check immediately above it.

### 19.5 The 30-minute pass, armed

`Server.js` arms `blockRevival.due()` on a 60-second ticker; the pass itself runs at most every 30 minutes and
**only** 09:15–15:30 IST on a weekday. It asks Yahoo (`interval=1m&range=1d`) serially, bounded at 40 names per
pass, and clears a block only on a **positive** reading — volume ≥ 1,000 shares **or** a ≥ 0.5 % move from the
previous close. A missing quote is `unmeasured` and the block stands: *we did not hear* is not *it moved*.

### 19.6 Verified

```
node scripts/refreshDailyFromYahoo.js      → refreshed 2,729 · skipped 203 · failed 2 in 75s
node scripts/filterUniverse.js             → 2,934 → passed 1,004, rejected 1,929 (F5 stale 412)
node scripts/scanDeadNames.js --dry        → REFUSED (thin-coverage) 1/1004 measured   ← the guard, working
node scripts/scanDeadNames.js --universe   → blocked 1,517
node scripts/scanDeadNames.js --tape       → session 2026-09-29 · blocked 2
curl /api/gb/movers?all=1                  → ALL(2933) OK(1414) BLOCKED(1519), 153 rows
browser: buttons + titles, board 153 rows, console empty
```

`npm test` **382/382** (13 checks added: 2 staleness/coverage, 1 unmeasured-file, 2 revival-scope, plus the
existing replay of the refusals).

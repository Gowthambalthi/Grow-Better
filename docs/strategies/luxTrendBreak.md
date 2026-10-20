# luxTrendBreak — Trendlines with Breaks [LuxAlgo] (one break per anchored line, k=1)

**What it gives: -0.123R per trade net (PF 0.784, win rate 38.5%, 28031 trades) — NO_EDGE.**

<!-- strategy-doc id=luxTrendBreak trades=28031 winPct=38.5 netR=-0.1230 pf=0.784 grossR=-0.0180 costR=0.1050 ciLo=-0.144 ciHi=-0.102 verdict=NO_EDGE -->

## What it is

- **Logic family:** trendline break (one-shot latch per anchored pivot line)
- **Source:** pivothigh/pivotlow(length, length) anchor a line; slope = ATR(length)/length*k is FROZEN at that pivot; the line decays by its frozen slope every bar; the latch resets to 0 on a new pivot and sets to 1 once close passes the line, so the signal (the rising edge) is ONE break per line.
- **Repository:** LuxAlgo — "Trendlines with Breaks" (Pine v5 listing supplied by the user, 2026-09-29) (`luxalgo-trendlines`)
- **Exits:** THE SOURCE HAS NO EXIT — it is an indicator with two alertcondition calls and no stop, target or order. The port declares it once for both rows: stop = common/market/stopLevels.identifyStop (band 0.6-2.5%), target = 2R of that risk.

## What was done (the port)

- **Adaptation:** The `upper = 0.` initialisation is replaced by an explicit no-line guard (debug.noLine counts the bars it covers). MEASURED TO CHANGE NO SIGNAL: over 40 symbols the guarded and unguarded loops differ only on bar 0 (36,005 break bars vs 35,965), so the guard is housekeeping, not a fix — the pivot branch already clears the latch. The display offset (plot(..., offset=-length)) is not copied, because the test arithmetic already evaluates the same line. NOT COPIED FROM THE PUBLISHED REVISION: the GitHub copy of this listing tests close[length] against the UNDECAYED line as a crossover, and its pivot rule allows ties on both sides; this row is the listing as supplied, with ta.pivothigh tie semantics (strictly above the bars to its LEFT, at or above the bars to its RIGHT).
- **Reduced data:** no
- **Claim taken from:** LuxAlgo — "Trendlines with Breaks" (Pine v5 listing supplied by the user, 2026-09-29)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 28031 | 38.5% | 40.5% | -0.0180 | 0.1050 | -0.1230 | 0.784 | 0.965 | 1.162 | -0.928 | 3453.1R | 35 |

How it gets out: stop hit on 46.3% of trades, target hit on 17.4%, other/flat exits 0.6%.

Excursion, which is where the give-back is visible: mean MFE 0.917R, share of trades that reached +1R 38.0%, mean MAE 0.787R, mean give-back from the peak 0.935R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.144, -0.102]**
- session-mean CI: [-0.144, -0.103]
- positive sessions: 16 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.123R)
- A MEASURED LOSS (net-R CI [-0.144, -0.102] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.123 → **-0.146** (-0.023R)
- PF: 0.784 → 0.747

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `luxTrendBreakK2` | trendline break (one-shot latch per anchored pivot line) | -0.117 | 29082 | NO_EDGE |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `luxTrendBreak`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** LuxAlgo — "Trendlines with Breaks" (Pine v5 listing supplied by the user, 2026-09-29).

NO PUBLISHED NUMBER — the source is an INDICATOR (two alertcondition calls, no stop, no target, no order), so there is no claim to check and the exit is the port own declaration (identifyStop, band 0.60-2.50%, target 2R). DECLARED DIVERGENCE, MEASURED: the `upper = 0.` initialisation is replaced by an explicit no-line guard, and this was diffed over 40 symbols against the source arithmetic — the two differ ONLY on bar 0 (36,005 break bars vs 35,965), so the guard changes no signal and is housekeeping, not a fix. This is the listing AS SUPPLIED (current close vs the decayed line), with ta.pivothigh tie semantics; the published GitHub revision tests close[length] against the undecayed line and allows ties on both sides of a pivot, so it is a different row.

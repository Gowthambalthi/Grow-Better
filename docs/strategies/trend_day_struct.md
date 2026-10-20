# trend_day_struct — Trend Day · structural stop (threshold unchanged)

**What it gives: -0.060R per trade net (PF 0.878, win rate 42.3%, 324 trades) — NO_EDGE.**

<!-- strategy-doc id=trend_day_struct trades=324 winPct=42.3 netR=-0.0600 pf=0.878 grossR=0.0330 costR=0.0930 ciLo=-0.205 ciHi=0.084 verdict=NO_EDGE -->

## What it is

- **Logic family:** late-day trend-day hold to the close
- **Source:** trend_day/trend_day.py — the SAME 6% threshold and the same 14:00 trigger; only the stop moves
- **Repository:** quantrocket-codeload/trend-day (variant) (`trend-day`)
- **Exits:** repo (market close) + common/market/stopLevels.identifyStop for the stop the source never had

## What was done (the port)

- **Adaptation:** VARIANT of trend_day: the declared 0.99/1.01 placeholder is replaced by the level the tape had actually printed by 14:00 (identifyStop, band 0.60-2.50%). The threshold is UNCHANGED at 6%, so this row isolates what the stop did — and it fires as rarely as the source, so read its trade count before its mean.
- **Reduced data:** no
- **Claim taken from:** this repo — stress test of trend_day, 2026-09-29

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 324 | 42.3% | 44.4% | 0.0330 | 0.0930 | -0.0600 | 0.878 | 1.074 | 1.024 | -0.855 | 23.3R | 9 |

How it gets out: stop hit on 40.1% of trades, target hit on 0.0%, other/flat exits 2.8%.

Excursion, which is where the give-back is visible: mean MFE 1.121R, share of trades that reached +1R 36.1%, mean MAE 0.747R, mean give-back from the peak 1.088R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 118 sessions, seed 20260927): **[-0.205, 0.084]**
- session-mean CI: [-0.240, 0.201]
- positive sessions: 48 of 118
- verdict: **NO_EDGE** — no edge after costs (mean -0.06R)
- THE INTERVAL SPANS ZERO (net-R CI [-0.205, 0.084]) — the point estimate is an estimate, not a result.

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.060 → **-0.087** (-0.027R)
- PF: 0.878 → 0.838

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `trend_day` | late-day trend-day hold to the close | -0.031 | 376 | NO_EDGE |

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `trend_day_adr` | late-day trend-day hold to the close | -0.055 | 1309 | NO_EDGE |
| `trend_day_selfq` | late-day trend-day hold to the close | -0.066 | 1569 | NO_EDGE |
| `trend_day_adr_struct` | late-day trend-day hold to the close | -0.072 | 1171 | NO_EDGE |
| `trend_day_selfq_struct` | late-day trend-day hold to the close | -0.073 | 1402 | NO_EDGE |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `trend_day_struct`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** this repo — stress test of trend_day, 2026-09-29.

VARIANT of trend_day, threshold UNCHANGED: the declared 1.00% stop is replaced by identifyStop (the level the tape had printed by 14:00, inside a 0.60-2.50% band). Fires as rarely as the source does, so a thin trade count here is a property of the 6% threshold, not of the stop.

# trend_day_adr_struct — Trend Day · ADR threshold + structural stop

**What it gives: -0.072R per trade net (PF 0.819, win rate 43.1%, 1171 trades) — NO_EDGE.**

<!-- strategy-doc id=trend_day_adr_struct trades=1171 winPct=43.1 netR=-0.0720 pf=0.819 grossR=0.0230 costR=0.0950 ciLo=-0.151 ciHi=0.005 verdict=NO_EDGE -->

## What it is

- **Logic family:** late-day trend-day hold to the close
- **Source:** trend_day/trend_day.py — both declared placeholders replaced at once
- **Repository:** quantrocket-codeload/trend-day (variant) (`trend-day`)
- **Exits:** repo (market close) + identifyStop for the stop

## What was done (the port)

- **Adaptation:** VARIANT of trend_day: ADR threshold AND the structural stop together, i.e. the source's one idea (decide a direction once near 14:00, hold to the close) with neither of the two numbers that were not the source's. The cleanest reading of the premise, and the row whose trade count is large enough to carry a confidence interval.
- **Reduced data:** no
- **Claim taken from:** this repo — stress test of trend_day, 2026-09-29

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1171 | 43.1% | 47.1% | 0.0230 | 0.0950 | -0.0720 | 0.819 | 1.066 | 0.761 | -0.705 | 94.6R | 12 |

How it gets out: stop hit on 27.3% of trades, target hit on 0.0%, other/flat exits 2.0%.

Excursion, which is where the give-back is visible: mean MFE 0.852R, share of trades that reached +1R 27.0%, mean MAE 0.617R, mean give-back from the peak 0.829R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 134 sessions, seed 20260927): **[-0.151, 0.005]**
- session-mean CI: [-0.166, -0.004]
- positive sessions: 56 of 134
- verdict: **NO_EDGE** — no edge after costs (mean -0.072R)
- THE INTERVAL SPANS ZERO (net-R CI [-0.151, 0.005]) — the point estimate is an estimate, not a result.

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.072 → **-0.115** (-0.043R)
- PF: 0.819 → 0.714

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `trend_day` | late-day trend-day hold to the close | -0.031 | 376 | NO_EDGE |
| `trend_day_adr` | late-day trend-day hold to the close | -0.055 | 1309 | NO_EDGE |

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `trend_day_struct` | late-day trend-day hold to the close | -0.060 | 324 | NO_EDGE |
| `trend_day_selfq` | late-day trend-day hold to the close | -0.066 | 1569 | NO_EDGE |
| `trend_day_selfq_struct` | late-day trend-day hold to the close | -0.073 | 1402 | NO_EDGE |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `trend_day_adr_struct`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** this repo — stress test of trend_day, 2026-09-29.

VARIANT of trend_day with BOTH declared placeholders replaced: ADR threshold + identifyStop structural stop. The cleanest reading of the premise and the one with enough trades to carry a confidence interval.

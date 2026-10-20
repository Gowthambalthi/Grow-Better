# trend_day — Trend Day (late-day momentum to the close)

**What it gives: -0.031R per trade net (PF 0.943, win rate 40.7%, 376 trades) — NO_EDGE.**

<!-- strategy-doc id=trend_day trades=376 winPct=40.7 netR=-0.0310 pf=0.943 grossR=0.0690 costR=0.1000 ciLo=-0.172 ciHi=0.111 verdict=NO_EDGE -->

## What it is

- **Logic family:** late-day trend-day hold to the close
- **Source:** trend_day/trend_day.py (Ernie Chan, Algorithmic Trading) — 6% move by 14:00, hold to close
- **Repository:** quantrocket-codeload/trend-day (`trend-day`)
- **Exits:** repo (market close; the source places MOC orders)

## What was done (the port)

- **Adaptation:** leveraged-ETF 6% threshold NOT rescaled for NSE cash; source has no stop, so a 1.00% structural stop is declared to satisfy the risk band and the exit stays the session close
- **Reduced data:** no
- **Claim taken from:** quantrocket-codeload/trend-day (trend_day.py — no headline number in the repo)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 376 | 40.7% | 42.6% | 0.0690 | 0.1000 | -0.0310 | 0.943 | 1.144 | 1.249 | -0.909 | 30.1R | 12 |

How it gets out: stop hit on 44.4% of trades, target hit on 0.0%, other/flat exits 2.4%.

Excursion, which is where the give-back is visible: mean MFE 1.286R, share of trades that reached +1R 43.6%, mean MAE 0.821R, mean give-back from the peak 1.217R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 123 sessions, seed 20260927): **[-0.172, 0.111]**
- session-mean CI: [-0.161, 0.229]
- positive sessions: 51 of 123
- verdict: **NO_EDGE** — no edge after costs (mean -0.031R)
- THE INTERVAL SPANS ZERO (net-R CI [-0.172, 0.111]) — the point estimate is an estimate, not a result.

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.031 → **-0.131** (-0.100R)
- PF: 0.943 → 0.780

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `trend_day_adr` | late-day trend-day hold to the close | -0.055 | 1309 | NO_EDGE |
| `trend_day_struct` | late-day trend-day hold to the close | -0.060 | 324 | NO_EDGE |
| `trend_day_selfq` | late-day trend-day hold to the close | -0.066 | 1569 | NO_EDGE |
| `trend_day_adr_struct` | late-day trend-day hold to the close | -0.072 | 1171 | NO_EDGE |
| `trend_day_selfq_struct` | late-day trend-day hold to the close | -0.073 | 1402 | NO_EDGE |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `trend_day`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** quantrocket-codeload/trend-day (trend_day.py — no headline number in the repo).

no published win-rate number; the source threshold (6% by 14:00) is tuned for LEVERAGED ETFs and is ported unchanged, so this row measures transfer to NSE cash, not a tuned rule. STRESS-TESTED AND CLOSED 2026-09-29: the two placeholders its own `adaptation` line names (the 6% ETF threshold, the declared 1.00% stop the source does not have) were each replaced by a variant row and the whole set was run on the 995-symbol tape — the source row is -0.141R over 3,244 trades, gross -0.041R, CI [-0.210, -0.069], and ALL FIVE variants are established losses too (-0.081 to -0.124R). The +0.082R this row is parked on was a 45-symbol artifact; on the bigger tape it is the WORST of the six. Run the variants yourself with --ids=trend_day_struct,trend_day_adr,trend_day_adr_struct,trend_day_selfq,trend_day_selfq_struct, or read freebuff/trend-day-stress.js for the cost sweep / by-month / by-symbol detail.

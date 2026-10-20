# nifty50_ict — nifty50 ICT: liquidity sweep -> structure -> retrace

**What it gives: -0.143R per trade net (PF 0.776, win rate 36.9%, 1267 trades) — NO_EDGE.**

<!-- strategy-doc id=nifty50_ict trades=1267 winPct=36.9 netR=-0.1430 pf=0.776 grossR=-0.0300 costR=0.1130 ciLo=-0.222 ciHi=-0.065 verdict=NO_EDGE -->

## What it is

- **Logic family:** index-bias ICT/SMC retest
- **Source:** backend/app/strategy/breakout_sweep.py + structure.py + entries.py (reduced: retracement entry only)
- **Repository:** vijay158199/nifty50 (`ict-smc`)
- **Exits:** adaptation (stop beyond the displacement extreme, target 2R; the repo computes its own risk module)

## What was done (the port)

- **Adaptation:** five entry-zone detectors reduced to the retracement entry; first-candle window 30m
- **Reduced data:** YES — the port dropped inputs the tape cannot supply
- **Claim taken from:** nifty50 README

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1267 | 36.9% | 38.4% | -0.0300 | 0.1130 | -0.1430 | 0.776 | 0.947 | 1.347 | -1.016 | 205.8R | 21 |

How it gets out: stop hit on 54.4% of trades, target hit on 21.2%, other/flat exits 0.2%.

Excursion, which is where the give-back is visible: mean MFE 1.007R, share of trades that reached +1R 42.3%, mean MAE 0.863R, mean give-back from the peak 1.037R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.222, -0.065]**
- session-mean CI: [-0.219, -0.061]
- positive sessions: 54 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.143R)
- A MEASURED LOSS (net-R CI [-0.222, -0.065] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.143 → **-0.078** (+0.065R)
- PF: 0.776 → 0.872

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.259R net per trade on 995 symbols / 142 sessions / 0.10% round trip — index-bias ICT/SMC retest — index-trend family. Still runs with --ids=nifty50_ict.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `nifty50_ict`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> 64.7% win rate

WITHDRAWN NUMBER: the measured ESTABLISHED row was a fabrication — retracement entries were armed without re-checking the invalidation level the stop is built from, so a breached setup produced a long whose stop sat ABOVE its fill and booked exactly +1.00R on the next bar (270 of 452 sampled trades, at an MFE of ZERO). Honest re-measurement on 20 symbols × 43 sessions: 241 trades, gross −0.084R, net −0.380R, win 32%, PF 0.55. Source caveat (unchanged): the repo states 34 trades over 2 months — too small to mean anything.

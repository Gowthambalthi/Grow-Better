# ai_vwap_momentum — AI-trader: VWAP momentum breakout

**What it gives: -0.192R per trade net (PF 0.725, win rate 37.6%, 9853 trades) — NO_EDGE.**

<!-- strategy-doc id=ai_vwap_momentum trades=9853 winPct=37.6 netR=-0.1920 pf=0.725 grossR=-0.0620 costR=0.1300 ciLo=-0.230 ciHi=-0.154 verdict=NO_EDGE -->

## What it is

- **Logic family:** VWAP momentum
- **Source:** strategy/signal_generator.py::vwap_momentum_breakout
- **Repository:** aaryansinha16/AI-trader (`ai-bundle`)
- **Exits:** adaptation (repo defines no underlying stop)

## What was done (the port)

- **Adaptation:** source trades option premium (no chain available here): directional signal tested on the underlying with a 1.5xATR stop, 1.5R target
- **Reduced data:** no
- **Claim taken from:** AI-trader README

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 9853 | 37.6% | 37.8% | -0.0620 | 0.1300 | -0.1920 | 0.725 | 0.900 | 1.345 | -1.119 | 1903.2R | 34 |

How it gets out: stop hit on 61.5% of trades, target hit on 36.5%, other/flat exits 0.0%.

Excursion, which is where the give-back is visible: mean MFE 1.004R, share of trades that reached +1R 47.2%, mean MAE 0.953R, mean give-back from the peak 1.066R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.230, -0.154]**
- session-mean CI: [-0.254, -0.187]
- positive sessions: 18 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.192R)
- A MEASURED LOSS (net-R CI [-0.230, -0.154] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.192 → **-0.245** (-0.053R)
- PF: 0.725 → 0.660

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `ai_mean_reversion` | mean reversion | -0.066 | 6278 | NO_EDGE |
| `ai_bearish_momentum` | bearish momentum | -0.204 | 5793 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.492R net per trade on 995 symbols / 142 sessions / 0.10% round trip — VWAP momentum (ported from an option-premium repo) — momentum family on a different instrument. Still runs with --ids=ai_vwap_momentum.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `ai_vwap_momentum`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> 60-76% win rate (best strategy across risk profiles)

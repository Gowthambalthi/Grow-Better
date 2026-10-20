# ai_bearish_momentum — AI-trader: bearish momentum

**What it gives: -0.204R per trade net (PF 0.708, win rate 37.3%, 5793 trades) — NO_EDGE.**

<!-- strategy-doc id=ai_bearish_momentum trades=5793 winPct=37.3 netR=-0.2040 pf=0.708 grossR=-0.0740 costR=0.1300 ciLo=-0.270 ciHi=-0.136 verdict=NO_EDGE -->

## What it is

- **Logic family:** bearish momentum
- **Source:** strategy/signal_generator.py::bearish_momentum
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
| 5793 | 37.3% | 37.5% | -0.0740 | 0.1300 | -0.2040 | 0.708 | 0.881 | 1.329 | -1.117 | 1213.0R | 32 |

How it gets out: stop hit on 61.5% of trades, target hit on 35.6%, other/flat exits 0.1%.

Excursion, which is where the give-back is visible: mean MFE 0.956R, share of trades that reached +1R 46.5%, mean MAE 0.975R, mean give-back from the peak 1.030R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.270, -0.136]**
- session-mean CI: [-0.306, -0.203]
- positive sessions: 27 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.204R)
- A MEASURED LOSS (net-R CI [-0.270, -0.136] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.204 → **-0.217** (-0.013R)
- PF: 0.708 → 0.692

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `ai_mean_reversion` | mean reversion | -0.066 | 6278 | NO_EDGE |
| `ai_vwap_momentum` | VWAP momentum | -0.192 | 9853 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.466R net per trade on 995 symbols / 142 sessions / 0.10% round trip — bearish momentum (option-premium repo) — momentum family, one-sided. Still runs with --ids=ai_bearish_momentum.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `ai_bearish_momentum`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> 60-76% win rate (as part of the same set)

# supertrend — Supertrend flip

**What it gives: -0.199R per trade net (PF 0.523, win rate 30.0%, 23485 trades) — NO_EDGE.**

<!-- strategy-doc id=supertrend trades=23485 winPct=30.0 netR=-0.1990 pf=0.523 grossR=-0.0760 costR=0.1230 ciLo=-0.212 ciHi=-0.185 verdict=NO_EDGE -->

## What it is

- **Logic family:** Supertrend trend-follow
- **Source:** algotrade/strategies/supertrend_strategy.py
- **Repository:** vijaxx/algo-trading-system (`algo-trading-system`)
- **Exits:** repo (the Supertrend line trails the stop; an opposite flip closes the trade)

## What was done (the port)

- **Adaptation:** none declared
- **Reduced data:** no
- **Claim taken from:** algo-trading-system (no headline number)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 23485 | 30.0% | 35.6% | -0.0760 | 0.1230 | -0.1990 | 0.523 | 0.774 | 0.728 | -0.595 | 4665.9R | 31 |

How it gets out: stop hit on 93.5% of trades, target hit on 6.5%, other/flat exits 0.2%.

Excursion, which is where the give-back is visible: mean MFE 0.659R, share of trades that reached +1R 24.0%, mean MAE 0.579R, mean give-back from the peak 0.735R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.212, -0.185]**
- session-mean CI: [-0.214, -0.187]
- positive sessions: 2 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.199R)
- A MEASURED LOSS (net-R CI [-0.212, -0.185] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.199 → **-0.274** (-0.075R)
- PF: 0.523 → 0.410

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `orb` | opening-range breakout | -0.082 | 10847 | NO_EDGE |
| `bollinger` | Bollinger | -0.153 | 14277 | NO_EDGE |
| `ema_rsi` | EMA + RSI trend | -0.250 | 2182 | NO_EDGE |
| `nifty_trend` | index trend (5-filter) | -0.412 | 2720 | NO_EDGE |
| `vwap_reversion` | VWAP mean reversion | n/a | 0 | NO_TRADES |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.473R net per trade on 995 symbols / 142 sessions / 0.10% round trip — Supertrend trail — trend family, and the trail re-enters 2M times on this tape. Still runs with --ids=supertrend.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `supertrend`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** algo-trading-system (no headline number).

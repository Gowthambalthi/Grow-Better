# nifty_trend — Nifty intraday trend (5-filter breakout)

**What it gives: -0.412R per trade net (PF 0.254, win rate 6.8%, 2720 trades) — NO_EDGE.**

<!-- strategy-doc id=nifty_trend trades=2720 winPct=6.8 netR=-0.4120 pf=0.254 grossR=-0.2800 costR=0.1320 ciLo=-0.448 ciHi=-0.377 verdict=NO_EDGE -->

## What it is

- **Logic family:** index trend (5-filter)
- **Source:** src/nifty_algo/strategy.py::generate_signals (config.py defaults: EMA9/21, ST10x2.5, Donchian20, ADX>=20, ATR%>=0.05%)
- **Repository:** anirudhatalmale6-alt/nifty-banknifty-intraday-trend-algo (`algo-trading-system`)
- **Exits:** repo (ATR stop 1.5x, break-even at +1xATR, Supertrend trail, EMA cross exit, 15:15 square-off, no fixed target)

## What was done (the port)

- **Adaptation:** none declared
- **Reduced data:** no
- **Claim taken from:** nifty-banknifty README

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2720 | 6.8% | 7.3% | -0.2800 | 0.1320 | -0.4120 | 0.254 | 0.349 | 2.068 | -0.593 | 1121.7R | 80 |

How it gets out: stop hit on 93.1% of trades, target hit on 0.0%, other/flat exits 47.8%.

Excursion, which is where the give-back is visible: mean MFE 0.987R, share of trades that reached +1R 30.9%, mean MAE 0.820R, mean give-back from the peak 1.267R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.448, -0.377]**
- session-mean CI: [-0.478, -0.407]
- positive sessions: 6 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.412R)
- A MEASURED LOSS (net-R CI [-0.448, -0.377] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.412 → **-0.441** (-0.029R)
- PF: 0.254 → 0.217

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `orb` | opening-range breakout | -0.082 | 10847 | NO_EDGE |
| `bollinger` | Bollinger | -0.153 | 14277 | NO_EDGE |
| `supertrend` | Supertrend trend-follow | -0.199 | 23485 | NO_EDGE |
| `ema_rsi` | EMA + RSI trend | -0.250 | 2182 | NO_EDGE |
| `vwap_reversion` | VWAP mean reversion | n/a | 0 | NO_TRADES |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.704R net per trade on 995 symbols / 142 sessions / 0.10% round trip — index trend (5-filter) — the same bet as the in-house nifty model, and the worst row measured. Still runs with --ids=nifty_trend.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `nifty_trend`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> profit factor 1.10-1.92

holds up on 15-year DAILY bars; the author says the intraday version is "a friction-and-runway problem"

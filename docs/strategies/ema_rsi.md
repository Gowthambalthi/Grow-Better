# ema_rsi — EMA Crossover + RSI gate

**What it gives: -0.250R per trade net (PF 0.653, win rate 35.5%, 2182 trades) — NO_EDGE.**

<!-- strategy-doc id=ema_rsi trades=2182 winPct=35.5 netR=-0.2500 pf=0.653 grossR=-0.1200 costR=0.1300 ciLo=-0.303 ciHi=-0.194 verdict=NO_EDGE -->

## What it is

- **Logic family:** EMA + RSI trend
- **Source:** algotrade/strategies/ema_rsi.py
- **Repository:** vijaxx/algo-trading-system (`algo-trading-system`)
- **Exits:** repo (ATR stop 1.5x, target = 1.5R; the repo also exits on the opposite EMA cross — the fixed target is used here)

## What was done (the port)

- **Adaptation:** none declared
- **Reduced data:** no
- **Claim taken from:** algo-trading-system (no headline number)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2182 | 35.5% | 35.7% | -0.1200 | 0.1300 | -0.2500 | 0.653 | 0.812 | 1.329 | -1.120 | 548.8R | 16 |

How it gets out: stop hit on 63.7% of trades, target hit on 33.8%, other/flat exits 0.0%.

Excursion, which is where the give-back is visible: mean MFE 0.936R, share of trades that reached +1R 44.5%, mean MAE 1.011R, mean give-back from the peak 1.056R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.303, -0.194]**
- session-mean CI: [-0.310, -0.192]
- positive sessions: 32 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.25R)
- A MEASURED LOSS (net-R CI [-0.303, -0.194] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.250 → **-0.330** (-0.080R)
- PF: 0.653 → 0.566

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `orb` | opening-range breakout | -0.082 | 10847 | NO_EDGE |
| `bollinger` | Bollinger | -0.153 | 14277 | NO_EDGE |
| `supertrend` | Supertrend trend-follow | -0.199 | 23485 | NO_EDGE |
| `nifty_trend` | index trend (5-filter) | -0.412 | 2720 | NO_EDGE |
| `vwap_reversion` | VWAP mean reversion | n/a | 0 | NO_TRADES |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.573R net per trade on 995 symbols / 142 sessions / 0.10% round trip — EMA + RSI trend — trend family. The old cross-reference here ("see trend_day for the trend premise that measured best") is WITHDRAWN: on the 995-symbol tape trend_day is -0.141R over 3,244 trades with a CI entirely below zero, so the trend family's best row is still an established loss — see the 2026-09-29 stress-test update. Still runs with --ids=ema_rsi.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `ema_rsi`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** algo-trading-system (no headline number).

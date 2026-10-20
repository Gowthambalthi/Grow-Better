# vwap_reversion — VWAP Mean Reversion

**What it gives: nothing to report — it never fired.** 0 trades on the tape, verdict NO_TRADES.

<!-- strategy-doc id=vwap_reversion trades=0 winPct=null netR=null pf=null grossR=null costR=null ciLo=null ciHi=null verdict=NO_TRADES -->

## What it is

- **Logic family:** VWAP mean reversion
- **Source:** algotrade/strategies/vwap_reversion.py
- **Repository:** vijaxx/algo-trading-system (`algo-trading-system`)
- **Exits:** repo (target = the session VWAP level at signal time)

## What was done (the port)

- **Adaptation:** none declared
- **Reduced data:** no
- **Claim taken from:** algo-trading-system README

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% | gross R | cost R | net R | PF |
|---|---|---|---|---|---|
| 0 | — | — | — | — | — |

It signalled 42151 times and fired 0 trades: every signal was refused before entry, so there is no win rate and no PF. Reporting it as the worst row would be a measurement it never received.

## Does the interval mean anything

- no confidence interval — no trades to bootstrap
- verdict: **NO_TRADES** — never fired — no trades at all
- NEVER FIRED — no measurement exists for this row, so nothing is known about it.

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `orb` | opening-range breakout | -0.082 | 10847 | NO_EDGE |
| `bollinger` | Bollinger | -0.153 | 14277 | NO_EDGE |
| `supertrend` | Supertrend trend-follow | -0.199 | 23485 | NO_EDGE |
| `ema_rsi` | EMA + RSI trend | -0.250 | 2182 | NO_EDGE |
| `nifty_trend` | index trend (5-filter) | -0.412 | 2720 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.212R net per trade on 995 symbols / 142 sessions / 0.10% round trip — VWAP mean reversion — mean-reversion family, not one of the two kept premises. Still runs with --ids=vwap_reversion.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `vwap_reversion`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> 22.6% win rate

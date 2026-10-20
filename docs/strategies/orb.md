# orb — Opening Range Breakout

**What it gives: -0.082R per trade net (PF 0.801, win rate 43.6%, 10847 trades) — NO_EDGE.**

<!-- strategy-doc id=orb trades=10847 winPct=43.6 netR=-0.0820 pf=0.801 grossR=-0.0140 costR=0.0680 ciLo=-0.110 ciHi=-0.052 verdict=NO_EDGE -->

## What it is

- **Logic family:** opening-range breakout
- **Source:** algotrade/strategies/orb.py
- **Repository:** vijaxx/algo-trading-system (`algo-trading-system`)
- **Exits:** repo (stop = opposite side of range, target = rr x risk)

## What was done (the port)

- **Adaptation:** none declared
- **Reduced data:** no
- **Claim taken from:** algo-trading-system README · reconciliation: data/orb_reconcile.json

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10847 | 43.6% | 46.2% | -0.0140 | 0.0680 | -0.0820 | 0.801 | 0.962 | 0.755 | -0.729 | 893.3R | 31 |

How it gets out: stop hit on 29.2% of trades, target hit on 14.1%, other/flat exits 0.7%.

Excursion, which is where the give-back is visible: mean MFE 0.685R, share of trades that reached +1R 27.7%, mean MAE 0.636R, mean give-back from the peak 0.699R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.110, -0.052]**
- session-mean CI: [-0.111, -0.050]
- positive sessions: 31 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.082R)
- A MEASURED LOSS (net-R CI [-0.110, -0.052] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.082 → **-0.116** (-0.034R)
- PF: 0.801 → 0.727

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `bollinger` | Bollinger | -0.153 | 14277 | NO_EDGE |
| `supertrend` | Supertrend trend-follow | -0.199 | 23485 | NO_EDGE |
| `ema_rsi` | EMA + RSI trend | -0.250 | 2182 | NO_EDGE |
| `nifty_trend` | index trend (5-filter) | -0.412 | 2720 | NO_EDGE |
| `vwap_reversion` | VWAP mean reversion | n/a | 0 | NO_TRADES |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `orb`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> best strategy of the set, net -Rs 3.4k over 60 days after costs

NOT COMPARABLE to Strategy 2 Test A: this row is ALL sessions with the repo's WIDE stop (opposite side of the range, median 1.49% of price); Test A is the OOS-7 slice with a TIGHT bucket stop (0.46%). Their gross R agree (-0.028 vs -0.027) and the whole visible gap is cost-in-R, which is why the win rates differ (42% vs 34%). Matched on sessions AND stop rule the two ports agree within 0.02R.

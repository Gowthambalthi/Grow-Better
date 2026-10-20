# aggShortCircuit — Aggression-proxy breakout + location filter (NOT the plan's Strategy 1)

**What it gives: -0.315R per trade net (PF 0.609, win rate 28.0%, 1744 trades) — NO_EDGE.**

<!-- strategy-doc id=aggShortCircuit trades=1744 winPct=28.0 netR=-0.3150 pf=0.609 grossR=-0.1860 costR=0.1290 ciLo=-0.382 ciHi=-0.243 verdict=NO_EDGE -->

## What it is

- **Logic family:** aggression-proxy breakout
- **Source:** gb_scoring_v2 plan V3 gate logic (ShortCircuit-style aggression step-up + candle confirmation + price-at-range/S-R location), both sides
- **Repository:** user-plan-v3 (order-flow gate: aggression + candle + location) (`plan-v3-s1proxy`)
- **Exits:** adaptation (the plan says exit on collapse OR ATR stop/target; collapse is a future-bar condition a bar backtest cannot evaluate without peeking, so the fixed ATR stop/target is used as the honest instrument)

## What was done (the port)

- **Adaptation:** both sides (plan is one-sided discretionary); candle confirmation reduced to a fixed allowed set {engulfing, hammer/inverted-hammer, inside-bar breakout} so the backtest can tell whether confirmation helps; location = session 15m range edge OR session high/low (plan S/R across timeframes reduced to session scale so the rule is bar-local)
- **Reduced data:** no
- **Claim taken from:** user-plan-v3 proxy port, no published win-rate number

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1744 | 28.0% | 28.2% | -0.1860 | 0.1290 | -0.3150 | 0.609 | 0.740 | 1.753 | -1.120 | 551.1R | 20 |

How it gets out: stop hit on 71.2% of trades, target hit on 25.4%, other/flat exits 0.2%.

Excursion, which is where the give-back is visible: mean MFE 1.021R, share of trades that reached +1R 41.2%, mean MAE 1.076R, mean give-back from the peak 1.207R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.382, -0.243]**
- session-mean CI: [-0.389, -0.246]
- positive sessions: 30 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.315R)
- A MEASURED LOSS (net-R CI [-0.382, -0.243] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.315 → **-0.293** (+0.022R)
- PF: 0.609 → 0.632

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.561R net per trade on 995 symbols / 142 sessions / 0.10% round trip — aggression-proxy breakout — an order-flow proxy this tape cannot supply (OHLCV only), so the premise is untestable here. Still runs with --ids=aggShortCircuit.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `aggShortCircuit`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** user-plan-v3 proxy port, no published win-rate number.

this is NOT the plan's Strategy 1 — it is an OHLCV breakout with an aggression proxy; Strategy 1 (control flips via exhausted aggression at the POC) is NOT BUILT, and the feed has no executed/aggressor side at any subscription mode — whether its only quantity pair (bq/sq) is traded-cumulative or resting-book is decided by .freebuff/verify-bqsq.js on the first captured session

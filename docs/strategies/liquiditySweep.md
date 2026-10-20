# liquiditySweep — Liquidity Sweep Reversal (stop-hunt)

**What it gives: -0.099R per trade net (PF 0.832, win rate 39.3%, 4682 trades) — NO_EDGE.**

<!-- strategy-doc id=liquiditySweep trades=4682 winPct=39.3 netR=-0.0990 pf=0.832 grossR=0.0260 costR=0.1250 ciLo=-0.136 ciHi=-0.063 verdict=NO_EDGE -->

## What it is

- **Logic family:** liquidity sweep reversal
- **Source:** user plan v3 addendum: liquidity pools -> sweep -> rejection/displacement -> flow -> FVG entry -> ROC -> stop beyond the wick
- **Repository:** ICT/SMC stop-hunt (popularised, no single repo) — user plan v3 addendum (`plan-v3-s3`)
- **Exits:** structural (stop beyond the sweep wick extreme, target = an R multiple of that risk; the wick is the invalidation, so the stop is tight by construction)

## What was done (the port)

- **Adaptation:** FLOW CONFIRMATION IS A PROXY. The tape is OHLCV 1m, so there is no executed footprint, no order-book depth and no true net delta. The plan's "net-delta step-up" is approximated by a volume/range step-up and labelled proxy here and on every candidate — it is NOT executed aggression.
- **Reduced data:** no
- **Claim taken from:** user-plan-v3 addendum (liquidity sweep reversal: pools -> sweep -> rejection -> flow(proxy) -> FVG -> ROC -> wick stop), no published win-rate number

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4682 | 39.3% | 41.4% | 0.0260 | 0.1250 | -0.0990 | 0.832 | 1.050 | 1.248 | -0.972 | 472.1R | 20 |

How it gets out: stop hit on 48.1% of trades, target hit on 19.7%, other/flat exits 0.7%.

Excursion, which is where the give-back is visible: mean MFE 1.002R, share of trades that reached +1R 42.5%, mean MAE 0.833R, mean give-back from the peak 0.976R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.136, -0.063]**
- session-mean CI: [-0.135, -0.062]
- positive sessions: 44 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.099R)
- A MEASURED LOSS (net-R CI [-0.136, -0.063] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.099 → **-0.142** (-0.043R)
- PF: 0.832 → 0.771

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.151R net per trade on 995 symbols / 142 sessions / 0.10% round trip — liquidity sweep reversal — the row the user removed by name; same family as the in-house sweep. Still runs with --ids=liquiditySweep.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `liquiditySweep`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** `strategies/liquiditySweep.js` — ENGINE 1, hash-pinned by Gate F. The live/backtest codes are the same module; the harness measured that module.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** user-plan-v3 addendum (liquidity sweep reversal: pools -> sweep -> rejection -> flow(proxy) -> FVG -> ROC -> wick stop), no published win-rate number.

WITHDRAWN NUMBER: an earlier revision of this harness reported OOS +0.201R with a bootstrap CI excluding zero and called this strategy ESTABLISHED. That was a side-naming bug, not a result — the long side was labelled so that the simulator resolved every long candidate as a SHORT, booking a CONSTANT +1.00R gross on the next bar whether the sweep held or failed (.freebuff/verify-side-bug.js reproduces it). Every post-fix measurement is negative. Separately: heavily popularised (ICT/SMC), no published number, and popularity is a RISK here: on liquid NSE names the exact swing levels everyone watches may already be crowded.

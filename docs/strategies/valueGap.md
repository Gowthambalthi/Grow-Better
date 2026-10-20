# valueGap — Value gap (unfilled FVG) re-entry, 5m+15m (window=760, refresh=5)

**What it gives: -0.110R per trade net (PF 0.817, win rate 38.2%, 13931 trades) — NO_EDGE.**

<!-- strategy-doc id=valueGap trades=13931 winPct=38.2 netR=-0.1100 pf=0.817 grossR=0.0030 costR=0.1130 ciLo=-0.139 ciHi=-0.081 verdict=NO_EDGE -->

## What it is

- **Logic family:** valueGap
- **Source:** a 3-candle imbalance on the 5m or 15m frame (candle-1 extreme vs candle-3 opposite extreme) that is still unfilled, at least 0.08% tall, and no more than undefined candles old on its own frame. The entry is taken when a bar CLOSES inside the band.
- **Repository:** in-house premise built on common/market/fvg.js — the board's own FVG read (`unknown`)
- **Exits:** DECLARED BY THIS PORT — the source is a context vote with no stop and no target. Stop beyond the FAR edge of the band + 0.15%, target = 2R of that risk.

## What was done (the port)

- **Adaptation:** Not a port. This is the user's value-gap premise: the band comes from the same module the live board reads, and the entry/stop geometry is declared here and stated in `config`.
- **Reduced data:** no
- **Claim taken from:** in-house premise built on common/market/fvg.js — the board's own FVG read

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 13931 | 38.2% | 39.8% | 0.0030 | 0.1130 | -0.1100 | 0.817 | 1.006 | 1.285 | -0.971 | 1545.4R | 23 |

How it gets out: stop hit on 49.5% of trades, target hit on 20.6%, other/flat exits 0.6%.

Excursion, which is where the give-back is visible: mean MFE 1.001R, share of trades that reached +1R 42.0%, mean MAE 0.815R, mean give-back from the peak 0.997R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.139, -0.081]**
- session-mean CI: [-0.137, -0.082]
- positive sessions: 36 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.11R)
- A MEASURED LOSS (net-R CI [-0.139, -0.081] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.110 → **-0.120** (-0.010R)
- PF: 0.817 → 0.799

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `liqOrb` | liqOrb | -0.089 | 6368 | NO_EDGE |
| `liqSweepOb` | liqSweepOb | -0.095 | 11178 | NO_EDGE |
| `luxSweepWickF` | luxSweepWickF | -0.138 | 3390 | NO_EDGE |
| `liqObRetest` | liqObRetest | -0.139 | 1931 | NO_EDGE |
| `luxSweepWick3` | luxSweepWick3 | -0.147 | 5010 | NO_EDGE |
| `srFib` | srFib | -0.152 | 188 | NO_EDGE |
| `luxSweepWick` | luxSweepWick | -0.152 | 4016 | NO_EDGE |
| `srZoneFlow` | srZoneFlow | -0.169 | 178 | NO_EDGE |
| `srFlowPlain` | srFlowPlain | -0.171 | 4313 | NO_EDGE |
| `srFlow` | srFlow | -0.173 | 4294 | NO_EDGE |
| `luxSweepBoth` | luxSweepBoth | -0.183 | 6171 | NO_EDGE |

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `valueGap`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** `strategies/fvg/index.js` — ENGINE 2. The row is the in-house premise built on the board's own FVG module (was common/market/fvg.js, now strategies/fvg/index.js after the 2026-10-13 reorg).
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** in-house premise built on common/market/fvg.js — the board's own FVG read.

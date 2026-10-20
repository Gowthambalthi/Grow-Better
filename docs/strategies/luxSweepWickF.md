# luxSweepWickF — Liquidity Sweeps [LuxAlgo] (sweep reversal, mode=wicks, swings=5)

**What it gives: -0.138R per trade net (PF 0.794, win rate 36.2%, 3390 trades) — NO_EDGE.**

<!-- strategy-doc id=luxSweepWickF trades=3390 winPct=36.2 netR=-0.1380 pf=0.794 grossR=-0.0100 costR=0.1280 ciLo=-0.181 ciHi=-0.088 verdict=NO_EDGE -->

## What it is

- **Logic family:** luxSweepWickF
- **Source:** pivot high/low (len each side, confirmed len bars later) -> the mode chooses the trade: a WICK that pierces the level and closes back (Only Wicks), or a close through it followed by a close back through it (outbreak & retest). A close straight through mitigates the pivot, and pivots die on mitigation/either trade/or 2000 bars of age.
- **Repository:** LuxAlgo — "Liquidity Sweeps [LuxAlgo]" (Pine v5 listing supplied by the user, 2026-09-28) (`unknown`)
- **Exits:** THE SOURCE HAS NO EXIT — it is an indicator. The port declares it once for every sweep: stop beyond the sweep bar's own wick extreme + 0.10%, target = 2R of that risk. Identical on every luxSweep row, so the rows differ only in the source's own settings.

## What was done (the port)

- **Adaptation:** No entry, stop, target or exit exists in the source; the plan above is the port's declaration. The Sweep Area boxes are ported but DISPLAY-ONLY — no signal reads them. A same-bar collision between two pools keeps the oldest pool's event and is counted in debug.bothSides.
- **Reduced data:** no
- **Claim taken from:** LuxAlgo — "Liquidity Sweeps [LuxAlgo]" (Pine v5 listing supplied by the user, 2026-09-28)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3390 | 36.2% | 37.3% | -0.0100 | 0.1280 | -0.1380 | 0.794 | 0.984 | 1.467 | -1.049 | 469.9R | 14 |

How it gets out: stop hit on 56.5% of trades, target hit on 24.1%, other/flat exits 0.3%.

Excursion, which is where the give-back is visible: mean MFE 1.073R, share of trades that reached +1R 45.5%, mean MAE 0.961R, mean give-back from the peak 1.082R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.181, -0.088]**
- session-mean CI: [-0.183, -0.088]
- positive sessions: 44 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.138R)
- A MEASURED LOSS (net-R CI [-0.181, -0.088] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.138 → **-0.193** (-0.055R)
- PF: 0.794 → 0.721

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `luxSweepWick` | luxSweepWick | -0.152 | 4016 | NO_EDGE |

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `liqOrb` | liqOrb | -0.089 | 6368 | NO_EDGE |
| `liqSweepOb` | liqSweepOb | -0.095 | 11178 | NO_EDGE |
| `valueGap` | valueGap | -0.110 | 13931 | NO_EDGE |
| `liqObRetest` | liqObRetest | -0.139 | 1931 | NO_EDGE |
| `luxSweepWick3` | luxSweepWick3 | -0.147 | 5010 | NO_EDGE |
| `srFib` | srFib | -0.152 | 188 | NO_EDGE |
| `srZoneFlow` | srZoneFlow | -0.169 | 178 | NO_EDGE |
| `srFlowPlain` | srFlowPlain | -0.171 | 4313 | NO_EDGE |
| `srFlow` | srFlow | -0.173 | 4294 | NO_EDGE |
| `luxSweepBoth` | luxSweepBoth | -0.183 | 6171 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.410R net per trade on 995 symbols / 142 sessions / 0.10% round trip — LuxAlgo sweep + the user's own filters (ATR pierce + volume confirm) — the BEST of the four lux rows and still -0.41R, which is what retires them all. Still runs with --ids=luxSweepWickF.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `luxSweepWickF`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** LuxAlgo — "Liquidity Sweeps [LuxAlgo]" (Pine v5 listing supplied by the user, 2026-09-28).

# liqObRetest — Liquidity: limit into the order block (swings=5, wicks, periods=5, thr=0.15%)

**What it gives: -0.139R per trade net (PF 0.800, win rate 35.6%, 1931 trades) — NO_EDGE.**

<!-- strategy-doc id=liqObRetest trades=1931 winPct=35.6 netR=-0.1390 pf=0.800 grossR=-0.0070 costR=0.1330 ciLo=-0.205 ciHi=-0.074 verdict=NO_EDGE -->

## What it is

- **Logic family:** liqObRetest
- **Source:** sweep: a pivot confirmed `swings` bars late, pierced and closed back through (LuxAlgo). block: the last opposite candle before `periods` same-direction candles moving >= threshold% (wugamlo). The join: the block frames the risk, the sweep times the entry.
- **Repository:** LuxAlgo "Liquidity Sweeps" + wugamlo "Order Block Finder" — joined in common/market/liquiditySweep.js (`unknown`)
- **Exits:** DECLARED BY THIS PORT — neither source has a stop or a target. Stop beyond the ORDER BLOCK's far edge (or the sweep wick when no block is required) + 0.15%, target = 2R of that risk.

## What was done (the port)

- **Adaptation:** The sources are indicators (wugamlo's own alert text says "NOT a BUY signal"). Entry, stop and target are the port's declaration and are identical on both rows, so the rows differ ONLY in whether the sweep times the entry or the block does.
- **Reduced data:** no
- **Claim taken from:** LuxAlgo "Liquidity Sweeps" + wugamlo "Order Block Finder" — joined in common/market/liquiditySweep.js

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1931 | 35.6% | 36.2% | -0.0070 | 0.1330 | -0.1390 | 0.800 | 0.989 | 1.563 | -1.081 | 272.6R | 15 |

How it gets out: stop hit on 59.6% of trades, target hit on 26.5%, other/flat exits 0.2%.

Excursion, which is where the give-back is visible: mean MFE 1.120R, share of trades that reached +1R 47.5%, mean MAE 0.945R, mean give-back from the peak 1.126R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.205, -0.074]**
- session-mean CI: [-0.178, -0.036]
- positive sessions: 51 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.139R)
- A MEASURED LOSS (net-R CI [-0.205, -0.074] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.139 → **-0.158** (-0.019R)
- PF: 0.800 → 0.775

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `liqOrb` | liqOrb | -0.089 | 6368 | NO_EDGE |
| `liqSweepOb` | liqSweepOb | -0.095 | 11178 | NO_EDGE |
| `valueGap` | valueGap | -0.110 | 13931 | NO_EDGE |
| `luxSweepWickF` | luxSweepWickF | -0.138 | 3390 | NO_EDGE |
| `luxSweepWick3` | luxSweepWick3 | -0.147 | 5010 | NO_EDGE |
| `srFib` | srFib | -0.152 | 188 | NO_EDGE |
| `luxSweepWick` | luxSweepWick | -0.152 | 4016 | NO_EDGE |
| `srZoneFlow` | srZoneFlow | -0.169 | 178 | NO_EDGE |
| `srFlowPlain` | srFlowPlain | -0.171 | 4313 | NO_EDGE |
| `srFlow` | srFlow | -0.173 | 4294 | NO_EDGE |
| `luxSweepBoth` | luxSweepBoth | -0.183 | 6171 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.139R net per trade on 995 symbols / 142 sessions / 0.10% round trip — order block alone (limit into the live zone) — the control that shows the sweep is load-bearing. 99.3% of its candidates are refused as degenerate risk because an order-block zone is narrow by construction. Still runs with --ids=liqObRetest.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `liqObRetest`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** LuxAlgo "Liquidity Sweeps" + wugamlo "Order Block Finder" — joined in common/market/liquiditySweep.js.

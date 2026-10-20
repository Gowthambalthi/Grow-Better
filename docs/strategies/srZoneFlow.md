# srZoneFlow — S&R logistic level + TRVO flow + Fibonacci golden zone (pivot=14, thr=0.7), zone=20

**What it gives: -0.169R per trade net (PF 0.733, win rate 36.5%, 178 trades) — NO_EDGE.**

<!-- strategy-doc id=srZoneFlow trades=178 winPct=36.5 netR=-0.1690 pf=0.733 grossR=-0.0450 costR=0.1240 ciLo=-0.339 ciHi=0.005 verdict=NO_EDGE -->

## What it is

- **Logic family:** srZoneFlow
- **Source:** a pivot high/low (pivotLength bars each side, confirmed pivotLength bars late) becomes a level candidate; the source learns ONLINE which (RSI>50, body>ATR) combinations tend to be RESPECTED and only marks a level real above probabilityThreshold. Events: RETEST (level pierced and reclaimed = it HELD) and BREAK (closed beyond, no reclaim = it FAILED). TRVO then reports this minute against the same minute on prior sessions, and which side of the bar closed. The fib script supplies the 0.5-0.618 band of the rolling leg as the pocket.
- **Repository:** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" + fluxchart "Fibonacci Golden Wave" — ported in common/market/srRegression.js and common/market/trvo.js (`unknown`)
- **Exits:** DECLARED BY THIS PORT — none of the three listings has a stop or a target (their alerts are "Support Retest"/"Resistance Break" and a fib band). Stop beyond the LEVEL (or the entry bar extreme when it pierced deeper) + 0.15%, target = 2R of that risk. Identical on all three rows, so the rows differ only in which ingredients gate the entry.

## What was done (the port)

- **Adaptation:** The listings are indicators. Entry = the level event on the sealed bar, in the direction the level implies: a support that HELD is a BUY, a support that BROKE is a SHORT, and mirrored on resistance. The flow and zone gates are the port's; the row with `gate:"none"` measures the level event alone so their contribution is a measurement, not a claim.
- **Reduced data:** no
- **Claim taken from:** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" + fluxchart "Fibonacci Golden Wave" — ported in common/market/srRegression.js and common/market/trvo.js

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 178 | 36.5% | 38.8% | -0.0450 | 0.1240 | -0.1690 | 0.733 | 0.918 | 1.272 | -0.998 | 41.5R | 11 |

How it gets out: stop hit on 52.8% of trades, target hit on 20.2%, other/flat exits 1.1%.

Excursion, which is where the give-back is visible: mean MFE 0.989R, share of trades that reached +1R 40.4%, mean MAE 0.983R, mean give-back from the peak 1.034R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 100 sessions, seed 20260927): **[-0.339, 0.005]**
- session-mean CI: [-0.310, 0.079]
- positive sessions: 35 of 100
- verdict: **NO_EDGE** — no edge after costs (mean -0.169R)
- THE INTERVAL SPANS ZERO (net-R CI [-0.339, 0.005]) — the point estimate is an estimate, not a result.

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.169 → **-0.278** (-0.109R)
- PF: 0.733 → 0.588

## Same-source siblings (collapsed into this row by the harness)

These rows come from the same source family and the harness carries them as siblings of this one. They are separate strategies with separate numbers, not variants of this row:

| sibling | logic | mean R | trades | verdict |
|---|---|---|---|---|
| `liqOrb` | liqOrb | -0.089 | 6368 | NO_EDGE |
| `liqSweepOb` | liqSweepOb | -0.095 | 11178 | NO_EDGE |
| `valueGap` | valueGap | -0.110 | 13931 | NO_EDGE |
| `luxSweepWickF` | luxSweepWickF | -0.138 | 3390 | NO_EDGE |
| `liqObRetest` | liqObRetest | -0.139 | 1931 | NO_EDGE |
| `luxSweepWick3` | luxSweepWick3 | -0.147 | 5010 | NO_EDGE |
| `srFib` | srFib | -0.152 | 188 | NO_EDGE |
| `luxSweepWick` | luxSweepWick | -0.152 | 4016 | NO_EDGE |
| `srFlowPlain` | srFlowPlain | -0.171 | 4313 | NO_EDGE |
| `srFlow` | srFlow | -0.173 | 4294 | NO_EDGE |
| `luxSweepBoth` | luxSweepBoth | -0.183 | 6171 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.142R net per trade on 45 symbols / 63 sessions / 0.10% round trip — S&R + flow + the Fibonacci golden pocket — cut 1923 candidates to 76 (96%), so it is UNDERPOWERED rather than proven: CI [-0.403, +0.147] spans zero over 63 sessions. Retired because a point estimate that cannot be separated from luck is not a row, it is a question. Still runs with --ids=srZoneFlow.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `srZoneFlow`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" + fluxchart "Fibonacci Golden Wave" — ported in common/market/srRegression.js and common/market/trvo.js.

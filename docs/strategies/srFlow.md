# srFlow — S&R logistic level + TRVO flow (pivot=14, thr=0.7)

**What it gives: -0.173R per trade net (PF 0.741, win rate 34.7%, 4294 trades) — NO_EDGE.**

<!-- strategy-doc id=srFlow trades=4294 winPct=34.7 netR=-0.1730 pf=0.741 grossR=-0.0520 costR=0.1210 ciLo=-0.211 ciHi=-0.135 verdict=NO_EDGE -->

## What it is

- **Logic family:** srFlow
- **Source:** a pivot high/low (pivotLength bars each side, confirmed pivotLength bars late) becomes a level candidate; the source learns ONLINE which (RSI>50, body>ATR) combinations tend to be RESPECTED and only marks a level real above probabilityThreshold. Events: RETEST (level pierced and reclaimed = it HELD) and BREAK (closed beyond, no reclaim = it FAILED). TRVO then reports this minute against the same minute on prior sessions, and which side of the bar closed.
- **Repository:** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" — ported in common/market/srRegression.js and common/market/trvo.js (`unknown`)
- **Exits:** DECLARED BY THIS PORT — none of the three listings has a stop or a target (their alerts are "Support Retest"/"Resistance Break" and a fib band). Stop beyond the LEVEL (or the entry bar extreme when it pierced deeper) + 0.15%, target = 2R of that risk. Identical on all three rows, so the rows differ only in which ingredients gate the entry.

## What was done (the port)

- **Adaptation:** The listings are indicators. Entry = the level event on the sealed bar, in the direction the level implies: a support that HELD is a BUY, a support that BROKE is a SHORT, and mirrored on resistance. The flow and zone gates are the port's; the row with `gate:"none"` measures the level event alone so their contribution is a measurement, not a claim.
- **Reduced data:** no
- **Claim taken from:** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" — ported in common/market/srRegression.js and common/market/trvo.js

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4294 | 34.7% | 36.3% | -0.0520 | 0.1210 | -0.1730 | 0.741 | 0.911 | 1.427 | -1.023 | 743.8R | 17 |

How it gets out: stop hit on 56.6% of trades, target hit on 22.3%, other/flat exits 0.4%.

Excursion, which is where the give-back is visible: mean MFE 1.025R, share of trades that reached +1R 43.4%, mean MAE 0.904R, mean give-back from the peak 1.077R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.211, -0.135]**
- session-mean CI: [-0.219, -0.142]
- positive sessions: 32 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.173R)
- A MEASURED LOSS (net-R CI [-0.211, -0.135] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.173 → **-0.200** (-0.027R)
- PF: 0.741 → 0.705

## Declared variants (one knob off this row)

A variant is one declared knob moved off this row, so it is sensitivity, not a new strategy.

| variant | what moved | mean R | trades | verdict |
|---|---|---|---|---|
| `srFlowPlain` | srFlowPlain | -0.171 | 4313 | NO_EDGE |

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
| `srZoneFlow` | srZoneFlow | -0.169 | 178 | NO_EDGE |
| `luxSweepBoth` | luxSweepBoth | -0.183 | 6171 | NO_EDGE |

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.180R net per trade on 45 symbols / 142 sessions / 0.10% round trip — S&R level event + the TRVO flow vote — the gate is a TAUTOLOGY: the level-held entry already requires the bar to close in the upper part of its range, and TRVO's split is inferred from exactly that, so the gate agreed 1920 times out of 1923 and cost 0.004R per trade to do it. Still runs with --ids=srFlow.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `srFlow`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** fluxchart "Support and Resistance Logistic Regression" + fluxchart "TRVO" — ported in common/market/srRegression.js and common/market/trvo.js.

# sweepReversalOte — Sweep Reversal in OTE (reviewed rule set)

**What it gives: -0.128R per trade net (PF 0.814, win rate 32.4%, 68 trades) — NO_EDGE.**

<!-- strategy-doc id=sweepReversalOte trades=68 winPct=32.4 netR=-0.1280 pf=0.814 grossR=-0.0090 costR=0.1190 ciLo=-0.469 ciHi=0.260 verdict=NO_EDGE -->

## What it is

- **Logic family:** OTE-located sweep reversal with HTF bias and an acceptance close
- **Source:** HTF structure -> OTE 62-79% of the external range -> swing inside OTE -> sweep it -> ACCEPTANCE close beyond the triggering level -> stop beyond the sweep extreme -> target opposite liquidity, min 2R
- **Repository:** Daily Price Action / Justin Bennett — "How to Trade Liquidity Sweep Reversals (15-Minute Strategy)" (`dailypriceaction-sweep-ote`)
- **Exits:** structural: stop just beyond the sweep extreme (the invalidation), target at the nearest opposite-side liquidity level; fixed, not trailed

## What was done (the port)

- **Adaptation:** source trades the 15-MINUTE chart; ported to the 1-MINUTE tape with a 5-bar pivot. Acceptance is a 1m close (fires earlier/more often than his 15m close) and sweepMaxBars bounds sweep-vs-breakout. "The low that triggered the sweep" is read as the lowest low from the setup swing through the sweep extreme.
- **Reduced data:** no
- **Claim taken from:** Daily Price Action / Justin Bennett — "How to Trade Liquidity Sweep Reversals (15-Minute Strategy)" (updated 2026-01-30), plus "Liquidity Sweeps Explained"

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 68 | 32.4% | 33.8% | -0.0090 | 0.1190 | -0.1280 | 0.814 | 0.985 | 1.734 | -1.019 | 18.9R | 6 |

How it gets out: stop hit on 58.8% of trades, target hit on 16.2%, other/flat exits 0.0%.

Excursion, which is where the give-back is visible: mean MFE 1.245R, share of trades that reached +1R 50.0%, mean MAE 0.974R, mean give-back from the peak 1.254R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 49 sessions, seed 20260927): **[-0.469, 0.260]**
- session-mean CI: [-0.530, 0.198]
- positive sessions: 17 of 49
- verdict: **NO_EDGE** — no edge after costs (mean -0.128R)
- THE INTERVAL SPANS ZERO (net-R CI [-0.469, 0.260]) — the point estimate is an estimate, not a result.

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.128 → **-0.265** (-0.137R)
- PF: 0.814 → 0.660

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.355R net per trade on 995 symbols / 142 sessions / 0.10% round trip — ICT sweep + FVG retrace — a sixth condition layered on the same sweep premise, worse than the plain sweep. Still runs with --ids=sweepReversalOte.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `sweepReversalOte`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> 2.8R and 2.5R example outcomes; a claimed "10-15% win-rate bump" from placing the stop a buffer above the sweep high

NO WIN RATE AND NO SAMPLE IS PUBLISHED, and the numbers are two worked EXAMPLES on EURUSD, not a distribution — a screenshot of the best trades is not evidence of an edge. The 10-15% claim is about a stop-placement tweak and is not attached to any measurement. Treated here as a RULE SET to be measured, not a result to be reproduced; the row is graded on the same tape, cost, guards and CI as every other.

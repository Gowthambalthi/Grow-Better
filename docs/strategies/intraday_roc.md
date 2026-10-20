# intraday_roc — Intraday ROC+VWAP (repo's own)

**What it gives: -0.193R per trade net (PF 0.740, win rate 33.7%, 21161 trades) — NO_EDGE.**

<!-- strategy-doc id=intraday_roc trades=21161 winPct=33.7 netR=-0.1930 pf=0.740 grossR=-0.0260 costR=0.1670 ciLo=-0.227 ciHi=-0.158 verdict=NO_EDGE -->

## What it is

- **Logic family:** buy-side ROC+VWAP momentum, volume-confirmed
- **Source:** ROC5>+0.3% & ROC15>0 & volX>=1.1 & close>VWAP; stop 0.6%, T1 1.2%, T2 2.4%
- **Repository:** this repo — scripts/backtestIntradayRoc.js (`this-repo`)
- **Exits:** repo (fixed bracket + EOD square-off)

## What was done (the port)

- **Adaptation:** source ran 15-minute bars; ported to the 1-minute tape with thresholds UNCHANGED (ROC thresholds are timeframe-dependent — the 1m port fires more often, which the cost-in-R arithmetic will punish if the entries are not better). ONE DECLARED DEVIATION (audit 2026-09-28): the source divides the 5-bar volume mean by the session average INCLUDING the signal bar (vols.slice(0,i+1)/(i+1)); that is a benchmark containing the observation it judges, so a real burst deflated its own ratio and the >=1.1 gate under-fired on exactly the bars it exists to catch. The denominator is now the PRIOR completed bars of the session.
- **Reduced data:** no
- **Claim taken from:** this repo — scripts/backtestIntradayRoc.js (15-min store, 12 bps round trip)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 21161 | 33.7% | 34.5% | -0.0260 | 0.1670 | -0.1930 | 0.740 | 0.958 | 1.634 | -1.122 | 4094.9R | 31 |

How it gets out: stop hit on 62.3% of trades, target hit on 28.0%, other/flat exits 0.2%.

Excursion, which is where the give-back is visible: mean MFE 1.131R, share of trades that reached +1R 46.5%, mean MAE 0.967R, mean give-back from the peak 1.157R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 142 sessions, seed 20260927): **[-0.227, -0.158]**
- session-mean CI: [-0.252, -0.186]
- positive sessions: 21 of 142
- verdict: **NO_EDGE** — no edge after costs (mean -0.193R)
- A MEASURED LOSS (net-R CI [-0.227, -0.158] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.193 → **-0.255** (-0.062R)
- PF: 0.740 → 0.668

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.248R net per trade on 995 symbols / 142 sessions / 0.10% round trip — buy-side ROC + VWAP momentum — the in-house momentum follower again. Still runs with --ids=intraday_roc.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `intraday_roc`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** `strategies/roc/rocEngine.js` — The experimental ROC engine family; the measured row is the 1-minute port of scripts/backtestIntradayRoc.js, which is still on disk.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**No win-rate number is published by the source.** this repo — scripts/backtestIntradayRoc.js (15-min store, 12 bps round trip).

NO CLAIM TO CHECK — this is this repo's own script, not a third-party strategy, so there is no published number to falsify. It is graded on the same tape, cost, guards and CI as every ported row. DECLARED ADAPTATION: the source ran 15-MINUTE bars; ROC thresholds are timeframe-dependent, so ported unchanged to 1-minute bars, ROC5 > 0.3% is a far weaker momentum bar and the row fires more often at worse cost-in-R. LONG ONLY by definition (the source has no short side).

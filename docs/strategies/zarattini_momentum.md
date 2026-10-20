# zarattini_momentum — Zarattini/Aziz/Barbon intraday momentum

**What it gives: -0.056R per trade net (PF 0.618, win rate 23.3%, 4633 trades) — NO_EDGE.**

<!-- strategy-doc id=zarattini_momentum trades=4633 winPct=23.3 netR=-0.0560 pf=0.618 grossR=-0.0100 costR=0.0460 ciLo=-0.070 ciHi=-0.039 verdict=NO_EDGE -->

## What it is

- **Logic family:** checkpoint exit outside the 14-session noise area
- **Source:** SSRN 24-97 baseline (noise-area bounds from a 14-session sigma profile, VWAP exit)
- **Repository:** AleksandarMilosavljevic/intraday-trading-strategy (`intraday-trading-strategy`)
- **Exits:** paper (VWAP cross against the position; hold to the close otherwise; stop = the opposite noise bound)

## What was done (the port)

- **Adaptation:** NSE 09:15-15:29 session with the checkpoints shifted -45min (source 09:30-16:00 ET); position sizing not ported (the harness sizes nothing)
- **Reduced data:** no
- **Claim taken from:** AleksandarMilosavljevic/intraday-trading-strategy README (SSRN 24-97 baseline)

## How much it gives (measured on the shared tape)

The tape, for every row in this table: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Source: `data/strategy_rank_100.json`.

| trades | win% (net) | win% (gross) | gross R | cost R | net R | PF (net) | PF (gross) | avg win | avg loss | max DD | longest loss streak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4633 | 23.3% | 26.9% | -0.0100 | 0.0460 | -0.0560 | 0.618 | 0.908 | 0.391 | -0.192 | 268.2R | 37 |

How it gets out: stop hit on 0.0% of trades, target hit on 0.0%, other/flat exits 0.7%.

Excursion, which is where the give-back is visible: mean MFE 0.279R, share of trades that reached +1R 5.2%, mean MAE 0.161R, mean give-back from the peak 0.290R. A row that reaches +1R often and still loses money is paying for it on the way down.

## Does the interval mean anything

- net-R CI (cluster, 126 sessions, seed 20260927): **[-0.070, -0.039]**
- session-mean CI: [-0.060, -0.024]
- positive sessions: 21 of 126
- verdict: **NO_EDGE** — no edge after costs (mean -0.056R)
- A MEASURED LOSS (net-R CI [-0.070, -0.039] entirely below zero).

## The same row on the spread-stressed tape

`data/strategy_rank_spread.json` is the same 100-symbol tape measured with the other fill assumption (`at 2026-09-29T05:04:59Z`). Every row is worse there, which is the point of keeping it: a number that moves this much is reporting the tape, not the strategy.

- net R: -0.056 → **-0.070** (-0.014R)
- PF: 0.618 → 0.542

## The bigger tape, and what retired it

On the 995-symbol / 142-session tape this strategy was already measured once, and the artifact carries that number as its retirement reason:

> measured -0.063R net per trade on 995 symbols / 142 sessions / 0.10% round trip — momentum with a checkpoint exit — the same bet as the in-house momentum follower, which the user named as one of the three failed models. Still runs with --ids=zarattini_momentum.

## Where it lives

- **Harness row:** `gb_scoring_v2/github/strategies.js` (id `zarattini_momentum`), measured by `gb_scoring_v2/github/backtest.js`. Both were deleted from the working tree in the 2026-10-13 reorg; read them from git (`git show HEAD:gb_scoring_v2/github/strategies.js`).
- **Local implementation:** none — this row exists only as a port inside the harness registry. What the board trades live is the engine 1/2/3 family in `strategies/`, which are different rules and are documented per directory in `strategies/README.md`.
- **Full report:** `node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`

## The source's own claim, and the caveat on it

**The source claims:**

> Sharpe ratio 1.34 (net of costs, SPY 2016-2025)

a Sharpe, NOT a win rate — no win-rate number is published for this rule, and the claim is on SPY (US, T+0 settlement, 09:30-16:00) rather than NSE cash. The separate NSE run is data/zarattini_backtest.json.

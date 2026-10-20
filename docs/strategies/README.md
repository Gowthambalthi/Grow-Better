# THE STRATEGIES — one file each, and how much each one gives

Written 2026-10-17 by `freebuff/strategy-docs.js`. Every number below is read from the artifact named beside it; nothing here is typed by hand. Verified by `node scratch/verify_strategy_docs.js`.

<!-- index-doc rows=35 fired=34 neverFired=1 profitable=0 positiveEstimate=0 liveEngines=2 callBooks=14 tierStrategies=9 -->

## How many strategies there are, and how much each gives

| set | how many | how much each gives | where |
|---|---|---|---|
| measured research rows (this index) | **35** — 34 fired, 1 never did | all negative: **0 profitable**, best net R -0.031R per trade | `data/strategy_rank_100.json` |
| retired rows, 995-symbol tape | **22** | all negative, -0.139R to -0.704R per trade | `notPortable` in the same artifact |
| live engines that publish calls | **2** | OF momentum PF 0.79 / 44.2% win; Sweep+FVG PF 0.70 / 35.0% win (pooled over 14 call books) | `scratch/pf_board.js` |
| in-house engines (research core) | **3** | one of them is a measured row (liquiditySweep), one is the FVG premise (valueGap), one is unmeasured as a row | `strategies/`, `strategy-core/engines.js` |
| live tier strategies | **9** | deactivated — no net-positive record | `common/market/liveStrategyEngine.js` |
| python mirrors | **3** | mirrors, not independently measured | `python_app/strategy_core/` |

**The answer, stated plainly: nothing here gives a profit after cost.** Not one of the 34 fired rows has a net-R confidence interval above zero, so a "best strategy" on this tape is the least unprofitable one, and the top of a sorted list of losses is not a portfolio. The two live engines are measured from their own call books and are also below break-even PF (0.79 and 0.70 against the 1.00 line).

## How much each one gives — all 35 rows, best net R first

Tape: 100 symbols · 09:25-14:45 IST entries · risk band 0.6-3% · 0.1% round-trip cost · stop fill = level · 142 sessions. Net R is after the 0.1% round-trip cost; PF is the net profit factor. `spread` is the same tape under the spread-stressed fill assumption.

| # | strategy | trades | win% | net R | PF | net R (spread tape) | file |
|---|---|---|---|---|---|---|---|
| 1 | `trend_day` | 376 | 40.7% | -0.031 | 0.943 | -0.131 | [trend_day.md](trend_day.md) |
| 2 | `trend_day_adr` | 1309 | 42.6% | -0.055 | 0.872 | -0.130 | [trend_day_adr.md](trend_day_adr.md) |
| 3 | `zarattini_momentum` | 4633 | 23.3% | -0.056 | 0.618 | -0.070 | [zarattini_momentum.md](zarattini_momentum.md) |
| 4 | `trend_day_struct` | 324 | 42.3% | -0.060 | 0.878 | -0.087 | [trend_day_struct.md](trend_day_struct.md) |
| 5 | `ai_mean_reversion` | 6278 | 42.5% | -0.066 | 0.897 | -0.033 | [ai_mean_reversion.md](ai_mean_reversion.md) |
| 6 | `trend_day_selfq` | 1569 | 42.3% | -0.066 | 0.840 | -0.106 | [trend_day_selfq.md](trend_day_selfq.md) |
| 7 | `trend_day_adr_struct` | 1171 | 43.1% | -0.072 | 0.819 | -0.115 | [trend_day_adr_struct.md](trend_day_adr_struct.md) |
| 8 | `trend_day_selfq_struct` | 1402 | 42.1% | -0.073 | 0.809 | -0.089 | [trend_day_selfq_struct.md](trend_day_selfq_struct.md) |
| 9 | `orb` | 10847 | 43.6% | -0.082 | 0.801 | -0.116 | [orb.md](orb.md) |
| 10 | `liqOrb` | 6368 | 42.0% | -0.089 | 0.809 | -0.096 | [liqOrb.md](liqOrb.md) |
| 11 | `liqSweepOb` | 11178 | 41.4% | -0.095 | 0.803 | -0.097 | [liqSweepOb.md](liqSweepOb.md) |
| 12 | `liquiditySweep` | 4682 | 39.3% | -0.099 | 0.832 | -0.142 | [liquiditySweep.md](liquiditySweep.md) |
| 13 | `valueGap` | 13931 | 38.2% | -0.110 | 0.817 | -0.120 | [valueGap.md](valueGap.md) |
| 14 | `luxTrendBreakK2` | 29082 | 38.6% | -0.117 | 0.796 | -0.130 | [luxTrendBreakK2.md](luxTrendBreakK2.md) |
| 15 | `luxTrendBreak` | 28031 | 38.5% | -0.123 | 0.784 | -0.146 | [luxTrendBreak.md](luxTrendBreak.md) |
| 16 | `sweepReversalOte` | 68 | 32.4% | -0.128 | 0.814 | -0.265 | [sweepReversalOte.md](sweepReversalOte.md) |
| 17 | `luxSweepWickF` | 3390 | 36.2% | -0.138 | 0.794 | -0.193 | [luxSweepWickF.md](luxSweepWickF.md) |
| 18 | `liqObRetest` | 1931 | 35.6% | -0.139 | 0.800 | -0.158 | [liqObRetest.md](liqObRetest.md) |
| 19 | `nifty50_ict` | 1267 | 36.9% | -0.143 | 0.776 | -0.078 | [nifty50_ict.md](nifty50_ict.md) |
| 20 | `luxSweepWick3` | 5010 | 35.4% | -0.147 | 0.785 | -0.180 | [luxSweepWick3.md](luxSweepWick3.md) |
| 21 | `srFib` | 188 | 37.8% | -0.152 | 0.758 | -0.276 | [srFib.md](srFib.md) |
| 22 | `luxSweepWick` | 4016 | 35.6% | -0.152 | 0.776 | -0.194 | [luxSweepWick.md](luxSweepWick.md) |
| 23 | `bollinger` | 14277 | 39.7% | -0.153 | 0.765 | -0.224 | [bollinger.md](bollinger.md) |
| 24 | `srZoneFlow` | 178 | 36.5% | -0.169 | 0.733 | -0.278 | [srZoneFlow.md](srZoneFlow.md) |
| 25 | `srFlowPlain` | 4313 | 34.8% | -0.171 | 0.744 | -0.192 | [srFlowPlain.md](srFlowPlain.md) |
| 26 | `srFlow` | 4294 | 34.7% | -0.173 | 0.741 | -0.200 | [srFlow.md](srFlow.md) |
| 27 | `luxSweepBoth` | 6171 | 34.0% | -0.183 | 0.739 | -0.229 | [luxSweepBoth.md](luxSweepBoth.md) |
| 28 | `ai_vwap_momentum` | 9853 | 37.6% | -0.192 | 0.725 | -0.245 | [ai_vwap_momentum.md](ai_vwap_momentum.md) |
| 29 | `intraday_roc` | 21161 | 33.7% | -0.193 | 0.740 | -0.255 | [intraday_roc.md](intraday_roc.md) |
| 30 | `supertrend` | 23485 | 30.0% | -0.199 | 0.523 | -0.274 | [supertrend.md](supertrend.md) |
| 31 | `ai_bearish_momentum` | 5793 | 37.3% | -0.204 | 0.708 | -0.217 | [ai_bearish_momentum.md](ai_bearish_momentum.md) |
| 32 | `ema_rsi` | 2182 | 35.5% | -0.250 | 0.653 | -0.330 | [ema_rsi.md](ema_rsi.md) |
| 33 | `aggShortCircuit` | 1744 | 28.0% | -0.315 | 0.609 | -0.293 | [aggShortCircuit.md](aggShortCircuit.md) |
| 34 | `nifty_trend` | 2720 | 6.8% | -0.412 | 0.254 | -0.441 | [nifty_trend.md](nifty_trend.md) |
| 35 | `vwap_reversion` | 0 | n/a | n/a | — | n/a | [vwap_reversion.md](vwap_reversion.md) |

Never fired, so it has no row in a ranking of results: `vwap_reversion` — it signalled 42151 times and every signal was refused before entry.

## The three engine docs, for what actually runs

- [live-of-momentum.md](live-of-momentum.md) — Order Flow Institutional Momentum, what it gives.
- [live-sweep-fvg.md](live-sweep-fvg.md) — Sweep + FVG live, what it gives.
- [live-tier-nine.md](live-tier-nine.md) — the nine tier strategies and why they are off.

## The rows that were retired on the bigger tape

These were measured on 995 symbols × 142 sessions before this 100-symbol run, and the number below is what retired them. They are not gone from the code — several are still ports inside the registry — but nothing here will be re-promoted on a smaller sample.

| strategy | net R on 995 | why it was retired |
|---|---|---|
| `aggShortCircuit` | -0.561 | aggression-proxy breakout — an order-flow proxy this tape cannot supply (OHLCV only), so the premise is untestable here. Still runs with --ids=aggShortCircuit. |
| `ai_bearish_momentum` | -0.466 | bearish momentum (option-premium repo) — momentum family, one-sided. Still runs with --ids=ai_bearish_momentum. |
| `ai_mean_reversion` | -0.294 | mean reversion (option-premium repo) — mean-reversion family. Still runs with --ids=ai_mean_reversion. |
| `ai_vwap_momentum` | -0.492 | VWAP momentum (ported from an option-premium repo) — momentum family on a different instrument. Still runs with --ids=ai_vwap_momentum. |
| `bollinger` | -0.427 | Bollinger squeeze breakout — 884k trades on the full tape, which is a measure of firing rate, not of edge. Still runs with --ids=bollinger. |
| `ema_rsi` | -0.573 | EMA + RSI trend — trend family. The old cross-reference here ("see trend_day for the trend premise that measured best") is WITHDRAWN: on the 995-symbol tape trend_day is -0.141R over 3,244 trades with a CI entirely below zero, so the trend family's best row is still an established loss — see the 2026-09-29 stress-test update. Still runs with --ids=ema_rsi. |
| `intraday_roc` | -0.248 | buy-side ROC + VWAP momentum — the in-house momentum follower again. Still runs with --ids=intraday_roc. |
| `liqObRetest` | -0.139 | order block alone (limit into the live zone) — the control that shows the sweep is load-bearing. 99.3% of its candidates are refused as degenerate risk because an order-block zone is narrow by construction. Still runs with --ids=liqObRetest. |
| `liquiditySweep` | -0.151 | liquidity sweep reversal — the row the user removed by name; same family as the in-house sweep. Still runs with --ids=liquiditySweep. |
| `luxSweepBoth` | -0.457 | LuxAlgo sweep, wicks + breakout&retest — every mode of the source lands in the same place, which is the finding. Still runs with --ids=luxSweepBoth. |
| `luxSweepWick` | -0.450 | LuxAlgo Liquidity Sweeps (Pine default, mode=wicks) — the port is faithful (test/luxSweep.test.js) and still measured -0.450R over 78,028 trades. Still runs with --ids=luxSweepWick. |
| `luxSweepWick3` | -0.451 | LuxAlgo sweep, swings=3 — moving the source's own knob does not move the result. Still runs with --ids=luxSweepWick3. |
| `luxSweepWickF` | -0.410 | LuxAlgo sweep + the user's own filters (ATR pierce + volume confirm) — the BEST of the four lux rows and still -0.41R, which is what retires them all. Still runs with --ids=luxSweepWickF. |
| `nifty50_ict` | -0.259 | index-bias ICT/SMC retest — index-trend family. Still runs with --ids=nifty50_ict. |
| `nifty_trend` | -0.704 | index trend (5-filter) — the same bet as the in-house nifty model, and the worst row measured. Still runs with --ids=nifty_trend. |
| `srFlow` | -0.180 | S&R level event + the TRVO flow vote — the gate is a TAUTOLOGY: the level-held entry already requires the bar to close in the upper part of its range, and TRVO's split is inferred from exactly that, so the gate agreed 1920 times out of 1923 and cost 0.004R per trade to do it. Still runs with --ids=srFlow. |
| `srFlowPlain` | -0.176 | the S&R level event alone (pivot pierced and reclaimed -> trade the reclaim) — an ESTABLISHED loss: 1923 trades over all 142 sessions, CI [-0.229, -0.117], the whole interval below zero. The level lifecycle is ported faithfully (test/flowLocation.test.js) and the premise still does not predict on 1-minute NSE. Still runs with --ids=srFlowPlain. |
| `srZoneFlow` | -0.142 | S&R + flow + the Fibonacci golden pocket — cut 1923 candidates to 76 (96%), so it is UNDERPOWERED rather than proven: CI [-0.403, +0.147] spans zero over 63 sessions. Retired because a point estimate that cannot be separated from luck is not a row, it is a question. Still runs with --ids=srZoneFlow. |
| `supertrend` | -0.473 | Supertrend trail — trend family, and the trail re-enters 2M times on this tape. Still runs with --ids=supertrend. |
| `sweepReversalOte` | -0.355 | ICT sweep + FVG retrace — a sixth condition layered on the same sweep premise, worse than the plain sweep. Still runs with --ids=sweepReversalOte. |
| `vwap_reversion` | -0.212 | VWAP mean reversion — mean-reversion family, not one of the two kept premises. Still runs with --ids=vwap_reversion. |
| `zarattini_momentum` | -0.063 | momentum with a checkpoint exit — the same bet as the in-house momentum follower, which the user named as one of the three failed models. Still runs with --ids=zarattini_momentum. |

## Repositories that were never ported, and why

- **options_lab** (mevishalsonawane-ai/options-lab) — options/panel-IC project (iron condors, lot history, Android exporter): no directional intraday equity signal to port, and it needs an option chain and IV surface this feed does not carry. Its author also publicly retired the 90%+ win-rate claim, replacing it with a single-digit annual return net of costs.
- **orstack** (ORSTAC (crypto)) — not NSE, not equities: crypto fractal-ATR targets on Jan-May 2026 crypto data. Testing it on NSE 1m bars would measure a different instrument and prove nothing about either.
- **hftbacktest** (nkaz001/hftbacktest) — a backtest FRAMEWORK, not a strategy: queue-position fills, L2/L3 book modelling and feed/order latency, with live bots for Binance/Bybit. There is no signal to port, and its only advantage needs tick/book data this repo does not have — data/orderflow/ has never held a session, and this tape is 1-minute OHLCV. Worth revisiting once Strategy 1 capture has produced files.
- **trading_orb** (sam-bateman/trading-orb) — Opening Range Breakout on US equities — the same logic family as the `orb` row that is already ported and measured here, so a second port would be a duplicate row (the table collapses by source family, not by claim). Its 2016-2026 US numbers also cannot be reproduced on this tape, which is the only thing that would make the row meaningful.
- **morning_surge_short** (Morning-surge-short-Strategy / bank-nifty VWAP repos) — named in the conversation but no repository URL was supplied and no published win-rate number to quote. Named-but-unlinked entries cannot be ported: the transcription needs the actual source, and guessing the rules would measure my guess instead of the repo.

## How to re-derive every number here

```
node freebuff/strategy-docs.js                    # regenerate these files from the artifacts
node scratch/verify_strategy_docs.js              # re-check them (fails on drift)
node scratch/pf_board.js                          # the two live engines, from their call books
node scratch/calculate_calls.js --date=YYYY-MM-DD  # one day, deduped, per logic, in bps and INR
node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json
node scratch/verify_strategies_table.js           # the win-rate/PF table in docs/STRATEGIES.md
```

## The rest of the record, in this folder

Every piece of strategy material is reachable from here — the indexes below are generated by `freebuff/consolidate-strategy-info.js` and cover the whole `research/` and `backtest/` trees, whether or not a given file could be moved:

- [ALL-FILES.md](ALL-FILES.md) — where every kind of strategy file lives, code included.
- [research/README.md](research/README.md) — every deep-research document, with its conclusion and the reason it is in place or moved.
- [backtest/README.md](backtest/README.md) — every backtest document, same treatment.
- [pages/README.md](pages/README.md) — the strategy pages that used to sit at the top of `docs/`.

The overview of how the code is laid out is [docs/STRATEGIES.md](../STRATEGIES.md); the nine tier strategies are described line by line in [docs/liveStrategies.md](../liveStrategies.md).

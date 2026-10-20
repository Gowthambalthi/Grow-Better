# THE STRATEGIES — what we actually run, and where each one lives

Written 2026-10-13, from each engine's own header comment and the guard tests that pin it.
Nothing here is aspirational: every row names a file that exists on disk right now.

## LAYOUT — one folder per strategy

Every strategy now lives in its own directory under `strategies/`. There is no longer an
`orderflow/` or a `scalping/` directory at the repo root; those 27 modules moved in on 2026-10-13.

```
strategies/
  fvg/          index.js (was strategies/fvg.js)  sweepFvgLive.js  sweep_fvg_strategy.py
  orderflow/    liveMinuteEngine.js  liveDetector.js  tickCapture.js  armCapture.js
                callOutcomes.js  liveEventJournal.js  f1Live.js  f1Trace.js  f1ReplayCheck.js
                f1ParityVerify.js  f1CrossVerify.js  f1LiveScoreboard.js  depth5_recorder.js
                live_engine.py
  roc/          rocEngine.js  rocEngineV2.js  rocEngineV3.js  scalpService.js  scalpV2Service.js
                signalJournal.js  outcomeTracker.js  rocBacktest.js  rocDiagnostic.js  rocV3Study.js
  liquiditySweep.js   <- ENGINE 1, DELIBERATELY NOT MOVED (Gate F hash-pins this path)
  orderFlow.js        <- ENGINE 3, DELIBERATELY NOT MOVED (Gate F hash-pins this path)
  frozen/             orderFlow.of03v1.js — byte-compared against orderFlow.js by a test
```

`strategy-core/tradePlanner.js` is hash-pinned too and also stays. Renaming a frozen artifact
changes its recorded hash, which is the one thing Gate F exists to notice — so the three pinned
paths are left alone and everything else is grouped.

**The trap this move had to avoid, and the check that proves it was avoided.** These modules locate
their data with `path.join(__dirname, '..', 'data', 'orderflow')`, so moving one of them down a level
would silently repoint the engine's call book at `strategies/data/orderflow` — a directory the
dashboard never reads, so the history would look empty with no error anywhere. Every path was
rewritten to **the depth at which it actually resolves** (not "one deeper"), and the moved modules
were then required and their resolved data directories compared: `liveMinuteEngine` DATA_DIR,
`tickCapture` DIR, `f1Live` JOURNAL_DIR, `callOutcomes` DATA_DIR and `sweepFvgLive` journalDir all
still resolve to `data/orderflow`, and `roc/signalJournal` to `data/scalping`. The live server was
restarted and logged `Loaded 2 existing calls for 2026-10-13`, i.e. it read the same book it wrote
before the move.

---

## 1. THE THREE RULE ENGINES (the research core — `strategies/`)

| # | File | What it is | Frozen? |
|---|---|---|---|
| 1 | `strategies/liquiditySweep.js` | **ENGINE 1 — Liquidity Sweep.** Raids of *meaningful* swing levels only, with incremental per-day state. v1 treated every swing as raid-worthy and recomputed levels every bar, producing a "raid" on ~half of all 1-minute bars. | **YES — hash-pinned** |
| 2 | `strategies/fvg/index.js` | **ENGINE 2 — Fair-Value-Gap retest.** A FVG is a three-candle imbalance, so it only exists on frames that contain the three candles; the engine builds the frames and trades the retest. | No |
| 3 | `strategies/orderFlow.js` | **ENGINE 3 — Absorption & aggressive continuation** (OF03 v1 only — the OF01 absorption and OF02 continuation setups were removed 2026-10-15, numbers in the engine header). Also carries the ORDERFLOW **planner CONFIG** that Gate F hashes. Its own header states plainly that Angel One's best-five packet is *resting book depth, not executed aggressor volume* — the feed has no trade-side field at all. | **YES — hash-pinned** |

Backup of the frozen engine, compared byte-for-byte by `test/researchGuard.test.js`:
`strategies/frozen/orderFlow.of03v1.js`.

## 2. THE LIVE ENGINES (what actually publishes calls)

| File | What it is | Writes |
|---|---|---|
| `strategies/orderflow/liveMinuteEngine.js` | **Order Flow Institutional Momentum.** Live Angel One ticks → in-memory 1-m OHLCV, Volume, Delta, VWAP for ~700–1,000 NSE symbols → institutional setup scan **every 60 seconds** → arms up to 6 calls, 1-minute cadence. | `data/orderflow/daily_calls_<date>.json` |
| `strategies/fvg/sweepFvgLive.js` | **Sweep + FVG (live).** 5-minute bar cadence with 30-minute Opening Range (OR30) confluence; SHORT-only on the sweep branch. | **the same** `daily_calls_<date>.json` |
| `common/market/liveStrategyEngine.js` | **The tier call engine.** Runs the nine core strategies on live data and fills the SCALPING / INTRADAY / SWING tables from our own strategies instead of a constant. | its own board |
| `strategies/orderflow/liveDetector.js` | **Phase 5 live detector.** Runs the *frozen* OF03 detector live and journals the candidates it ARM/eligible — the live half of the frozen-vs-replay comparison. | `data/orderflow/f1-live-<day>.jsonl` |

Two engines write the **one** call book, which is why each call now carries an `engine` stamp and why
the history reader attributes per engine (see `exchange.md` Round 27).

## 3. PYTHON MIRRORS (same ideas, separate implementations)

- `strategies/orderflow/live_engine.py` — real-time institutional engine: FVG displacement & support, order-flow delta footprint / CVD turnaround, VWAP.
- `strategies/fvg/sweep_fvg_strategy.py` — sweep + FVG strategy engine; validated on 368 liquid NSE symbols (≥ ₹20 Cr turnover).

## 4. EXPERIMENTAL / DISABLED

- `strategies/roc/rocEngine.js` (+ `rocEngineV2.js`, `rocEngineV3.js`) — **ROC10 / ROC20 scalping**, a deliberately separate research module on its own board and journal.
- `strategies/roc/scalpService.js` — **EXPERIMENTAL SCALPER, DISABLED BY USER DIRECTIVE**; the module is a no-op stub (`armScalping` returns empty handlers). This is why 5 tests in `test/scalpingService.test.js` fail — they assert a board the stub no longer produces.
- `strategies/roc/scalpV2Service.js`, `signalJournal.js`, `outcomeTracker.js`.

## 5. SUPPORT — NOT STRATEGIES

`strategy-core/` (indicators, levels, market, session, engines registry, audit, replay, strategyLedger,
and `tradePlanner.js` which **is** hash-pinned), `backtest/follow.js`, and
`orderflow/{tickCapture,armCapture,callOutcomes,liveEventJournal,f1Live,f1Trace,f1ReplayCheck,f1ParityVerify,f1LiveScoreboard}.js`.

---

## WHAT IS PINNED, AND WHY A MOVE IS NOT COSMETIC

A folder move is a rename of every path below, and these are **asserted by tests**, not merely imported:

| Pinned path | Asserted / hashed by |
|---|---|
| `strategies/orderFlow.js` | `backtest/phase5Preflight.js` `FROZEN` map; `docs/ORDERFLOW-PHASE2.md` hash line; `test/researchGuard.test.js`, `test/f1LiveGuard.test.js`, `test/phase5aValidation.test.js` |
| `strategies/liquiditySweep.js` | `FROZEN` map; `test/researchGuard.test.js`; forbidden-import lists in `test/scalpingRoc.test.js`, `scalpingV2`, `scalpingV3` |
| `strategy-core/tradePlanner.js` | `FROZEN` map; `test/f1LiveGuard.test.js`, `test/researchGuard.test.js` |
| `strategy-core/{market,engines,audit}.js` | `test/f1LiveGuard.test.js`, `test/researchGuard.test.js` |
| everything under `strategies/orderflow/` | `test/f1LiveGuard.test.js` iterates `fs.readdirSync(path.join(ROOT, 'strategies/orderflow'))` — the *contents* of that directory are part of the guard |
| `strategies/frozen/orderFlow.of03v1.js` | byte-compared against `strategies/orderFlow.js` by `test/researchGuard.test.js` |

So a move must update, **in the same change**: the frozen map, the Phase-2 doc hash line, 6 guard
tests, every `require`/`import` in `Server.js` / `common/` / `test/` / `scripts/` / `backtest/` /
`experiments/` / `research/` / `python_app/`, and the ~100 study scripts in `scratch/` that read
these paths. `data/` (9,209 files, the recorded tapes) and `scratch/` (1,803 files, mostly
`study_journals/*/sweep-fvg-signals-*.jsonl` replay output) are the directories that make the tree
look enormous — the strategy code above is only ~50 files.

---

## WIN RATE AND PF — NOTHING ELSE

Asked for, by request: of everything measured so far, **which one gives more profit factor**, with only
the two numbers kept — no net R, no max drawdown, no confidence interval.

Source: `data/strategy_rank_100.json` (every registry row on ONE tape, so the PF column is
comparable row to row: 100 symbols · 0.60-3% risk band · 09:25-14:45 window · 0.1% round-trip cost).
`PF` is the **net** profit factor (gross wins ÷ gross losses after cost); win rate is the net
win rate. Highest PF first.

| Strategy | Win rate | PF |
|---|---|---|
| `trend_day` | 40.7% | 0.943 |
| `ai_mean_reversion` | 42.5% | 0.897 |
| `trend_day_struct` | 42.3% | 0.878 |
| `trend_day_adr` | 42.6% | 0.872 |
| `trend_day_selfq` | 42.3% | 0.840 |
| `liquiditySweep` | 39.3% | 0.832 |
| `trend_day_adr_struct` | 43.1% | 0.819 |
| `valueGap` | 38.2% | 0.817 |
| `sweepReversalOte` | 32.4% | 0.814 |
| `trend_day_selfq_struct` | 42.1% | 0.809 |
| `liqOrb` | 42.0% | 0.809 |
| `liqSweepOb` | 41.4% | 0.803 |
| `orb` | 43.6% | 0.801 |
| `liqObRetest` | 35.6% | 0.800 |
| `luxTrendBreakK2` | 38.6% | 0.796 |
| `luxSweepWickF` | 36.2% | 0.794 |
| `luxSweepWick3` | 35.4% | 0.785 |
| `luxTrendBreak` | 38.5% | 0.784 |
| `nifty50_ict` | 36.9% | 0.776 |
| `luxSweepWick` | 35.6% | 0.776 |
| `bollinger` | 39.7% | 0.765 |
| `srFib` | 37.8% | 0.758 |
| `srFlowPlain` | 34.8% | 0.744 |
| `srFlow` | 34.7% | 0.741 |
| `intraday_roc` | 33.7% | 0.740 |
| `luxSweepBoth` | 34.0% | 0.739 |
| `srZoneFlow` | 36.5% | 0.733 |
| `ai_vwap_momentum` | 37.6% | 0.725 |
| `ai_bearish_momentum` | 37.3% | 0.708 |
| `ema_rsi` | 35.5% | 0.653 |
| `zarattini_momentum` | 23.3% | 0.618 |
| `aggShortCircuit` | 28.0% | 0.609 |
| `supertrend` | 30.0% | 0.523 |
| `nifty_trend` | 6.8% | 0.254 |

`vwap_reversion` is not on the list: it signalled 42,151 times and fired **0** trades, so it has no
win rate and no PF to rank. Reporting it as "worst" would be a measurement it never received.

**The answer, stated plainly: `trend_day` gives more PF — 0.943 — and it is still below 1.** Not one
of the 34 rows clears break-even PF after cost (0 of 34 at PF ≥ 1), so the ranking above is a ranking
of *least bad*, not a list of profitable strategies. The artifact's own note says the same thing:
no strategy cleared both the trade-count and the session-bootstrap guards, so this is a ranking of
estimates, not of established edges. Gross (before cost) is a different picture — 11 of 34 clear 1.0
there — which is the arithmetic way of saying the spread between those two columns is the cost.

The two live engines are not in this table (they are not backtest rows), so they are measured
separately from the call books: `node scratch/pf_board.js`. Every number in the table above is
checked against the artifact by `node scratch/verify_strategies_table.js`, which fails if a row
matters or a winner is left out. The full report, with the columns deliberately dropped here, is
`node freebuff/strategy-rank-report.js --in=data/strategy_rank_100.json`.

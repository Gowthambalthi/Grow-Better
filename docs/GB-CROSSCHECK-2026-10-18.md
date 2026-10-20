# GB01 / GB02 / GB03a — cross-verified backtest + single-call sheet

Run: **2026-10-18**, corpus `data/ohlcv_1m_full`, 100 symbols, 1,71,22,433 one-minute bars,
705 sessions, **2023-12-04 → 2026-10-06**. One harness (`backtest/runAll.js`), one set of five
rules (next-open fill, plan re-derived against the fill, stop-first on a double touch, cost
charged in R, hold ends at its own session close), `--onePerDay=1`, entry window 09:20–15:00
minus the measured blocked windows.

```
system   setup   engine       n   win@0.05  netPF@0.05  netR@0.05   netPF@0    maxDD
GB01     FG01    FVG         69     42.0%      1.87       +39.1      2.20     6.0R
GB02     FG02    FVG          4     75.0%      4.61        +4.5      6.28     1.0R
GB03a    OF03    ORDERFLOW   21     52.4%      1.75        +9.2      2.33     3.8R
```

Reproduce: `node --max-old-space-size=6144 backtest/runAll.js --symbols=100 --onePerDay=1`
(per-setup rows are the `bySetup` block; `scratch/gb_single_call.js` prints the same numbers
plus the last call of each setup and writes `scratch/gb_single_call.json`).

Measured against these files — quote the hashes with the numbers, or a later edit to one of
them silently orphans this table:

```
strategies/fvg/index.js   7799e7f6ad53f748
strategies/orderFlow.js   8a085cd35d7a781c
backtest/runAll.js        995405b6f848e74e
```

---

## 1. What the cross-check found

### GB01 — reproduced exactly
The shipped `data/terminal/backtest_results.json` and today's independent run agree to the
digit (73 trades, FG01 69 at netR +48.1 on zero cost). Long arm 53 trades PF 2.02, short arm
20 trades PF 3.08 at cost 0. Nothing drifted.

### GB02 — reproduced exactly, and it is not a sample
4 calls in 705 sessions, average hold **0.3 bars**, and no call at all since 2025-06-19. The
4 wins are real wins (3 of 4 hit T1) but a 75% win rate on four trades is not an edge — it is
an anecdote. `strategy-core/engines.js` already refuses to let it speak (thin < 30). Keep it
that way; do not quote its PF to anyone.

### GB03a — the published number was STALE, and the artifact had lost the engine
`data/terminal/backtest_results.json` as written at **09:06 today** contained the **FVG engine
only** — CODEX, SWING and ORDERFLOW were gone. `measuredRules()` reads that file, so the board
and `/api/terminal/strategies` would have published ORDERFLOW as *trades 0* and gone **silent**,
hiding a live engine whose setup is registered and firing. The file was regenerated with a full
four-engine pass at 09:59 and the board row is back:

```
rules: FVG netPF 1.940 on 73 trades SPEAKS | ORDERFLOW netPF 1.746 on 21 trades (THIN) silent
```

The canonical 2026-10-17 artifact (`backtest_results.of03v2-2026-10-17.json`) claims
**19 trades / netPF 2.093**. That run was made at 15:18 IST; `strategies/orderFlow.js` was
last written at **16:36 IST** the same day. The number describes an engine revision that is no
longer on disk, so 19/2.093 must not be quoted again — today's engine measures **21 / 1.746**
at 0.05% and **21 / 2.331** at zero cost.

### The cutoff pin is not supported by the engine it pins
`strategy-core/engines.js` pins `maxSignalTime: 1100` with the label *"57.9% win rate, netPF
2.19"*. A/B on today's engine, same corpus, same rules (`scratch/gb_cutoff_ab.js`):

```
maxSignalTime=1230  signals 36 | trades 25  win 48.0%  netPF 1.997  netR 16.0  maxDD 4.9R
maxSignalTime=1100  signals 31 | trades 21  win 52.4%  netPF 1.746  netR  9.2  maxDD 3.8R
```

The 11:00 cut buys 4.4 points of win rate and gives up **6.8R** of measured profit. Neither
side is evidence — the difference is four trades — but the label's 57.9%/2.19 is **not
reproducible on the shipped engine**, so it is a published claim with no measurement behind
it. The pin was left as-is (changing a measured configuration is the owner's call, and a
4-trade difference does not justify it); what changed is that **live now obeys the pin
instead of quietly ignoring it**:

### Live/backtest drift — fixed
`strategies/orderflow/liveMinuteEngine.js` built the OF03 engine with
`createEngine({ symbol, minAtrPct: 0.10 })` and **no `maxSignalTime`**, so the live scan ran
on the module default **12:30** while the harness — the run that justifies the engine —
stopped at **11:00**. Live could arm a call between 11:00 and 12:30 that no backtest ever
took. It now reads `strategy-core/engines.js` → `BY_KEY.ORDERFLOW.config`, and
`test/ofEngine.test.js` pins that the live config equals the measured one. (The dropped
`minAtrPct: 0.10` was a no-op: the planner reads `cfg.planner.minAtrPct`, which defaults to
0.10 anyway.)

---

## 2. The single call each GB issues

From `scratch/gb_single_call.js` — the last call each setup actually produced in the corpus,
with the plan the harness filled and the outcome it took:

| system | call | signal (IST) | entry | stop | T1 | T2 | RR1 | outcome |
|---|---|---|---|---|---|---|---|---|
| GB01 | **LONG ANTELOPUS** | 2026-09-09 09:55 | 1187.15 | 1182.41 | 1202.74 | 1212.00 | 3.29R | **STOP −1.00R** |
| GB02 | LONG AEROFLEX | 2025-06-19 11:13 | 192.00 | 191.59 | 193.29 | 193.94 | 3.18R | T1 +3.18R |
| GB03a | **SHORT ACMESOLAR** | 2026-10-05 09:48 | 439.65 | 440.31 | 437.99 | 435.77 | 2.51R | **T1 +2.51R** |

Reading it honestly:

* The only call recent enough to matter is **GB03a SHORT ACMESOLAR (05 Oct)** — it hit T1.
* GB01's last call was a stop, and its last four calls are **+6.4R, −1, −1, −1** — that is the
  shape of a 42% win rate carried by a 2R+ average winner, not a broken rule, but it is also
  three consecutive stops into the last session it spoke.
* GB02 has not produced a call in **16 months**. A "single call" from it does not exist for
  any current session; treat GB02 as an unproven, effectively dormant setup.

**There is no forward call in this file, and there cannot be one from this data**: the 1-minute
corpus ends at the 2026-10-06 close, so nothing after that date has been seen by any engine.
Monday's live call has to come from Monday's tape through the live scan — the backtest cannot
invent it, and this sheet does not pretend otherwise.

---

## 3. Residual risks left open

1. **Thin samples everywhere.** GB03a 21 trades, GB02 4, GB01 69. Only GB01 clears the repo's
   own 30-trade floor *and* the 1.5 netPF floor; GB03a clears PF but not sample.
2. **The cutoff decision is undocumented.** If 12:30 is genuinely better (+6.8R measured),
   the pin should move and the artifact re-measured in the same change. Until then live and
   backtest match at 11:00, which is the property that matters for tomorrow.
3. **`temp_trades/` is shared mutable scratch.** Any run overwrites `FVG_trades.json` /
   `ORDERFLOW_trades.json`; the per-setup sheet is only trustworthy when it is regenerated by
   `scratch/gb_single_call.js` in the same breath as its numbers.
4. **FVG live parity was not re-verified here.** The FVG setup has no registry `config`, so the
   live sweep engine's gates were not compared to the harness in this pass.

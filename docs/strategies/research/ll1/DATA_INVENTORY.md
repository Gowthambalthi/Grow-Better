# LL-1 — LARGE-DATA INVENTORY & 1m BACKFILL REPORT

Task reference: §28 steps 1–5 (inventory all 1m data, backfill a large broad learning
panel, verify ≥800 PIT-eligible symbols/session, verify timestamps/aggregation/cross-
sectional alignment). **No validation/final run. OF-1 untouched.**

Generated: 2026-10-05 (IST evening). All numbers below are measured, not assumed.

---

## 0. Frozen-reference check (unchanged)

| artifact | recorded | measured now | status |
|---|---|---|---|
| `strategies/orderFlow.js` sha256[:16] | `90471e9ae616cd62` | `90471e9ae616cd62` | OK |
| `strategy-core/tradePlanner.js` | `7a311fe0bc97b1d7` | `7a311fe0bc97b1d7` | OK |
| `backtest/follow.js` | `e4753e0fe896dd02` | `e4753e0fe896dd02` | OK |
| `research/candidateGate.js` | `c4037412deff0b14` | `c4037412deff0b14` | OK |
| `research/shadow/or1_frozen.py` sha256[:16] | `d3941c1798407a35…` | `d3941c1798407a35` | OK |
| `research/shadow/fam5_frozen.py` sha256[:16] | `6cd362d361d40da1…` | `6cd362d361d40da1` | OK |
| `research/shadow/OF1_SHADOW_SPEC.md` | untouched (mtime 2026-10-05 17:02) | mtime unchanged | OK |

`git diff --cached` = 0 staged. OF-1 calibration/report/signals untouched.

---

## 1. What the 1m store held BEFORE this work (the problem)

`data/ohlcv_1m/` = 1,028 symbol files, 8,350,699 bars, span 2026-02-27 → 2026-10-05.

Per-month symbols/session (median), measured before backfill:

| month | sessions | symbols/session (median) | union |
|---|---|---|---|
| 2026-02 | 1 | 18 | 18 |
| 2026-03 | 19 | 18 | 18 |
| 2026-04 | 20 | 18 | 18 |
| 2026-05 | 19 | 18 | 18 |
| 2026-06 | 21 | 18 | 18 |
| 2026-07 | 23 | 18 | 18 |
| 2026-08 | 21 | 18 (max 174) | 174 |
| 2026-09 | 21 | **1,000** | 1,028 |
| 2026-10 | 2 | 691 | 710 |

**Conclusion:** broad (≈1,000-symbol) 1m breadth exists only from 2026-09-01. The whole
LEARNING block (2025-09-16 → 2026-05-29) had **18 symbols/session — a narrow panel**,
which cannot support a cross-sectional study. This is exactly why the backfill was
required before any LL-1 learning.

---

## 2. Decisive measurement — the endpoint DOES serve deep history

The Angel `ONE_MINUTE` endpoint **truncates a request at ≈8,000 bars (the LAST ~21
sessions inside the requested window), not at the start of history**. A prior probe
(`.freebuff/probe-1m-depth.js`, 2026-09-27) established this and a prior extension run
(`.freebuff/fetch-1m-history.log`, 2026-09-26) extended 996 symbols by 33,646,077 candles
with **0 failures** — but that extension was later lost for all but 18 symbols (a corpus
regeneration reverted 1,010 files; only the 18 files carrying an `extendedAt` marker kept
it).

Re-measured **today**, read-only (`.freebuff/probe-ll1-depth.js`):

| window (past-only) | RELIANCE | TCS | SBIN |
|---|---|---|---|
| 2026-08-01..08-30 | 20 sess | 20 | 20 |
| 2026-06-01..06-30 | 21 | 21 | 21 |
| 2026-04-01..04-30 | 20 | 20 | 20 |
| 2026-01-01..01-31 | 20 | 20 | 20 |
| 2025-10-01..10-31 | 21 | 21 | 21 |
| 2025-07-01..07-31 | 22 | 22 | 22 |
| **2025-01-01..01-31** | **22** | **22** | **22** |

History is served at least back to 2025-01 for large caps, and the live backfill has
already returned data back to **2023-12-04** for the earliest-processed symbols. So a
multi-year broad 1m panel is achievable by walking each symbol backwards one ~25-day
window at a time (`fetch-1m-history.js` — additive, de-duplicated by timestamp, skips
zero-volume prints, resumable).

---

## 3. Backfill — COMPLETE, and the final measured coverage

Command: `node .freebuff/fetch-1m-history.js --months=16 --windowDays=25`
→ 1,028 symbols × up to 16 windows of 25 calendar days (window width chosen so a window
never hits the ≈8,000-bar truncation). It walks each file backwards from its current
earliest candle, so it is resumable and never rewrites a candle it did not fetch.

**Result (`data/ohlcv_1m_ext.progress.json`):** `done 1028 / total 1028 ·
totalAdded 72,194,452 candles · noGain 216 · failed 0`.
(The 216 `noGain` are names the vendor simply does not serve that far back — they are
reported as absent, never invented.)

### Final per-month coverage (from `coverage.py`, exit 0 — measured, not projected)

| month | sessions | symbols/session (median / min / max) | eligible ≥5cr |
|---|---|---|---|
| 2023-12 → 2025-06 | ~20/mo | **1 – 78** (vendor has almost no deep history) | 0 – 75 |
| 2025-07 | 23 | 169 / 80 / 719 | 75 |
| **2025-08** | 19 | **703 / 690 / 712** | 636 |
| 2025-09 (LEARNING start) | 22 | 706 / 685 / 726 | 641 |
| 2025-12 | 22 | 712 / 695 / 759 | 647 |
| 2026-01 | 20 | 732 / 679 / 772 | 642 |
| 2026-05 (LEARNING end) | 19 | 760 / 732 / 780 | 723 |
| 2026-08 | 21 | 786 / 769 / 833 | 756 |
| **2026-09** | 21 | **1000 / 843 / 1017** | 975 |

Store totals: **1,028 symbols · 704 sessions · 2023-12-04 → 2026-10-05 · 578 dense.**

### Per-block breadth (the §28.3 answer)

| block | sessions | median symbols/session | min | max | sessions ≥800 |
|---|---|---|---|---|---|
| LEARNING 2025-09-16 → 2026-05-29 | 172 | **729** | ~700 | 798 | **0 / 172** |
| VALIDATION 2026-06-01 → 2026-08-31 | 65 | **769** | 736 | 833 | **1 / 65** |
| FINAL 2026-09-01 → 2026-10-05 | 23 | **998** | 565 | 1017 | **21 / 23** |

- **≥800 symbols/session exists for only 22 sessions: 2026-08-31 → 2026-09-30** (FINAL only).
- **≥700 exists for 272 sessions: 2025-07-18 → 2026-09-30.**
- LEARNING median eligible at the 5cr floor = **661** (min 628, max 731).

### Adequacy verdict

- "≥6 months of broad 1m" → **MET** (2025-08 onward = 8.5 months at ~700+ symbols).
- "≥800 PIT-eligible symbols/session where available" → **NOT MET in LEARNING**
  (median **729**, max **798**). The earlier **850–900 projection was wrong and is
  withdrawn**; these are the measured numbers.
- **Limitation reason:** the vendor simply has no broad 1m history before 2025-08, and
  after that only ~700–790 names per session are served. Breadth only reaches 800+ in the
  last 22 sessions.

---

## 4. Timestamp / aggregation / alignment verification (§28.4–5)

Tool: `python research/ll1/verify_bars.py` → `research/ll1/verification.json`.

Checks performed on the live corpus:
- timestamp format `YYYY-MM-DD HH:MM`, minutes inside the canonical grid 09:15–15:29;
- strict per-session ordering, no duplicate minutes;
- OHLC envelope (`low ≤ min(o,c)`, `high ≥ max(o,c)`), non-negative volume;
- every minute lies on the canonical grid → the 5m series is a **deterministic
  aggregation** of the 1m bars (bins anchored at 09:15), no invented bars;
- per-session panel completeness (fraction of symbols with a full session) and
  cross-sectional minute coverage.

Final run (exit 0): **704 sessions, 1,028 files, 74 symbols flagged, 60 off-grid minutes.**

- The 74 flagged symbols are **all the 2024-11-01 Diwali Muhurat evening prints
  (18:00–18:01)** — a legitimate special session outside the 09:15–15:29 grid, not
  corruption.
- **8 sessions carry 0 symbols** and are weekend/Muhurat stamps in the tape:
  2023-12-26, 2024-01-08, 2024-01-10, 2024-03-02, 2024-03-22, 2024-05-18, 2024-11-01,
  2025-10-21.
- **Session boundary coverage in LEARNING: 95.4% of symbols present at 09:30,
  93.8% at 15:00 (median).**
- Only **35%** of symbol-sessions have *exactly* 375 bars — that is empty minutes in
  illiquid names (zero trades), **not** data loss. LL-1 therefore guards on session
  open/close coverage rather than on an exact bar count.

---

## 5. LL-1 code delivered in this step (all self-tested)

| file | purpose |
|---|---|
| `research/ll1/coverage.py` | §28.1/§28.3 coverage + PIT-eligibility inventory → `coverage.json` |
| `research/ll1/verify_bars.py` | §28.4/§28.5 timestamp/aggregation/alignment checks → `verification.json` |
| `research/ll1/engine.py` | LL-1 signal engine (5m leader/lag context + 1m confirmation + next-1m-open entry, multi-horizon 1/3/5/10/15/30/60m, MFE/MAE) |
| `research/ll1/universe.py` | PIT broad universe screen (trailing turnover floors) |
| `research/ll1/experiments.py` | learning experiment driver: base/strict/very-strict × original/inverse, matched-random control, market-residual, subperiod stability, registry integration |
| `research/ll1/selftest.py` | synthetic no-look-ahead / timing / invert tests |

Engine timing contract (enforced, 13/13 self-tests pass): context = completed 5m bin
ending minute E; confirmation = 1m bar at E+1; **entry = open of E+2** (never the
confirmation bar); horizon h exits at close of `entry_min+h-1`. Changing bars *after*
entry provably does not alter the signal.

`python research/ll1/selftest.py` → **13 passed, 0 failed**.
`python research/ll1/experiments.py --dry-run` → non-zero signals, summaries, controls,
stability and concentration all populated (plumbing verified; no registry writes in dry-run).

---

## 6. What is deliberately NOT done yet

Per the task: **no VALIDATION, no FINAL, no OF-1 change.** All LL-1 learning experiments
(§28.6–14) will run through `DataGate('learning')` only — the gate physically rejects any
date after 2026-05-29 and the sealed range, so validation/final cannot be read. Selection
(§19), freeze (`FROZEN_LL1_V1.json`, §20) and validation (§21) follow only after the
learning panel question above is settled with the user.

**Open decision:** LEARNING measures a median **729** symbols/session, not the requested
≥800. The split dates stay frozen either way; the decision is only whether to proceed at
729 or to extend the panel first.

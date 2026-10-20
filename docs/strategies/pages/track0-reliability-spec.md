# Track 0 — Trust the Measurements

**Status:** draft, 2026-10-01
**Scope:** make the win%/PF numbers produced by the six-strategy harness reproducible and
honest *before* any new research is funded. Track 0 changes no strategy rule; it decides
whether the existing numbers mean anything.

**Pass condition for the whole track:** every headline win% and PF quoted in
`.freebuff/STRATEGY-TUNING-REPORT.md` and `gb_scoring_v2/github/callGate.js#TUNED` can be
reproduced from a **frozen** input artifact by a **named command**, with the race entry,
tie policy and cost anchor each declared on the row.

---

## 0. Definitions (so the criteria below are unambiguous)

| Term | Meaning |
|---|---|
| **Entry anchor** | The price the race measures from: `stored` (harness entry), `call` (the price named in the call's own reason string), or `signalbar` (first 1m bar at/after the signal time). |
| **Tie policy** | Which level is assumed first when a single 1m bar spans both stop and target: `sf` = stop-first, `tf` = target-first. |
| **Resolved** | A raced row whose `hit` is `target` or `stop` (not `none`). |
| **Win%** | `target / (target + stop)` over resolved rows, wrong-side rows excluded. |
| **Phantom** | A row labelled `stop` whose `r > 0`, or `target` whose `r < 0` — a label/R inconsistency. |
| **Wrong-side** | The plan stop sits on the wrong side of the entry for the row's own `dirSign`. |
| **Set B** | `gb_scoring_v2/github/data/setB/signal_ledger_corrected_SB.json`. |

---

## 1. Baseline, measured 2026-10-01 (the numbers this track must reproduce)

### 1.1 Set B as it stands

- rows **20,000**; scorable (`dirSign` set) **2,361** — **2,196 LONG / 165 SHORT**; raced (1R present) **2,340**
- 1R stored-as-written: `none` 1,532 (65.5%) · `stop` 734 · `target` 74
- wrong-side flagged **665** · unreliable **675** · phantom (label/R) **654**
- `plan.side` disagrees with `dirSign` on **665** rows — *exactly* the wrong-side count
- **`entryAtSignal` present on 0 of 20,000 rows**

### 1.2 T5 — the tie-policy question, from `.freebuff/rerace_SB.json` (2,340 rows)

| Anchor | Raced | Resolved | Win% (stop-first) | Win% (target-first) | meanR sf | meanR tf |
|---|---|---|---|---|---|---|
| stored | 2,336 | 1,388 (59.4%) | 23.5% | 24.7% | −0.530 | −0.506 |
| call | 2,071 | 1,063 (51.3%) | **76.7%** | **77.0%** | +0.533 | +0.539 |
| signalbar | 2,333 | 1,378 (59.1%) | 24.7% | **28.6%** | −0.507 | −0.428 |

**Finding — the tie policy is a second-order knob; the entry anchor is first-order.**
Stop-first vs target-first moves Win% by **1.2–3.9 pp** and meanR by **0.02–0.08R**.
Changing the entry anchor moves Win% by **52 pp** (24.7% → 76.7%). Any Track 0 effort spent
"running T5" without fixing the anchor measures noise.

---

## 2. R0.1 — Branch hygiene and T5 (the plan's step 1)

**Why reordered:** the race fix and the universe change are stacked in one working tree
(`git status` shows thousands of modified paths). Landing them together makes a scoring
change un-bisectable.

- **R0.1a** Move the race fix to its own branch, **race fix first**, universe change second,
  each with a test that fails before and passes after. Stage by path/hunk — never `git add -A`.
- **R0.1b** Run T5 as a **first-class reported column**, not a one-off: every race result
  carries `{anchor, tiePolicy, hit, r}`. Accept the existing `.freebuff/rerace_SB.json`
  as the T5 baseline; no re-run required to record it.

**Pass/fail**
- PASS: the race fix is one commit on its own branch; `node --test` is green on that branch alone.
- FAIL: any strategy value, threshold or universe file rides in the race-fix commit.

---

## 3. R0.2 — Harness ↔ live race parity (the plan's step 2)

**Verified 2026-10-01.** `gb_scoring_v2/github/strategies/backtest-harness.js` implements
**no race**. It reads `outcome.races[1R|2R|4R]` from Set B and defines a win as
`hit === 'target' || (hit === 'stop' && r > 0)`. Set B's races were written by
`writeCorrected()` in `.freebuff/flip-test2-fixed.js`, which **copies rows and only flags**
wrong-side/phantom. So the harness and the live race in `common/market/signalLedger.js`
share the tie-break *by construction* — the same code wrote both.

**The one real divergence is the entry/cost anchor:**

- the race measures from `entryAtSignal`/the signal bar;
- the harness sets `entry = num(r.ltp)` and `riskPct = plan.riskPct`, so
  `costR = 0.0015 / (riskPct/100)`.

Because **`entryAtSignal` is absent from Set B (0/20,000)**, the harness's entry cannot be
reconciled to the entry the race actually used. **This is the defect that can move a rule
across the 50% line**, and it is invisible in `grossPF` while it corrupts `netPF`.

- **R0.2** Make the arm explicit: the harness must read the race's **own** `entry`
  (`r.outcome.entry`) and the race's **own** `risk` (`entry − stop` from the same row), or
  refuse the row with reason `entry-not-carried` when neither is present.
- **R0.2b** Add a parity test asserting `netPF` is invariant when only `plan.riskPct` is
  perturbed — if it moves, the cost anchor is still wrong.

**Pass/fail**
- PASS: every raced row in the harness carries `entrySrc`; no row uses `ltp` as the race entry.
- FAIL: any row whose `costR` changes when `plan.riskPct` is nulled.

---

## 4. R0.3 — Re-race into a new artifact; resolution rate; wrong-side producer

### 4.1 Resolution rate — measured, and the plan's number does not reconcile

Measured on the re-race artifact: **59.4% of stored-anchor raced rows resolve**
(1,388/2,336); the call-anchor subset resolves **51.3%** (1,063/2,071). Re-scorable rows:
**2,336 of 2,340 (99.8%)** — `data/ohlcv_1m/` covers 21 sessions vs the ledger's 5, so
coverage is not the constraint.

**Open discrepancy:** the plan cites an **8.6% resolution rate**. It does not appear in
`.freebuff/rerace_SB.json`, `.freebuff/rerace.log`, or Set B. **Resolve this before
proceeding** — an 8.6% and a 59.4% reading imply very different amounts of usable data.
Do not restate 8.6% in any report until it is sourced.

### 4.2 Wrong-side producer — root cause found

`plan.side` disagrees with `dirSign` on **665 of 665** wrong-side rows. The defect is a
**plan-join**, not a race: the attached `plan` belongs to the *opposite* side, so `plan.stop`
sits across the price and the first bar trips it. Measured previously: 100% of the flagged
rows are `dirSign=+1` (LONG) carrying `plan.side='SHORT'`, and **zero** reverse cases.

- **R0.3** Write the re-race to a **new** file (never overwrite Set B): `setB_rerace_v1.json`,
  with a schema version and a `generator` string naming the script and its hash.
- **R0.3b** Fix the plan join so a row's plan carries the side matching `dirSign`, and
  re-count wrong-side (target: **0**).
- **R0.3c** Report `resolved / raced` and `resolved / total` separately on every table.

**Pass/fail**
- PASS: wrong-side count is 0 on `setB_rerace_v1.json`; resolution is reported against a named denominator.
- FAIL: any wrong-side row enters a win%, or the re-race overwrites Set B in place.

---

## 5. R0.4 — Freeze Set B (the plan's step 4)

- **R0.4** Produce `setB_frozen_<yyyy-mm-dd>.json` plus a sidecar manifest:
  `{ sha256, rows, schemaVersion, generator, generatorHash, raceWindowBars, anchors, tiePolicy, createdAt }`.
- Every downstream table prints the manifest hash. A number without its hash is not quotable.

**Pass/fail**
- PASS: re-running the generator from the frozen input reproduces the same hash.
- FAIL: any published win% whose input artifact is not frozen and hashed.

---

## 6. Knobs (nothing hard-coded)

| Knob | Env / CLI | Default | Meaning |
|---|---|---|---|
| Race window | `RACE_WINDOW_BARS` | 20 | Bars the race may run |
| Tie policy | `RACE_TIE_POLICY` | `sf` | `sf` stop-first / `tf` target-first |
| Entry anchor | `RACE_ANCHOR` | `signalbar` | `stored` / `call` / `signalbar` |
| Targets raced | `R_RACE` | `1,2,4` | R multiples raced against one stop |
| Cost floor | `COST_FLOOR_PCT` | 0.15 | Round-trip cost, % of price |
| Min resolved | `MIN_RESOLVED` | 200 | Below this a win% is `THIN`, not a record |
| Stream/pool caps | `GB_STREAM_MAX` | 600 | Unchanged; out of Track 0 scope |

## 7. Splits (fixed before any result is read)

- **Development:** sessions 2026-09-24 → 2026-09-28 (the ledger's own early sessions).
- **Hold-out:** 2026-09-29 → 2026-09-30, plus any session written after the freeze.
- **Symbol split:** the `dirSign` mix is **93% LONG** (2,196/165). Report LONG and SHORT
  separately on every line; a pooled Win% on this mix is a LONG number wearing a neutral label.

## 8. Track 0 exit gate (decides whether Track A is funded)

All must hold:

1. Set B frozen + hashed; downstream tables print the hash.
2. Every raced row carries `anchor`, `tiePolicy`, `entrySrc`, and the race's own `entry`.
3. Wrong-side count **0**; phantom count **0**; `unreliable` rows excluded and counted.
4. Headline win%/PF in the tuning report and `callGate.js#TUNED` reproduce from the frozen artifact.
5. The 8.6% discrepancy is sourced or withdrawn.
6. `netPF` is invariant to perturbing `plan.riskPct` (cost-anchor fix proven).

**If any fails, Track A does not start.** A negative Track 0 is itself publishable (Track C)
and still worth more than a positive-looking number nobody can reproduce.

## 9. Known limitations to state, never hide

- `orb` is under-sampled (19 trades / 3 resolved) — its 66.7% is `THIN`.
- `liqOrb` / `smcLuxalgo` fire zero trades on this data; they need engine-side logging.
- `entryAtSignal` is stamped by `record()` but is absent from Set B; live rows must carry it
  forward before any live win% is quoted.

# S2 EXHAUSTION/FADE — VALIDATION HARNESS REPORT

> ## FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.
> This string is emitted by the harness itself (`frozenConclusion` in [data/terminal/s2-validation.json](data/terminal/s2-validation.json))
> and does not change until genuinely unseen sessions survive deduplication, cost and
> tail-removal checks. One good unseen session must not promote it.

**No strategy implemented. No V4. OF01/OF03 and Phase 5A untouched. No threshold changed. No production change.**

Harness: [research/s2Validation.js](research/s2Validation.js) (fully deterministic, **no tunable parameter in the file**) · manifest: [research/s2-discovery-manifest.json](research/s2-discovery-manifest.json) · raw: [data/terminal/s2-validation.json](data/terminal/s2-validation.json)

## ⚠️ STATUS: OUT-OF-SAMPLE VALIDATION IS **BLOCKED**

> `STATUS: SESSION_HELD_OUT (in-sample) — NOT out-of-sample validation: no unseen session tape exists`

I checked the data before running anything. The tape directory contains **only the same four discovery sessions**: `ticks-2026-09-28 … 10-01` (plus `replay-*` files for those same four days, which are the same sessions and would be double-counting, not new data). Today is 2026-10-04 (Sunday); the next market session, 2026-10-05, has no tape.

**Therefore the requested genuinely-unseen-session validation cannot be performed, and the harness says so itself.** It compares each requested session against the frozen discovery set **and its content** and only prints `GENUINE OUT-OF-SAMPLE` when a tape exists that was neither a discovery date nor a byte-copy of one.

The harness is **frozen and ready** — it will run on the first unseen session with zero changes and no threshold to tune.

## Frozen hypothesis (unchanged)

Exhaustion/fade of a meaningful extension, entered at the event:

| item | value |
|---|---|
| Extension state | `r20`, `r60` same-signed, both │·│ ≥ 0.30% |
| Meaningful | **│r20│ ≥ 0.50% — PRE-REGISTERED, unchanged** |
| Entry | tick where a new extension episode starts (fast, at the event) |
| Direction | **fade (exhaustion), not continuation** |
| Episode/cooldown | one entry per continuous episode per symbol; 15 s |
| Outcome | horizons 30s/60s/2m/5m, primary 60s, risk 0.20%, cost 0.05% |

## 9. Number of truly independent observations (reported first, because it frames everything)

| measure | value |
|---|---|
| raw trades | 10,519 |
| **independent 60s buckets** | **1,232** |
| **independent 5-minute buckets** | **274** |
| symbol-sessions | 2,369 |
| symbols / sessions | 1,183 / **4** |
| mean / max cluster size (60s) | 8.54 / 188 |
| **inflation factor (raw ÷ independent)** | **8.54×** |

The raw count overstates independent evidence by **8.5×**, and the independent sample spans only **4 sessions**.

## 1–5, 6, 7, 8 — all requested outputs (session-held-out, in-sample)

**1. Raw:** **+0.447 R** net, n=10,519, net PF **1.62**
**2. One per 60-second bucket:** **+0.343 R**, n=1,232, net PF 1.48
**3. One per 5-minute bucket:** **+0.166 R**, n=274, net PF 1.19
**4. One per symbol-session:** **+0.145 R**, n=2,369, net PF 1.22
**5. Removing top trades:** top 1% → +0.214 · **top 5% → −0.100** · **top 10% → −0.333**
*(cluster-mean estimators, a second effective-sample view: 60s **+0.363** · 300s **+0.307**. Top 10% of trades carry **167.1%** of total net R.)*

**6. Per session** (raw netExpR / n · **one-per-60s** netExpR / n):

| session | raw | **independent (60s)** |
|---|---|---|
| 2026-09-28 | −0.067 / 1,281 | **−0.255** / 314 |
| 2026-09-29 | +0.226 / 1,669 | **−0.009** / 352 |
| 2026-09-30 | +0.530 / 5,477 | **+1.141** / 290 |
| 2026-10-01 | +0.721 / 2,092 | **+0.634** / 276 |

**On the independent (deduplicated) basis only 2 of 4 sessions are positive.** The raw per-session view (3/4 positive) is materially more flattering than the deduplicated one.

**7. Long vs short:** long **+0.650** (n=4,837) · short **+0.275** (n=5,682). Both positive; longs ~2.4× stronger.

**8. Cost / slippage sensitivity:**

| total cost | netExpR |
|---|---|
| 0.05% (base, no slippage) | **+0.447** |
| 0.07% (+2 bp slippage) | +0.347 |
| 0.10% (+5 bp slippage) | +0.197 |
| **0.15% (+10 bp slippage)** | **−0.053** |

Cost-only levels: +0.697 / +0.597 / +0.447 / +0.197 / −0.303 at 0 / 0.02 / 0.05 / 0.10 / 0.20%.

## Verdict

The requested test **did not run**, because it cannot: no unseen session exists. The partial, in-sample, session-held-out evidence is **mixed**:

| gate | status |
|---|---|
| genuinely unseen sessions | ❌ **not possible today** |
| survives deduplication (aggregate) | ✅ +0.343 / +0.166 / +0.145 — positive, but far weaker than raw |
| survives deduplication (per session) | ❌ **only 2/4 positive** |
| not a few-trade artifact | ❌ top 5% removal → negative; top 10% carry 167% of net R |
| survives realistic cost + slippage | ⚠️ positive to ~0.10% total, **negative at 0.15%** |
| no single-hour dependency | ✅ (all 7 hourly buckets positive; unchanged) |

**Recommendation: do NOT promote, do NOT reject yet.** The primary out-of-sample test has not happened, so the decision rule ("if it fails, reject; if it survives, proceed") is not yet satisfied in either direction. But the independence-based evidence leans negative, and the two known fragilities are quantified:

1. **Session robustness collapses under deduplication** (2/4).
2. **Severe tail dependence** — the top 5–10% of trades decide the sign.

**If the first unseen session reproduces this per-session deduplicated pattern (roughly half positive, tail-dependent), the hypothesis should be rejected.** If it reproduces the strong sessions (09-30/10-01) on an independent basis, it can proceed to the next research phase. One good unseen session is not promotion.

## Repairs made during this stage (harness correctness — not methodology)

These change **no** threshold, cooldown, episode rule, entry rule, cost or deduplication rule. They make the frozen methodology *actually* reproducible.

1. **Session isolation (the consequential one).** Per-symbol state (`hist`, `inEpisode`, `lastEntryTs`) and the outcome tracker were created **once, outside the day loop**, so they leaked across the session boundary. `priceAt()` returns the last tick `≤ target`, including one from ~15 h earlier, so a stale overnight price fabricated an extension at the next open. Effect: `2026-10-01` reported **n=2,226 pooled vs n=2,092 standalone**, and every per-session number depended on which other sessions were loaded. `state` and the tracker are now **created fresh inside the day loop**, and rows are accumulated per session. The same defect existed in [research/s2Candidate.js](research/s2Candidate.js) and was fixed there identically, so the harness and the pre-registered tool now agree **exactly** (raw +0.447 / one-per-60s +0.343 / one-per-300s +0.166 / one-per-symbol-session +0.145; per-day 1,281 / 1,669 / 5,477 / 2,092).
2. **Deterministic estimator selection.** `one-per-bucket` and `one-per-symbol-session` originally used settlement (insertion) order. They now select **earliest ts, then symbol** (the pre-registered rule). All rows are sorted `(ts, symbol)` after collection, so the report is **byte-identical regardless of request order** — verified by running the four sessions forward and reversed.
3. **Content duplicate / overlap guard.** The harness now fingerprints the four discovery tapes (`--gen-manifest` → [research/s2-discovery-manifest.json](research/s2-discovery-manifest.json)) and classifies every requested session:

| classification | meaning |
|---|---|
| `IN_SAMPLE` | the DATE was part of discovery |
| `DUPLICATE_CONTENT` | a "new" date whose sha256 equals a discovery tape (copy/rename) → **`BLOCKED`** |
| `UNSEEN` | new date **and** content → only these count as out-of-sample |
| | status is `GENUINE OUT-OF-SAMPLE`, `MIXED`, or `BLOCKED` accordingly |

A same-day `replay-*.jsonl` alongside an unseen tape also raises a warning. The four discovery days each have a `replay-*` present, so the guard reports `replayPresent: true` for them.

Regression test: [test/s2Validation.test.js](test/s2Validation.test.js) builds synthetic tapes in a temp dir and pins session isolation, order invariance, the duplicate/`BLOCKED` path, the in-sample path, the replay warning and the manifest fingerprints. It was confirmed to **fail** against the pre-fix (leaking) code and pass after the fix.

## Limitations

- **No unseen session exists** — this is the central limitation; everything here is session-held-out, in-sample.
- Only 4 sessions and 1,232 independent minutes; one market regime.
- The harness's 15 s cooldown and episode rule are part of the frozen pre-registration; they were not re-examined.
- Replay files for the discovery days are identified and excluded as duplicates rather than used as extra data.
- **The stage-2 diagnosis tools share the same cross-session leak** ([research/s2Stages.js](research/s2Stages.js) creates `state`/trackers outside its day loop). Their qualitative conclusion (the edge exists before the trigger and the trigger destroys it) is unaffected, but their absolute per-stage numbers should be re-derived before being cited as corroboration. Only the frozen harness and the pre-registered candidate carry the fix so far.

## How to run the first genuinely unseen session

```bash
node research/s2Validation.js            # uses every tape present; classifies it
node research/s2Validation.js --days=YYYY-MM-DD
```

If it prints `GENUINE OUT-OF-SAMPLE`, read the **one-per-60s**, **one-per-5m**, **one-per-symbol-session**, **per-session** and **tail-removal** lines. Do **not** tune anything between sessions.

**STOP.** No thresholds were optimized after seeing these results. The harness is frozen and will run unchanged on the first unseen session tape.

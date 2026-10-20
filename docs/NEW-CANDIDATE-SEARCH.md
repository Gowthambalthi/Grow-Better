# NEW CANDIDATE SEARCH — SCALPING & INTRADAY — READ-ONLY

> **FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**
> No strategy implemented. No V4. OF01/OF03 and Phase 5A untouched. No production wiring. No automatic orders. Nothing moved to live. No threshold tuned toward a target PF or win rate.

**S2 is untouched and stays frozen** — no threshold, cooldown, dedup, entry rule or harness change; the discovery tapes are not presented as out-of-sample; the frozen harness will consume the next unseen session unchanged.

**Gate (mandatory first filter):** [research/candidateGate.js](research/candidateGate.js) · [test/candidateGate.test.js](test/candidateGate.test.js) (12/12 pass)
**New tools (read-only):** [research/scalpSeq.js](research/scalpSeq.js) · [research/intradaySeq.js](research/intradaySeq.js) · [research/gateInputs.js](research/gateInputs.js)
**Raw results:** [data/terminal/scalp-new-candidates.json](data/terminal/scalp-new-candidates.json) · [data/terminal/intraday-new-candidates.json](data/terminal/intraday-new-candidates.json)

Every candidate: **HYPOTHESIS → full historical test → after-cost gate → KEEP/REJECT.** One hypothesis, one logical change. No filter stacking, no parameter sweep, no rescue.

---

# PART 1 — SCALPING

**Data:** the four discovery tapes (2026-09-28…10-01), 16,134,718 ticks, in-sample.
**Honesty note:** these are the only sub-minute sessions that exist. This search is explicitly **exploratory and in-sample** — it is *not* validation and nothing from it may be promoted. The frozen S2 harness remains the only path that will consume unseen tape.

Six new event sequences, all entering **at the event** rather than after confirmation:

| # | candidate | hypothesis |
|---|---|---|
| N1 | `N1_EXPANSION_ONSET` | compression → the first tick that breaks the box (no burst confirmation) |
| N2 | `N2_PULLBACK_RESET` | impulse → controlled pullback → first up-tick off the low |
| N3 | `N3_FRESH_EXTREME_RECLAIM` | a fresh 10s extreme reclaimed = failed move |
| N4 | `N4_EXTREME_FIRST_COUNTER` | any extension ≥0.30%, the **first** counter-tick fires the fade |
| N5 | `N5_MEANINGFUL_FIRST_COUNTER` | **meaningful** extension (│r20│≥0.50%, │r60│≥0.30%) + first counter-tick |
| N6 | `N6_MEANINGFUL_IMPULSE_RESET` | **meaningful** impulse (≥0.50%) → pullback → enter at the reset |

### Strongest 4 — evidence and gate

| verdict | candidate | n (indep) | netExpR | netPF | win | posSess | gate result |
|---|---|---|---|---|---|---|---|
| **REJECT** | `N4_EXTREME_FIRST_COUNTER` | 24,194 (20,228) | **−0.202** | 0.67 | 51.9% | 0/4 | reject — negative after cost |
| **REJECT** | `N5_MEANINGFUL_FIRST_COUNTER` | 5,774 (4,926) | **−0.208** | 0.79 | 52.4% | 1/4 | reject — negative after cost |
| **REJECT** | `N2_PULLBACK_RESET` | 121,363 (86,690) | −0.317 | 0.44 | 43.1% | 0/4 | reject |
| **REJECT** | `N1_EXPANSION_ONSET` | 140,394 (130,620) | −0.358 | 0.31 | 36.1% | 0/4 | reject |

`N6_MEANINGFUL_IMPULSE_RESET` −0.370 (n=13,521) and `N3_FRESH_EXTREME_RECLAIM` −0.373 (n=324,904) also reject.

### What scalping actually established — the event sequence, measured

The one thing known to precede the profitable move is the **meaningful extension**. This search tested what happens when you wait *one step* for it to start reversing:

| entry event | netExpR | source |
|---|---|---|
| **the meaningful extension event itself** (S2's frozen object) | **+0.447** | S2, 1,232 indep events — *frozen, not re-run* |
| the **first** counter-tick after a meaningful extension (`N5`) | **−0.208** | this search |
| the first counter-tick after *any* extension (`N4`) | −0.202 | this search |

> **The edge is entirely in the event, not the confirmation.** Waiting a single counter-tick to "see the fade start" costs ≈0.65 R and flips the sign. N4 shows the magnitude filter alone is not the whole story either: the *meaningful* event is what pays, and only while it is happening.

**Scalping verdict: no new candidate clears the gate.** Every early-entry structure is negative after cost. The mechanism is confirmed but no promotable candidate emerged. **Frozen — NOT VALIDATED, NOT DEPLOYED.**

---

# PART 2 — INTRADAY

**Data:** the 1m corpus — 1,028 symbols, 23,766 symbol-sessions, 6,350,921 bars, 145 sessions (2026-02-27 → 2026-09-30). In-sample. **A 10s/20s trigger is NOT claimed or validated** — the corpus has no sub-minute data.

Five new sequences following **HTF context → impulse → pullback/reset → timely trigger → entry**, each entering earlier than a confirmation bar:

| # | candidate | hypothesis |
|---|---|---|
| M1 | `M1_CONTEXT_PULLBACK_RESET` | up context → controlled pullback → first up-close off the low |
| M2 | `M2_COMPRESSION_EXPANSION_1M` | tight 15-bar range → the expansion bar itself |
| M3 | `M3_EXTENSION_FIRST_REVERSAL` | large extension (≥1.0%) → the **first** counter-close (fade) |
| M4 | `M4_IMPULSE_BAR_CONTINUATION` | trend context + strong impulse bar, away from the extreme (no-chase control) |
| M5 | `M5_MEANINGFUL_CONTEXT_RESET` | as M1 but the **context** must itself be meaningful (≥0.50%) |

### Strongest 5 — evidence and gate

| verdict | candidate | n (indep) | netExpR | netPF | win | posSess | top-10 tail | gate result |
|---|---|---|---|---|---|---|---|---|
| **REJECT** | `M3_EXTENSION_FIRST_REVERSAL` | 35,452 (26,510) | **+0.052** | 1.03 | 50.9% | 60% | **1850.6%** | reject — tail-dominated |
| **REJECT** | `M2_COMPRESSION_EXPANSION_1M` | 343,195 (207,393) | −0.322 | 0.61 | 45.6% | 3% | n/a | reject — negative |
| **REJECT** | `M1_CONTEXT_PULLBACK_RESET` | 62,817 (58,364) | −0.365 | 0.71 | 41.8% | 22% | n/a | reject — negative |
| **REJECT** | `M5_MEANINGFUL_CONTEXT_RESET` | 30,423 (28,630) | −0.372 | 0.73 | 40.9% | 23% | n/a | reject — negative |
| **REJECT** | `M4_IMPULSE_BAR_CONTINUATION` | 151,841 (115,486) | −0.654 | 0.60 | 39.4% | 4% | n/a | reject — negative |

### M3 — the only positive-after-cost intraday structure, and why it still fails

`M3` is the *first* counter-close after a ≥1.0% extension. It is the only candidate in either track that is positive after realistic cost, and it is the only one with decent session coverage:

| evidence | value |
|---|---|
| net expectancy @0.05% | **+0.052 R** |
| net PF | 1.03 |
| positive sessions | **87/145 (60%)** |
| cost curve | +0.302@0 → +0.202@0.02 → **+0.052@0.05** → −0.198@0.10 |
| long / short | +0.327 (n=13,668) / **−0.120** (n=21,784) |
| tail | top1 **404%**, top2 **653%**, top5 **1202%**, top10 **1851%** of net R |

> **GATE: REJECT.** Fatal: **top-10% tail share 1850.6% ≫ 92%** — the entire positive aggregate is a handful of large winners; the remaining 90% of trades average about −1 R. It also fails side stability (shorts negative) and fails double cost. It is *the same disease as S2*, worse.

`M2`, `M1`, `M5`, `M4` are all clearly negative after cost. Notably, **M2 (compression → expansion at the bar) and M4 (impulse bar) are strongly negative** — entering on the expansion/impulse itself is precisely the *no-chase* failure the diagnosis predicted.

**Intraday verdict: no new candidate clears the gate.** The best structure is positive but tail-dominated and side-unstable; every context/reset/compression structure is negative after cost. **Frozen — NOT VALIDATED, NOT DEPLOYED.**

---

# PART 3 — CONCLUSIONS

1. **No new candidate passed the gate on either track** — independently gated, independently failed. Nothing is frozen for live shadow.
2. **The event-before-the-move is now measured, not assumed (scalping):** the edge lives in the **meaningful extension event itself** (+0.447) and is destroyed by waiting one counter-tick (−0.208). Confirmation is not free; it is the entire cost.
3. **The event-before-the-move (intraday):** the only positive-after-cost structure is the **first counter-close after a large extension** (+0.052, 60% sessions positive), but it is dominated by a tiny number of winners — a fragile, not robust, edge.
4. **No candidate was tuned toward a target PF or win rate.** Thresholds were pre-declared; the two meaningful filters (0.50% scalping, 0.50% context) came from the prior diagnosis, not from fitting these results.
5. **What would actually advance either track:** genuinely unseen sessions. For scalping, unseen tick tape consumed by the frozen harness; for intraday, either more unseen 1m sessions or real sub-minute history. Until then *every* number here is in-sample.

**STOP.** No threshold optimised. No candidate implemented. Nothing wired into [scripts/buildBoard.js](scripts/buildBoard.js). No V4.

---

## Constraint verification

| check | result |
|---|---|
| S2 harness (`research/s2Validation.js`, `s2Candidate.js`, `s2Robustness.js`, `s2Stages.js`) modified | **no** ✅ |
| `strategies/orderFlow.js` `90471e9ae616cd62` · `tradePlanner` `7a311fe0bc97b1d7` · `follow` `e4753e0fe896dd02` | unchanged ✅ |
| `cmp strategies/orderFlow.js strategies/frozen/orderFlow.of01v2-of03v1.js` | byte-identical ✅ |
| V2 engine hashes vs `.freebuff/v2-hashes-before.json` | 8/8 unchanged ✅ |
| `grep -c "research/" Server.js` | 0 ✅ |
| gate tests / full suite | 12/12 and 309/309 pass ✅ |
| OF01/OF03 modified · V4 created · anything live | **no / no / no** ✅ |

**Limitation:** the scalping search necessarily re-reads the four discovery tapes (the only sub-minute data), so its results are exploratory and in-sample and must not be treated as validation. The frozen S2 harness is unchanged and remains the sole consumer of the next unseen session.

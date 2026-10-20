# STAGE-2 DIAGNOSIS — READ-ONLY

**No strategy implemented. No V4. Frozen OF01/OF03 untouched. Phase 5A untouched. No going live. No threshold optimization.**

Tools: [research/s2Stages.js](research/s2Stages.js) · [research/i1Stages.js](research/i1Stages.js)
Data: [data/terminal/s2-stage-diagnosis.json](data/terminal/s2-stage-diagnosis.json) · [data/terminal/i1-stage-diagnosis.json](data/terminal/i1-stage-diagnosis.json)

Both tools follow **one setup episode** through its stages and measure forward expectancy at *each* stage, then conditionally on the structural features. Constants are pre-declared; the full conditional curves are reported so no cut point is hidden. **No search over thresholds was performed.**

> **Re-derived 2026-10-04 with the proven session-isolation rule** (fresh per-session price history / episode state / cooldown / outcome tracker, deterministic `(ts, symbol)` row order). See *What the session-isolation correction changed* at the end. S2 numbers moved slightly; I1 numbers are **numerically identical** to the earlier run.
> **The corrected numbers remain IN-SAMPLE: four discovery sessions, no unseen tape. FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**

---

## THE HEADLINE, IN ONE LINE

> **In both systems the edge exists BEFORE the trigger, and the trigger destroys it.** Every additional condition we wait for (deceleration → reversal trigger; re-acceleration) makes the entry later and worse. The problem was never the market state — it is the entry timing.

---

# SCALPING — S2_EXTENSION_REVERSAL

Episode funnel (4 tapes, 16.13M ticks): **50,645 extensions → 23,322 decelerated → 6,762 triggered**; 27,206 (54%) never decelerated at all.

## Where the expectancy is lost

Same episodes, forward expectancy measured at each stage:

| stage | n | win% | grossPF | netPF | expR | **netExpR** | avgMFE | avgMAE |
|---|---|---|---|---|---|---|---|---|
| EXTENSION (enter at the event) | 50,645 | 55.4% | 1.61 | 1.11 | +0.319 | **+0.069** | 0.514 | −0.407 |
| **EXTENSION_MEANINGFUL** (≥0.50%) | 11,251 | 50.4% | **2.15** | **1.61** | +0.702 | **+0.452** | 0.692 | −0.434 |
| DECELERATION | 23,322 | 52.7% | 1.48 | 1.00 | +0.248 | −0.002 | 0.486 | −0.407 |
| TRIGGER (= the current S2 entry) | 6,762 | 52.6% | 1.05 | 0.74 | +0.033 | **−0.217** | 0.520 | −0.539 |
| EVENT_E1 (meaningful, at trigger) | 2,478 | 53.1% | 1.09 | 0.78 | +0.063 | −0.187 | 0.555 | −0.531 |

**The edge is monotonic in earliness.** Gross expectancy falls +0.319 → +0.248 → +0.033 R as we wait from extension to deceleration to trigger. The immediate follow-through confirms it: the mean **5-second** forward move is **+0.0337% at the extension but +0.0017% at the trigger** — by the time the trigger fires, the move is already spent, and cost turns a +0.03R gross edge into −0.22R net.

Per-day netExpR (single-day gate):

| stage | 09-28 | 09-29 | 09-30 | 10-01 |
|---|---|---|---|---|
| EXTENSION | −0.092 | +0.057 | +0.105 | +0.130 |
| **EXTENSION_MEANINGFUL** | −0.039 | +0.218 | **+0.552** | **+0.668** |
| TRIGGER | −0.176 | −0.113 | −0.303 | −0.157 |
| EVENT_E1 | −0.117 | −0.097 | −0.295 | −0.060 |

The extension is positive on **3/4** sessions; the trigger is negative on **4/4**. This is a mechanism, not a single-session artifact.

## TOP 3 ways to make S2 more selective / profitable

**1. Enter on the EXTENSION event itself, not on the trigger.** *(evidence: stage table, 5s drift, per-day)*
- **Mechanism:** the reversal move is already partially realized when the deceleration+trigger complete. The 5s forward drift collapses from +0.034% to +0.002%, and price drifts *away* from the extreme as we wait. Acting at the extension captures the move while it still has room; requiring deceleration and a trigger is, by construction, a *late* entry. The extension point also sits closest to the extreme (`distExtreme < 0.05%`: +0.091 netExpR).

**2. Require a MEANINGFUL extension magnitude — this is the selectivity lever.** *(evidence: conditional curve)*

| \|r20\| at extension | n | netExpR |
|---|---|---|
| ≥0.30% | 39,394 | −0.042 |
| ≥0.50% | 8,677 | **+0.101** |
| ≥1.00% | 1,818 | **+0.940** |
| ≥2.00% | 756 | **+3.381** |

- **Mechanism:** cost is roughly fixed (~0.05% + spread), so only events whose *expected* move exceeds it can pay. The event population is dominated by extensions too small to matter — **54.5% of triggers are the `TOO_SMALL` class (net −0.230, gross PF 1.03)**. A natural break appears at ≈0.5%; above it the structure is net-positive. Note the deep-extension cells (≥1%, ≥2%) have smaller samples and should be treated as promising rather than proven.

**3. Add an immediate-failure invalidation (a management rule, NOT an entry filter).** *(evidence: classification)*

| class | n | share | win% | grossPF | netPF | netExpR |
|---|---|---|---|---|---|---|
| GOOD_REVERSAL | 1,980 | 29.3% | 61.9% | 2.33 | 1.55 | +0.279 |
| TOO_SMALL_TO_TRADE | 3,686 | 54.5% | 52.7% | 1.03 | 0.70 | −0.230 |
| TOO_LATE | 488 | 7.2% | 49.4% | 0.94 | 0.73 | −0.319 |
| **FALSE_REVERSAL** | 608 | 9.0% | 25.2% | 0.20 | 0.15 | **−1.666** |

- **Mechanism:** 9% of triggers are immediate failures (price resumes the extension) and they carry essentially the whole loss tail (−1.67R each). Removing them turns the remainder net-positive without needing to predict them in advance — a short, time-boxed invalidation.
- **Honesty caveat:** `FALSE_REVERSAL` is defined using the **15-second post-entry move**. That is post-entry information, so it is an **exit rule, not an entry filter** — it cannot be used to select entries. Reported as a management need.

---

# INTRADAY — I1_TREND_PULLBACK_CONTINUATION

Funnel (1m corpus, 1,028 symbols, 23,766 symbol-sessions, 145 sessions): **343,332 contexts → 103,339 pullbacks → 27,159 entries**.

## Where the expectancy is lost

| stage | n | win% | grossPF | netPF | expR | **netExpR** | 1m forward |
|---|---|---|---|---|---|---|---|
| CONTEXT | 343,332 | 40.6% | 0.72 | 0.57 | −0.348 | −0.598 | −0.0325% |
| PULLBACK | 103,339 | 46.5% | **1.07** | 0.85 | **+0.071** | −0.179 | +0.0330% |
| ENTRY (= current I1) | 27,159 | 40.0% | 0.86 | 0.70 | −0.181 | −0.431 | −0.0194% |

**Identical finding to scalping:** context alone is strongly negative; the **pullback** is the one gross-positive stage; and the **re-acceleration trigger makes it worse** (gross PF 1.07 → 0.86, expR +0.071 → −0.181). The entry's mean 1m forward move is **−0.0194%**, i.e. the current trigger is slightly *negatively* predictive at the horizon it trades.

| class | n | share | win% | grossPF | netPF | netExpR |
|---|---|---|---|---|---|---|
| GOOD | 13,777 | 50.7% | 44.0% | 1.21 | 0.98 | −0.029 |
| TOO_LATE | 8,954 | 33.0% | 38.4% | 0.79 | 0.64 | −0.513 |
| TOO_SMALL | 2,197 | 8.1% | 45.4% | 1.06 | 0.84 | −0.188 |
| FALSE | 2,231 | 8.2% | 16.5% | 0.16 | 0.14 | **−2.827** |

Per-day: **ENTRY is negative on every sampled session (0/8)**; PULLBACK is mixed (−0.275/+0.147/−0.190/+0.277/+0.219/−0.174/+0.934, and its **largest** bucket at +0.018). So I1's entry stage is *robustly* negative, while the pullback's gross edge is *not robust*.

## TOP 3 ways to improve I1

**1. Remove the re-acceleration trigger — the pullback point is the better entry.** *(evidence: stage table, 1m drift, per-day)*
- **Mechanism:** a 1m re-acceleration bar is confirmation *after* the resumption already began. The delay costs more than the confirmation adds (gross PF 1.07 → 0.86; 1m drift −0.0194%). This is the scalping trigger finding one timeframe up.
- **Entry delay does not rescue it:** netExpR is negative in every delay bucket — ≥2 bars −0.481, ≥4 −0.436, ≥8 −0.422 — and 17,861 of 27,159 entries are already ≥8 bars late. The trigger is not merely mistimed by a little; it carries no edge at any delay.
- **Important:** the pullback's gross edge is thin (largest bucket ≈ +0.018 netExpR), so deleting the trigger is **necessary but not sufficient** — it moves toward break-even, it does not clear cost.

**2. Suppress the late/chase majority — distance from the prior extreme and impulse size.** *(evidence: conditional)*
- `distExtreme < 0.10%`: 8,954 entries (33.0%), netExpR **−0.513** — the worst bucket, and it is the `TOO_LATE` class.
- `distExtreme ≥ 0.10%`: −0.317; `impulseSize ≥ 2%`: **−1.294** vs `impulseSize < 0.3%`: −0.183; `pullbackDepth ≥ 0.8%`: **−1.465**.
- **Mechanism:** entering continuation when price is already near the extreme, or after an unusually large context move (or an unusually deep pullback), *is the no-chase failure mode*. The pullback must genuinely reset distance from the extreme, and large context moves mean-revert rather than continue.

**3. Gate on volatility/orderliness and cut the immediate-failure tail.** *(evidence: splits + classification)*
- orderly pullback netExpR −0.395 vs **violent −0.629**; `volPct ≥ 0.5%`: **−1.453** vs `≤0.1%`: −0.289.
- `FALSE` class: 8.2% of entries, win 16.5%, PF 0.16, netExpR **−2.827**; `GOOD` PF 0.98 (≈ break-even).
- **Mechanism:** erratic, high-volatility pullbacks fail; and the loss tail is dominated by immediate failures that a short invalidation would cut.
- **Same honesty caveat:** `FALSE` is defined with post-entry data → an **exit rule**, not an entry filter.

---

## What the missing 10s/20s trigger would have to accomplish

The 1m corpus cannot validate a sub-minute trigger, and this is **not** claimed. What the data *does* quantify is the job the trigger must do:

1. **Reverse the sign.** The current 1m re-acceleration entry has a **negative** forward drift (1m −0.0194%, 5m −0.0245%). A working trigger must turn that positive, not merely add a filter.
2. **Clear cost by itself.** With cost 0.05%, the trigger must deliver roughly **+0.07% to +0.12% of net favourable movement per trade** within 10–20s to move I1-I1 from −0.43R into positive territory.
3. **Be selective, not additive.** 33% of entries are already `TOO_LATE`; the trigger must *remove* signals, not add them. Adding a 10s/20s layer on top of the current 1m trigger would only make entries later — the exact failure this diagnosis identified.
4. **Separate a real re-acceleration from a dead-cat bounce**, and fire only once the pullback has genuinely reset distance from the extreme.
5. **Validation requirement:** it must be tested on **actual sub-minute historical tape**. Only four discovery tick sessions exist today; until more exists, a 10s/20s trigger is a design intention, not evidence.

### Corrected I1 evidence → what the trigger must do (identification, not a design)

The I1 numbers above are the **re-derived, session-isolated** ones (numerically identical to the earlier run). They are still 1m context evidence — they can rank the *jobs* a sub-minute trigger must do, but they cannot derive or tune one. Ranked by measured size of the defect:

1. **Avoid late entries — the primary job.** 33.0% of entries are `TOO_LATE` (`distExtreme < 0.10%`), the worst bucket at **−0.513 R**. Every entry-delay bucket is negative (≥2 bars −0.481 · ≥4 −0.436 · ≥8 −0.422) and **17,861 of 27,159 entries are already ≥8 bars late**. A trigger that fires at the pullback instead of after a 1m re-acceleration bar addresses the largest single measured defect.
2. **Improve timing — secondary, and it is a *sign* problem, not a filter.** The pullback stage drifts **+0.0330%** (1m) forward; the re-acceleration entry drifts **−0.0194%**. The trigger must make the entry's forward drift *positive*, which means firing closer to the pullback, not adding confirmation.
3. **Distinguish — but NOT by demanding more continuation.** More re-acceleration is monotonically *worse* (reAccel ≥0 → −0.498, ≥0.15 → −0.313, ≥0.4 → −0.622), and oversized context moves fail hardest (impulse ≥2% → −1.294; pullback depth ≥0.8% → −1.465). So the trigger must be **selective and subtractive**: it must *reject* the chase majority and the dead-cat-bounce re-accelerations, not encode "more momentum is better."

**What it must not be:** an additional layer on top of the current 1m trigger. Adding a 10s/20s confirmation would make entries *later* — the exact failure this diagnosis identified in both systems.

**This is an identification of the required behaviour. It is not a trigger, and nothing here may be turned into one from 1m context data.**

---

## Gate verdict — nothing is ready

- **Scalping:** `S2` as currently defined (trigger entry) **fails the gate** — net-negative on 4/4 sessions. The promising object is a *different entry*: **the meaningful extension event** (corrected netExpR **+0.452** pooled, positive 3/4 sessions, net PF 1.61). It needs its own pre-registered test before it counts as a candidate — see [docs/S2-ROBUSTNESS.md](docs/S2-ROBUSTNESS.md), where that pre-registered test is stress-tested.
- **Intraday:** `I1` **fails the gate** — entry negative on 0/8 sampled sessions, and its gross-positive stage (the pullback) is thin and not robust (largest bucket ≈ 0). The re-derived session-isolated I1 numbers are **identical**, so this verdict is unchanged. The trigger identification above is a statement of required behaviour, **not** a pre-registered candidate, and no trigger was built from it.
- **No candidate is approved for live shadow testing.** No parameter was optimized. No V4. Nothing was implemented.

---

## What the session-isolation correction changed (2026-10-04)

Both tools previously created their per-symbol state (`hist`, episode/context, cooldown) and their outcome trackers **once, outside the session loop**, so state could cross the session boundary. `priceAt()` returns the last tick `≤ target`, so a surviving overnight price fabricated an extension at the next open. The tools now create **fresh per-session state and trackers**, and order rows deterministically by `(ts, symbol)`. This is a data-integrity fix — **no threshold, cooldown, entry rule, cost or episode rule changed.**

| | before | after | verdict |
|---|---|---|---|
| **S2 funnel** episodes / decelerated / triggered | 50,792 / 23,319 / 6,762 | 50,645 / 23,322 / 6,762 | minor |
| **S2 EXTENSION** netExpR (n) | +0.069 (50,792) | +0.069 (50,645) | **unchanged** |
| **S2 EXTENSION_MEANINGFUL** netExpR (n) | +0.447 (11,384) | **+0.452** (11,251) | **slightly stronger** |
| **S2 DECELERATION** netExpR | −0.002 | −0.002 | **unchanged** |
| **S2 TRIGGER** netExpR (n) | −0.217 (6,762) | −0.217 (6,762) | **unchanged** |
| **S2 classes** GOOD / TOO_SMALL / TOO_LATE / FALSE | 1,980 / 3,686 / 488 / 608, +0.279 / −0.230 / −0.319 / −1.666 | identical | **unchanged** |
| **I1 CONTEXT / PULLBACK / ENTRY** netExpR | −0.598 / −0.179 / −0.431 | −0.598 / −0.179 / −0.431 | **unchanged (identical)** |
| **I1 classes** GOOD / TOO_LATE / TOO_SMALL / FALSE | 13,777 / 8,954 / 2,197 / 2,231 | identical | **unchanged (identical)** |
| **I1 per-day ENTRY** | 145 days | 145 days, **0 differ** | **unchanged (identical)** |

**Conclusions that remain unchanged:**

1. In both systems the edge exists **before** the trigger and the trigger **destroys** it (S2 `+0.069 → −0.002 → −0.217`; I1 `+0.071 → −0.431`).
2. The extension/fade stage is the only gross-positive S2 stage, and it is positive on 3/4 sessions; the trigger is negative on 4/4.
3. I1's entry is negative on every sampled session, and I1's gross-positive pullback stage is thin and not robust.
4. The no-chase failure mode (`TOO_LATE`, `distExtreme < 0.10%`) and the immediate-failure tail (`FALSE_REVERSAL` / `FALSE`) dominate the losses.
5. `FALSE`/`GOOD` are defined with post-entry data → management/exit, never an entry filter.

**Conclusions that changed:** none of substance. The only material move is `EXTENSION_MEANINGFUL` **+0.447 → +0.452** (and its per-day 10-01 cell **+0.631 → +0.668**), which *strengthens* the case rather than weakening it, and brings the stage-2 attribution into near-exact agreement with the independently implemented pre-registered candidate (**+0.447**).

**Claims that must be withdrawn:** none. No S2 or I1 claim depended on the contaminated sessions. I1 in particular was **already effectively session-isolated** (its only cross-session channel was a 5-bar cooldown whose 15-hour overnight gap never fired), so its earlier numbers stand exactly.

**I1 was still re-derived rather than assumed.** The tool now creates a fresh tracker per symbol-session, makes the cooldown session-scoped, and orders rows deterministically. Every I1 stage, class, split and per-day value is bit-for-bit identical to the earlier run — that identity is the verification, not an omission.

**STOP.** The next decision — which single candidate to take forward on each side — should be made only after reading this evidence.

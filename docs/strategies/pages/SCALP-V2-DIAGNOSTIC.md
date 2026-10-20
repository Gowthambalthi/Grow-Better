# EXPERIMENTAL ROC V2 — DIAGNOSTIC ONLY

**Read-only diagnosis. No threshold, formula, window, cooldown or frozen strategy file was changed. No parameter search was performed. No V3 was implemented.**

| | |
|---|---|
| Tool | `strategies/roc/rocDiagnostic.js` (new, observational only) |
| Engine | the **same** `createRocEngineV2` used live and in the backtest |
| Outcomes | the **same** `createOutcomeTracker` + `summarizeOutcomes` |
| Data | the four discovery tapes: 2026-09-28, 09-29, 09-30, 10-01 |
| Volume | 16,134,718 ticks · 15,937,626 warm ticks (≥20s history) |
| Universe | 938 / 967 / 1336 / 1118 symbols with signals per session |
| Evidence class | **DEVELOPMENT CORPUS — NOT Phase 5A independent validation** |

Config in force (unchanged, read from `.env`): `ROC10=10000ms · ROC20=20000ms · swing=10000ms · minExtensionPct=0.05 · confirmMs=1000 · cooldownMs=15000`.

> `Phase 5A = INCONCLUSIVE` · `Phase 6 = NOT ALLOWED` · `Phase 7 = NOT ALLOWED` — unchanged.

---

## Headline

**MOMENTUM is not firing *despite* a selective condition — there is no selective condition. The trigger is true on 60.8% of all ticks, so the 15 s cooldown is effectively the signal generator.** The mathematically-correct `recent10 > previous10` test is an *acceleration* test that is positive-and-accelerating (or negative-and-accelerating) most of the time, so "momentum" is the market's resting state in this corpus, not an event.

Cause ranking (section 3): **hypothesis definition + insufficient selectivity = primary**; cooldown/latch = the thing currently *masking* it; tick noise and mathematical error = **not** the cause.

---

## 1. Signal firing rate

| metric | 09-28 | 09-29 | 09-30 | 10-01 |
|---|---|---|---|---|
| MOMENTUM signals | 334,967 | 423,004 | 513,004 | 186,782 |
| REVERSAL signals | 118 | 208 | 345 | 97 |
| MOM signals / symbol / session | 357.1 | 437.4 | 384.0 | 167.1 |
| MOM signals / minute | 894 | 1128 | 1312 | 552 |
| **gap median** | **20,000 ms** | **20,000 ms** | **20,000 ms** | **20,000 ms** |
| gap p10 / p90 | 15.5s / 45s | 15.5s / 45s | 16s / 45s | 15.5s / 45s |
| firing at cooldown ceiling (±1 s) | 24.0% | 22.5% | 23.4% | 29.7% |
| tick-attempts blocked by cooldown | 58.3% | 59.2% | 57.5% | 70.0% |
| latch duration median / mean | 8s / 11.6s | 8s / 11.7s | 8s / 15.7s | 8s / 29.5s |

- The **median gap is 20 s against a 15 s cooldown** — the debounce, not the condition, sets the cadence. The gap p10 is exactly the cooldown floor.
- **58–70% of ticks that *would* fire are suppressed by the cooldown**, i.e. the condition is continuously offering signals and the cooldown is the only brake.
- **Latch duration median is 8 s**, shorter than the cooldown: the direction resets (or flips) well before 15 s, so the latch almost never blocks a re-fire — the cooldown does.
- **Time of day**: signals span ~390 min (09:15 → 15:45 IST), with the peak 15-min slot at **10:00**. Firing is broad and continuous across the session, not concentrated at the open/close.

REVERSAL, for contrast, is nowhere near its cooldown: `blockedByCooldown = 0.0%` on every session.

## 2. Momentum condition distribution

| quantity (share of warm ticks) | value |
|---|---|
| condition **BUY** | 29.2% |
| condition **SELL** | 31.6% |
| condition **WAIT** | 39.2% |
| **condition true (BUY+SELL)** | **60.8%** |
| \|recent10\| ≥ 0.001% | 71.6% |
| \|recent10\| ≥ 0.01% | 58.9% |
| \|recent10\| ≥ 0.05% | 23.7% |
| \|recent10\| ≥ 0.50% | 0.3% |

**How marginal are the triggers?** (share of momentum-true ticks with a *tiny* numerical difference)

| threshold on \|recent10 − previous10\| | share |
|---|---|
| < 0.0001 | 1.95% |
| < 0.001 | 2.22% |
| < 0.005 | 4.62% |
| < 0.01 | 11.9% |
| < 0.05 | 50.4% |
| < 0.1 | 75.9% |

**Acceleration magnitude of the actual MOMENTUM signals** (n = 1,458,525):

| \|acceleration\| ≥ | share |
|---|---|
| 0.0001 | 98.7% |
| 0.01 | 90.0% |
| 0.05 | 52.4% |
| 0.10 | 25.6% |
| 0.50 | 0.9% |

**Reading.** Only ~2% of momentum ticks are marginal at 1e-4, and 90% of emitted signals carry \|acceleration\| ≥ 0.01%. **The trigger is *not* dominated by sub-tick numerical noise.** `recent10 > previous10` is genuinely true with real magnitude — it is simply true most of the time.

## 3. What is the cause?

| candidate | verdict | evidence |
|---|---|---|
| **Mathematical definition** | ❌ not the cause | The disjoint-interval derivation is correct. `recent10 == previous10` (constant velocity) gives zero acceleration and does not fire; the geometry bug V2 was built to remove is genuinely gone. |
| **Tick noise** | ❌ not primary | Only 1.95% of momentum ticks are marginal at 1e-4; 90% of signals have \|accel\| ≥ 0.01%. |
| **Cooldown / latch behaviour** | ⚠️ **not a bug — it is the only brake** | Cooldown works (median gap 20 s > 15 s, 0 blocked-by-latch). But the latch resets in a median 8 s, so it rarely blocks. 58–70% of would-fire ticks are cooldown-suppressed. |
| **Hypothesis definition** | ✅ **primary** | The condition is a *two-sided state*, true on 60.8% of ticks. It is not an event. |
| **Insufficient selectivity** | ✅ **primary** | No threshold of the current condition has positive edge (section 4/6/7). |

**Conclusion:** MOMENTUM is almost always ON because the hypothesis defines a *resting state* ("the last 10 s return is accelerating in its own direction"), not a *setup*. The cooldown miner is mining a 61%-of-the-time condition, so it returns a signal every time the debounce lets it.

## 4. MOMENTUM vs REVERSAL at the same timestamps

Both conditions were evaluated on **every** warm tick, with the reversal direction sampled by the same tracker.

| condition | tick frequency | sampled n | win % | gross expR | net expR (0.05%) |
|---|---|---|---|---|---|
| MOMENTUM condition true | **60.8%** | 621,766 | 38.6% | −0.061 | **−0.311** |
| REVERSAL extension stage | **1.45%** | 72,283 | 55.2% | **+0.096** | −0.154 |

- **`bothMomAndExt` = 0.00%.** The two hypotheses are near-perfectly mutually exclusive by construction: MOMENTUM BUY needs an *accelerating* up-move; the REVERSAL-UP extension needs a *decelerating* one.
- Forward movement: the momentum condition's own forward expectancy is **negative (−0.061 R)** — the momentum condition does not predict the momentum direction. The reversal *extension* stage's forward expectancy is **positive (+0.096 R)** before cost, but is already **−0.154 R after the fixed 0.05% cost**.

## 5. REVERSAL funnel — where candidates die

| stage | count (pooled) | gross expR | net expR |
|---|---|---|---|
| extension ticks (\|recent10\| ≥ 0.05 + decelerating) | 230,839 | — | — |
| extension **episodes** (null→ext transitions) | 135,162 | — | — |
| extension **confirmed** (held ≥ 1000 ms) | 49,205 | **+0.077** | −0.174 |
| **swing break** occurrences | 784 | −0.037 | −0.287 |
| signals emitted | 768 | −0.037 | −0.287 |

- **break / confirmed = 1.59%.** The swing-break gate discards ~98% of confirmed reversal setups.
- extension → signal = **0.33%**; blocked-by-cooldown = **0%** (REVERSAL never saturates its cooldown).
- **The gate is anti-selective**: the extension stage carries a *positive* gross expectancy (+0.096 R) that the swing-break entry destroys (−0.037 R). The reversal idea shows up in the extension/deceleration condition, not in the break entry.

## 6. Outcome timing — does the edge appear at a horizon?

Mean directional move (%) and win rate by horizon (primary horizons from the existing tracker):

| horizon | MOMENTUM mean move | MOM win% | MOM netR | REVERSAL mean move | REV win% | REV netR |
|---|---|---|---|---|---|---|
| 30 s | −0.0096% | 36.0% | −0.298 | +0.0018% | 45.8% | −0.241 |
| 60 s | −0.0105% | 40.0% | −0.302 | −0.0075% | 49.1% | −0.287 |
| 120 s | −0.0109% | 42.9% | −0.304 | −0.0189% | 50.3% | −0.345 |
| 300 s | −0.0103% | 44.9% | −0.302 | −0.0074% | 48.0% | −0.287 |

- **MOMENTUM**: mean move is ~−0.01% at *every* horizon. The win rate rises 36% → 45% purely because a bigger window gives more chances to cross zero — **the mean never improves**. No horizon rescues it.
- **REVERSAL**: the only non-negative cell is 30 s (+0.0018%, win 45.8%) and it decays by 60 s. With n = 768 this is indistinguishable from noise; there is **no horizon-specific edge**.

## 7. Cost sensitivity (existing framework, existing cost model)

Applied with the framework's own definition `netR = (forwardPct − costPct) / riskPct` on the summarizer's own expectancy. Only `costPct` was varied.

| costPct | overall netExpR | MOMENTUM | REVERSAL |
|---|---|---|---|
| 0.00% | −0.052 | −0.052 | −0.037 |
| 0.02% | −0.152 | −0.152 | −0.137 |
| **0.05%** | **−0.302** | **−0.302** | **−0.287** |
| 0.10% | −0.552 | −0.552 | −0.537 |
| 0.20% | −1.052 | −1.052 | −1.037 |

Each +0.01% of cost ≈ −0.05 R. The strategies are **gross-negative already** (−0.05 R) before any cost; cost then dominates.

## Appendix — edge by move size (existing ROC buckets)

| \|ROC10\| bucket | n | win% | avgR | avg forward% |
|---|---|---|---|---|
| `lt_0.05` | 851,086 | 43.0% | −0.008 | −0.0015% |
| `0.05_0.20` | 548,017 | 36.1% | −0.098 | −0.0196% |
| `0.20_0.50` | 52,244 | 34.9% | −0.212 | −0.0424% |
| `gte_0.50` | 7,178 | 30.0% | −0.698 | −0.1396% |

**Monotonic degradation**: the larger the recent move the engine chases, the worse the forward result. The corpus behaves **mean-reverting at the extremes**, and MOMENTUM is positioned on the wrong side of that gradient.

---

## Verdict

1. **Why V2 fires so much:** MOMENTUM's condition is true on **60.8% of ticks**. It is not an event, it is the background state. The 15 s cooldown, not the hypothesis, decides when signals appear (median gap 20 s; 58–70% of would-fire ticks suppressed).
2. **Not tick noise, not a math error, not a cooldown bug.** The acceleration test is correct and, for 90% of signals, materially non-zero.
3. **No selective MOMENTUM signal is hidden inside:** the condition's own forward expectancy is negative (−0.061 R gross) and worsens monotonically with move size.
4. **The only positive-gross signal found is the REVERSAL *extension/deceleration* stage (+0.096 R gross)** — but it is already −0.154 R after the fixed cost, and the swing-break entry gate (which rejects 98.4% of confirmed setups) flips it to negative. This is a direction for future investigation, **not** a tradeable result, and **not** an instruction to change anything.

**STOP.** No V3 is implemented. Nothing has been tuned. Frozen strategy and Phase 5A infrastructure untouched.

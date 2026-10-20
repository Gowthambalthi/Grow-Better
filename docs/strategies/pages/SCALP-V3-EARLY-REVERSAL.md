# EXPERIMENTAL ROC V3 — EARLY REVERSAL

**One hypothesis, tested once. No threshold tuned. V2 preserved byte-identical. Not deployed. No V4.**

| | |
|---|---|
| Tool | `strategies/roc/rocV3Study.js` |
| Engine | `strategies/roc/rocEngineV3.js` (new, research candidate only) |
| Unchanged inputs | ROC10 10000ms · ROC20 20000ms · swing 10000ms · activation floor 0.05 · confirm 1000ms · cooldown 15000ms |
| Outcomes | the **same** `createOutcomeTracker` + `summarizeOutcomes` as live/V2 |
| Costs | the **same** framework: `netR = (forwardPct − costPct)/riskPct`, risk 0.20%, cost 0.05% |
| Data | the four discovery tapes, same tick order: 2026-09-28 … 10-01 |
| Evidence | **DEVELOPMENT CORPUS — NOT Phase 5A independent validation** |

**The hypothesis.** V2's reversal waits for a 10 s swing break, and the V2 diagnostic showed that gate rejects ~98% of confirmed setups and flips a positive-gross extension stage negative. V3 keeps the **same event** (an extension of the preceding move that is decelerating) and enters at the **confirmed deceleration** instead of waiting for the break.

```
UPWARD    previous10 meaningfully positive · recent10 still positive · acceleration turns negative → SELL
DOWNWARD  previous10 meaningfully negative · recent10 still negative · acceleration turns positive → BUY
```

## Entries compared (identical tapes, tick order, tracker, cost model)

| tag | entry |
|---|---|
| **B — `V3_EARLY`** | V3 event confirmed ⇒ enter **immediately** |
| `V3_SWING` | **the same V3 event**, gated on the 10 s swing break (V2-style entry) — isolates the entry question |
| `V2_REVERSAL` | the deployed V2 engine's reversal (extension→decel→swing break) |
| `V2_MOMENTUM` | the deployed V2 momentum hypothesis — **control only** |

## Pooled results (4 sessions)

| version | n | win% | avg fav | avg adv | **expR** | **netExpR** | maxAdv | tMFE | tTarget |
|---|---|---|---|---|---|---|---|---|---|
| **V3_EARLY** | 158,401 | 53.2% | +0.260% | −0.239% | **+0.061** | **−0.189** | −24.23% | 183.5s | 173.6s |
| V3_SWING | 3,866 | 48.5% | +0.249% | −0.254% | +0.010 | −0.240 | −4.69% | 188.7s | 173.7s |
| V2_REVERSAL | 768 | 49.1% | +0.327% | −0.355% | −0.037 | −0.287 | −4.69% | 198.2s | 137.8s |
| V2_MOMENTUM (control) | 1,457,757 | 40.0% | +0.165% | −0.184% | −0.052 | −0.302 | −25.00% | 196.6s | 239.0s |

## Per discovery session

| session | version | n | win% | expR | netExpR | maxAdv |
|---|---|---|---|---|---|---|
| 2026-09-28 | V3_EARLY | 31,791 | 54.4% | +0.074 | −0.176 | −6.75% |
| | V3_SWING | 683 | 53.0% | +0.038 | −0.212 | −2.84% |
| | V2_REVERSAL | 118 | 56.8% | +0.026 | −0.224 | −2.84% |
| | V2_MOMENTUM | 334,967 | 38.4% | −0.056 | −0.306 | −6.28% |
| 2026-09-29 | V3_EARLY | 44,367 | 54.1% | +0.085 | −0.165 | −5.80% |
| | V3_SWING | 1,022 | 49.8% | +0.074 | −0.176 | −1.62% |
| | V2_REVERSAL | 208 | 48.6% | +0.115 | −0.135 | −1.56% |
| | V2_MOMENTUM | 423,004 | 39.8% | −0.056 | −0.306 | −6.20% |
| 2026-09-30 | V3_EARLY | 56,185 | 52.5% | +0.048 | −0.202 | −24.23% |
| | V3_SWING | 1,542 | 46.8% | −0.029 | −0.279 | −3.81% |
| | V2_REVERSAL | 345 | 46.7% | −0.157 | −0.407 | −3.81% |
| | V2_MOMENTUM | 513,004 | 40.2% | −0.049 | −0.299 | −25.00% |
| 2026-10-01 | V3_EARLY | 26,058 | 51.6% | +0.033 | −0.217 | −14.78% |
| | V3_SWING | 619 | 45.4% | −0.030 | −0.280 | −4.69% |
| | V2_REVERSAL | 97 | 49.5% | −0.017 | −0.267 | −4.69% |
| | V2_MOMENTUM | 186,782 | 42.8% | −0.046 | −0.296 | −14.90% |

Consistency, not just aggregate: **V3_EARLY is the only version with positive gross expectancy on all four sessions**, and it beats `V3_SWING` on the same events **4/4** sessions.

## Forward results by horizon (mean move, existing cost model)

| version | 30 s | 60 s | 2 m | 5 m |
|---|---|---|---|---|
| **V3_EARLY** | +0.0121% | +0.0122% | +0.0113% | +0.0093% |
| V3_SWING | +0.0014% | +0.0020% | +0.0005% | +0.0017% |
| V2_REVERSAL | +0.0018% | −0.0075% | −0.0189% | −0.0074% |
| V2_MOMENTUM | −0.0096% | −0.0105% | −0.0109% | −0.0103% |

V3_EARLY's edge is **stable across all four horizons** (unlike V2_REVERSAL, which decays and goes negative). It is simply smaller than the cost.

## Cost sensitivity (netExpR)

| version | 0% | 0.02% | **0.05%** | 0.10% | 0.20% |
|---|---|---|---|---|---|
| **V3_EARLY** | **+0.061** | −0.039 | **−0.189** | −0.439 | −0.939 |
| V3_SWING | +0.010 | −0.090 | −0.240 | −0.490 | −0.990 |
| V2_REVERSAL | −0.037 | −0.137 | −0.287 | −0.537 | −1.037 |
| V2_MOMENTUM | −0.052 | −0.152 | −0.302 | −0.552 | −1.052 |

**Break-even cost for V3_EARLY = expR × risk = 0.061 × 0.20% ≈ 0.0122%**, versus the assumed **0.050%**. The edge is real in sign but roughly **4× too small** to survive the current cost assumption.

---

## Verdict — STOP

1. **The entry-timing intuition is confirmed, on identical events.** Removing the swing break and entering at confirmation moves gross expectancy from **+0.010R → +0.061R** (~6×), lifts win rate 48.5% → 53.2%, and makes the version positive-gross on **4/4** sessions. The swing break was indeed destroying value.
2. **Early Reversal is nevertheless still negative after cost: netExpR −0.189R at the fixed 0.05% cost.** It is positive only at ~0% cost; it is already negative at 0.02%.
3. **So, per the pre-agreed rule, this stops here.** V3 is recorded as a **research candidate that did not clear the cost bar** — it is not a result, not a recommendation, and **not** to be deployed or to replace V2.
4. **Not tuned, not optimized.** No threshold was moved after seeing this; the activation floor and confirmation period are the same fixed values V2 uses. No parameter search was performed, and **no V4 was created**.

### Limitations

- Development corpus only (four discovery tapes) — **not** Phase 5A independent evidence; `Phase 5A = INCONCLUSIVE`, `Phase 6 = NOT ALLOWED`, `Phase 7 = NOT ALLOWED`.
- V3_EARLY fires 158,401 times/session-set — far more than V2's reversal (768) — so it is less selective than V2 despite the smaller signal than MOMENTUM.
- Tail risk is unmasked: max adverse excursion −24.23%, essentially the momentum tail, because early entry takes the trade *before* confirmation of a turn.
- The cost assumption (0.05%) is the swing factor. The result says the edge is real but sub-cost at that assumption — it does **not** establish the true execution cost.

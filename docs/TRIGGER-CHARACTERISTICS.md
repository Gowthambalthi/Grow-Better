# TRIGGER CHARACTERISTICS — 10s/20s TRIGGER REQUIREMENTS (READ-ONLY, DISCOVERY ONLY)

**No trigger implemented. No V4. No production change. No automatic trading. No threshold optimized.**

Tool: [research/triggerCharacteristics.js](research/triggerCharacteristics.js) · raw: [data/terminal/trigger-characteristics.json](data/terminal/trigger-characteristics.json)

## Evidence label (important)

> **DISCOVERY EVIDENCE ONLY — the four discovery tick tapes (2026-09-28 … 10-01).**
> This is **not validation**. The 145-session corpus has only 1m bars, so **a 10s/20s trigger has NOT been historically validated** and nothing here claims it has. Events are sampled at a **fixed 60s per-symbol cadence** (a measurement choice, not a tuned parameter); every quantity is reported as a distribution. No threshold search was performed on these tapes.

Question: *can a 10s/20s trigger after a genuine 1m pullback improve entry timing enough to turn I1 positive after cost?* The first step is to establish what the trigger would have to do.

## Finding 1 — the sub-minute trigger should signal EXHAUSTION, not continuation

Two candidate trigger types measured on live sub-minute behaviour (forward window = the trade direction):

| trigger type | n | mean fwd 10s | mean fwd 20s | P(fwd20s > cost) | expR | netExpR |
|---|---|---|---|---|---|---|
| **CONTINUATION** (pullback, then short window re-accelerates) | 23,488 | **−0.0229%** | **−0.0238%** | 27.0% | −0.119 | −0.369 |
| **EXHAUSTION** (extension decelerating → fade) | 6,899 | **+0.0067%** | **+0.0062%** | 37.2% | +0.031 | −0.219 |

**The continuation idea fails at sub-minute horizons** (negative drift in both the 10s and 20s window), while the **fade/exhaustion direction is the only one with positive mean drift**. This matches the S2 finding from the other direction: the profitable action after an extension is to fade it, not to chase the resumption.

Continuation, conditional on its own features (n / mean 10s / mean 20s / netExpR):

| re-acceleration magnitude |   | distance from prior extreme |   |
|---|---|---|---|
| ≥0 | 2,779 / −0.0013 / −0.0007 / −0.253 | ≥0 (at the extreme) | 15,512 / −0.0281 / −0.0317 / −0.409 |
| ≥0.02% | 3,687 / −0.0055 / −0.0078 / −0.289 | ≥0.05% | 3,263 / −0.0183 / −0.0152 / −0.326 |
| ≥0.05% | 5,150 / −0.0196 / −0.0141 / −0.321 | ≥0.10% | 3,844 / −0.0119 / −0.0059 / −0.280 |
| ≥0.10% | 5,694 / −0.0203 / −0.0183 / −0.342 | **≥0.30%** | 869 / **+0.0029 / +0.0078** / −0.211 |
| **≥0.20%** | 6,178 / **−0.0482** / **−0.0567** / **−0.534** | | |

Two sharp results: **more re-acceleration is worse** (−0.253 → −0.534 as the burst grows), and **the only positive forward moves come from being ≥0.30% away from the prior extreme.**

## Finding 2 — most candidates are already too late at the trigger moment

At the moment a continuation trigger would fire:

| condition | share of candidates |
|---|---|
| distance from the prior extreme < 0.05% | **66.0%** |
| distance from the prior extreme < 0.10% | **79.9%** |
| entry delay > 15 s since the pullback | **55.2%** |

Two-thirds of candidates fire right at the extreme, which is exactly the bucket with the worst forward drift (−0.409 R). This is the same "trigger is late" mechanism found in the stage-2 diagnosis, now visible at sub-minute resolution.

## Finding 3 — the required characteristics (answers to the questions asked)

| question | answer from the data |
|---|---|
| **How much re-acceleration is needed?** | *Less is better, not more.* Forward drift worsens monotonically with burst size (−0.253 at ≥0 → −0.534 at ≥0.20%). A trigger that demands a big short-window burst is measured to be worse. |
| **How quickly must it occur?** | Before price returns near the extreme. Every delay bucket is negative; 55% of candidates are already >15 s late. It must fire **while distance from the extreme is still ≥0.30%**, i.e. within a few seconds of the pullback extreme. |
| **How far from the prior extreme?** | **≥0.30%** is the only bucket with positive mean 10s/20s forward movement (+0.0029% / +0.0078%). 66% of candidates are <0.05% away and must be excluded. |
| **Continuation or exhaustion?** | **Exhaustion.** Continuation has negative 10s/20s drift; fade has positive drift and a higher share clearing cost (37.2% vs 27.0%). |
| **How much forward movement is required in the first 10–20s?** | At least the 0.05% cost, ideally ~0.10%. Today only **27.0%** of continuation and **37.2%** of exhaustion events clear 0.05% at 20s, and only **26.8%** of exhaustion clears 0.10%. A trigger must roughly **double-to-triple** the share of events that clear cost — i.e. it must be *far more selective*, not merely present. |
| **How often is a candidate too late?** | **66%** are <0.05% from the extreme; **80%** are <0.10% away. The majority of naive candidates are un-tradeable by construction. |

## Implication for I1

- The current 1m re-acceleration entry is **negatively predictive** (1m forward −0.0194%, from the stage-2 diagnosis). A 10s/20s layer that simply confirms "the move resumed" would reproduce the same failure: continuation re-acceleration is −0.023% at 10s.
- What the trigger must add is **the opposite of confirmation**: it must detect **exhaustion of the pullback attempt** — i.e. it should behave more like the fade logic (positive drift) than the continuation logic.
- It must also enforce the **distance-from-extreme** condition (≥0.30%) that separates the only positive-forward bucket, and must fire **fast** (well inside 15 s), because most candidates are already too late.
- **Minimum bar:** ≥0.10% (2× cost) of favourable movement within 10–20 s at a rate clearly above today's 27–37%.

## Limitations

- Discovery evidence: **4 sessions**, one market regime, ~1,234 independent minutes of sub-minute tape. Not validation.
- The 145-session corpus cannot test this (1m only); a real sub-minute trigger must be validated on **actual sub-minute historical tape** before being called proven.
- The 60s per-symbol sampling cadence is a measurement choice and will under-count clustered events; it does not bias the direction of the findings above (they are per-event drift).
- No threshold was optimized on these tapes; the numbers are descriptive distributions.

**STOP.** No trigger was implemented; the characteristics above are the specification to evaluate against when more sub-minute tape exists.

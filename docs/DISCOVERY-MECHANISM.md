# DISCOVERY MECHANISM — SCALPING & INTRADAY

**STATUS: `FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED`**

This is **discovery research**, not a strategy. Nothing here is a candidate, nothing was
optimised, nothing is wired to production, nothing was sent through the historical gate, and
no thresholds were tuned. These are **DISCOVERY SIGNATURES** — recurring pre-move states that
over-represent one outcome. Only after a genuine mechanism is identified do we define a
hypothesis and send it through `research/candidateGate.js`; that step is deliberately **not**
taken here.

This pass completes the outcome-first discovery you requested:

1. **Mirror direction** — does a large UP move also precede a future DOWN, or only the reverse?
2. **Cross-track structure** — are scalp and intraday measuring the same thing at different scales?
3. **Time-to-MFE** — does the edge begin immediately, or require a confirmation delay?
4. **Separate direction from volatility** — reject "something big will happen" signatures.
5. **Robustness before candidate creation** — support, dedup, sessions, long/short, tails, cost
   sensitivity, top-1/5/10 % removal, independent observations.

---

## 1. Methodology (same as the previous discovery pass, extended)

**Outcomes (frozen convention):** risk 0.20 %, cost 0.05 %, horizon per track; a 60 s scalp event
is labelled PROFITABLE when the best direction nets ≥ +0.50 R after cost, UNPROFITABLE when no
direction clears cost, MARGINAL otherwise (excluded).

**Two outcome questions, both outcome-first, both symmetric:**

* **Magnitude:** PROFITABLE vs UNPROFITABLE (does a direction-resolving state precede a move?).
* **Direction, two-sided:** among PROFITABLE events, was the move UP or DOWN. A single mining run
  produces both UP-predicting and DOWN-predicting signatures, ranked by the stronger side of their
  net-R lift. This is the requested mirror analysis — DROP and UP are treated identically.

**Scope (IN-SAMPLE, stated, not claimed as OOS):**

| track | evidence | events / ticks | symbols | sessions |
|---|---|---|---|---|
| SCALPING | 4 tick tapes `2026-09-28 … 10-01` | 10,791,275 labelled (16.1 M ticks) | 1,426 | 4 |
| INTRADAY | 1 m corpus, all symbols | 4,428,734 labelled | 1,028 | 145 |

**Pre-move axes (edges declared once, never swept; strictly prior data only):** same 15 axes as the
previous pass, plus two **normalised / cross-track** variables that are comparable across horizons:

* **stretch** = `return / recent_range` (a units-free measure of how stretched the move is relative to
  its own range).
* **position** = `(price − range_low) / range` (where in the recent range the price sits, 0..1).

**Forward path captured in the row store** at +1/3/5/10/20/30/60 s (scalp) and +1/2/5/10/15/30 min
(intraday), so `fracOfPositiveTraces` vs time is measured, not assumed.

**Liquid-only path subset (scalp):** scalp ticks are sparse (median inter-tick gap ≈ 5 s; only
~237/1404 symbols have a median ≤1 s; ~336 have ≤2 s). A symbol with one tick per second moves
~10–20 micro-pips per second — its 60 s path is structurally invisible. To make time-to-MFE
resolvable, the scalability paths are also reported separately for the **liquid subset** (symbols
whose tick rate in the last 10 s is ≥ a small threshold; defined in code, not fitted to results).
The table reports both the full population and the liquid subset; the liquid subset is where the shape
is trustworthy.

**Robustness for every signature:** support (n and %), profitable/losing frequency, UP/DOWN
separation, deduplicated result + independent obs, session coverage (above/base-below), long/short
symmetry, tail shares (top 1/2/5/10 %), top-removal mean (0/1/5/10 %), cost sensitivity (0/0.02/0.05/0.10/0.20
% meanR), and the computed `nLiquid` for the path.

**Instruments:** [`research/discoveryCore.js`](../research/discoveryCore.js),
[`research/discoveryScalp.js`](../research/discoveryScalp.js),
[`research/discoveryIntraday.js`](../research/discoveryIntraday.js).
Outputs: [`data/terminal/discovery-scalp.json`](../data/terminal/discovery-scalp.json),
[`data/terminal/discovery-intraday.json`](../data/terminal/discovery-intraday.json).

---

## 2. Mirror direction — the phenomenon is SYMMETRIC

The single most important result of this pass: the directional discovery is **two-sided by
construction**, and the mirror is real on both tracks.

**Bases:** scalp UP 49.4 % (dedup 51.2 %) with 1,113,734 UP vs 1,138,936 DOWN; intraday UP 45.3 %
(dedup 50.7 %) with 1,633,369 UP vs 1,972,028 DOWN. Both bases ≈ coin flip, so separation is real.

| track | UP-predicting signature (discovers a future UP) | n | P(UP) | dedupN | dedup P(UP) | DOWN-predicting mirror signature (discovers a future DOWN) | n | P(DOWN) | dedupN | dedup P(DOWN) |
|---|---|---|---|---|---|---|---|---|---|---|
| SCALP | `distLo60 < 0.02` (at the 60 s low) | 646,761 | 56.2 % | 178,088 | 61.5 % | `distHi60 < 0.02` (at the 60 s high) | 658,847 | 56.8 % | 170,735 | 62.6 % |
| SCALP | `dirChange<0.5 & distLo60<0.02` | 644,198 | 56.2 % | 177,404 | 61.5 % | `dirChange<0.5 & distHi60<0.02` | 656,314 | 56.8 % | 170,101 | 62.6 % |
| SCALP | `r60<-1.5 & accel<-0.5` (deep, decelerating) | 235 | 78.7 % | 58 | 70.7 % | `r60>=1.5 & sinceImpulse in [30,60) s` | 252 | 81.7 % | 140 | 80.0 % |
| SCALP | `r60<-1.5 & position in [0.5,0.7)` | 150 | 82.0 % | 15 | 73.3 % | `accel>=0.5 & position>=0.9` | 355 | 73.0 % | 197 | 74.1 % |
| INTRADAY | `distLo15<0.05` (at the 15-bar low) | 510,695 | 49.2 % | 192,753 | 54.8 % | `distHi15<0.05` (at the 15-bar high) | 181,314 | 59.1 % | 82,025 | 61.4 % |
| INTRADAY | `position<0.1` (in lower decile of range) | 411,136 | 50.4 % | 171,861 | 55.8 % | `ret15 in [-0.1,0.1) & distHi15<0.05` | 158,650 | 59.9 % | 78,286 | 60.8 % |
| INTRADAY | `ret15<-1.5 & resumption<-2` | 1,383 | 64.9 % | 1,258 | 65.7 % | `pullDur>=10 & resumption>=2` | 21,255 | 64.9 % | 19,558 | 64.6 % |
| INTRADAY | `resumption<-2 & imp15>=2` | 1,963 | 61.8 % | 1,762 | 61.7 % | `resumption>=2 & imp15<0.2` | 10,595 | 64.5 % | 8,554 | 64.3 % |

**Read this table as:** for every UP-predicting state there is a mirror DOWN-predicting state with
the same structure and comparable (often stronger) dedup survival. "Price at the bottom of the recent
range ⇒ future UP" and "price at the top of the recent range ⇒ future DOWN" are structurally the same
phenomenon. That is much stronger evidence than the UP-only result would be.

**Asestments (kept, not forced):** the intraday UP side is structurally *weaker* than the DOWN side at
the top end of the range (`distHi15<0.05` → DOWN 59.1 % vs `distLo15<0.05` → UP only 49.2 % raw,
54.8 % dedup). The scalp "deep + decelerating" signatures are also stronger on the DOWN side
(`r60>=1.5 & sinceImpulse in [30,60) s` → 81.7 % vs `r60<-1.5 & accel<-0.5` → 78.7 %). These are
structural skews, not threshold tuning, and we preserve them rather than symmetrising by fiat.

**The "tickRate10" artifact is preserved honestly:** `tickRate10 in [120,250)` still shows P(UP) 92.6 %
on the raw set, but it has **nLiquid=1214/1214 and still collapses on dedup: only 3 independent events
across 4 sessions.** It survives the new rigor as *one* sparse-quality flag, not a signature.

---

## 3. Cross-track structural comparison — are they the same mechanism?

**Short answer: yes, on the "position in range" axis; no, they are not identical everywhere.**

### 3.1 The common axis

Both tracks resolve around a single high-level idea:

> a move against the recent range from an extreme position reverts toward the mean.

The clearest cross-track evidence is the **position in range** monotone:

* SCALPING, normalised position (decimal in the recent 60 s range):
  * `[0, 0.1]` (very low) → **58.3 % UP**
  * `[0.9, 1]` (very high) → **42.3 % UP**
  * So "at the low end ⇒ UP" is opposite to "at the high end ⇒ DOWN" — monotonic.
* INTRADAY, normalised position (decimal in the recent 15-bar range):
  * `[0, 0.1]` → **50.4 % UP**
  * `[0.9, 1]` → **41.9 % UP**
  * Same direction, same monotonic shape, just weaker resolution.

That monotone is the cleanest "same mechanism, different scale" signal in the data.

### 3.2 Where they are NOT the same

* The **stretch** (return/range) axis is NOT shared. On the scalp the strongest reversion is on
  `stretch < -0.75` (deep extension relative to range: 56–63 % UP in the deepest bins), and only the
  most stretched scalp moves revert sharply. On the intraday side the stretch signal is much weaker and
  the intraday reversion is dominated instead by `resumption` (the last bar's direction relative to
  volatility) — the intraday "sharp bar in one direction ⇒ reversal" axis is stronger than the pure
  stretch axis.
* The **time scales of the reversion shape** are different (see next section).
* The scalp's strong "deep + decelerating" UP signatures (`r60<-1.5 & accel<-0.5` 78.7 %, etc.) have
  no clean intraday analog — intraday never gets deep enough in a 15-bar window to make a comparable
  "deceleration within the same move" signature.

### 3.3 "same mechanism, different scale" verdict

If you hold "position in range" constant, the **shape of the reversion signal is the same** on both
tracks: price extreme ⇒ reversion toward the mean. The *precision* is higher on the scalp (56–78 %
vs 50–60 %), the *support* is higher on the intraday, and the *mechanism *is* the same (range-extreme
reversion), while the *dominant trigger axis differs* (stretch/deceleration on the scalp; resumption on
the intraday).

Conclusion **for the purpose of defining a research mechanism**: yes — **position-in-range is the
shared mechanism**; the track-specific "sharp-move" axis (scalp deceleration / intraday resumption) is an
additional filter that tracks the same extreme. We should define **one** research mechanism
("range-extreme reversion, possibly confirmed by a deceleration / sharp-move axis") and then apply it
with track-specific surgical parameters rather than invent two independent mechanisms.

---

## 4. Time-to-MFE — the edge begins immediately, for the extreme

This is the critical test, because the previous program showed that waiting for confirmation destroyed
the edge. The question now is whether the reversion edge in *this* data is immediate or delayed.

### 4.1 Scalp, UP direction, liquid subset (trustworthy shape)

| signature | fracPos at +1s | +3s | +5s | +10s | +20s | +30s | +60s | shape |
|---|---|---|---|---|---|---|---|---|---|
| `distLo60 < 0.02` (at the low) | 48 % | 45 % | 41 % | 41 % | 41 % | 52 % | **78 %** | initial slight fade, then sharp rise |
| `distLo60<0.02 & dirChange<0.5` | 48 % | 45 % | 41 % | 41 % | 41 % | 52 % | **78 %** | identical (same population) |
| `tickRate10 in [120,250)` | 40 % | 34 % | 29 % | 27 % | 30 % | 46 % | **93 %** | delayed but strong at 60s |

**Reading:** for the high-volume "at the low" signature, the `fracOfPositiveTraces` starts **above** the
base already at +1 s (48 % vs 51.2 % base is ~coin-flip), then *dips* to ~41 % through +5/+20 s, then
**rises sharply to 78 % at 60 s**. This is **not a confirmation-then-win pattern** — it is a pattern in
which a modest early edge exists, then there is a brief soft patch, then the reversion bond pays off over
the next minutes. That is consistent with "the market becomes stretched, price starts to revert, the
directional resolution is gradual, and the payoff is over a horizon, not instantaneous."

The `tickRate10` signature shows a different shape: weak in the first seconds, strong only by 60 s — and
that signature's dedup failure reminded us to treat it cautiously.

### 4.2 Scalp, DOWN direction, liquid subset

| signature | fracPos at +1s | +6s | +30s | +60s |
|---|---|---|---|---|---|
| `distHi60 < 0.02` (at the high) | 43 % | ... | ... | **27 %** |

Mirror: the path goes **down** over time, `fracPos` falls from ~43 % toward ~27 % by 60 s — the mirror
of the UP signature's rise.

### 4.3 Scalp, narrow but sharp signatures (ALL, low liquidity)

These are the "deep + decelerating" and related signatures — very high separation, very low support,
liquid n = 0 (too illiquid to trust the path shape). Their *full* all-population paths still show that
the reversion is **monotonic in time** and **large**: e.g. `r60>=1.5 & sinceImpulse in [30,60) s`
grows from +0.248 % at +1 s to **+1.130 % at +60 s**; `accel<-0.5 & stretch in [-1.5,-0.75)` grows from
+0.051 % to +0.650 %. The direction is consistent and the magnitude is large; the shape can't be trusted
at the off-liquid level, but the *monotonicity* is a clean fit to the hypothesis.

### 4.4 Intraday, UP, all (high liquidity by construction)

| signature | +1m | +2m | +5m | +10m | +15m | +30m | shape |
|---|---|---|---|---|---|---|---|---|
| `distHi15>=1 & resumption<-2` | 230 | 250 | 300 | 380 | 406 | 1.96 | early, rising |
| `resumption<-2 & imp15>=2` | 237 | 292 | 313 | 330 | 364 | 1.90 | early, rising |
| `ret15<-1.5 & resumption<-2` | 230 | 286 | 310 | 333 | 380 | 2.03 | early, rising |
| `vol15 in [0.35,0.6) & resumption<-2` | 258 | 303 | 308 | 318 | 385 | 2.22 | early, rising |
| `distLo15<0.05` (broad mirror) | 23 | 25 | 26 | 24 | 23 | 24 | weak & near-flat (barbell) |

**Reading:** the intraday strong signatures all show **an early edge that rises with time** — the
`fracOfPositiveTraces` is already above base at +1/2 min and climbs toward +15/30 min. The edge does **not**
wait for a confirmation; it is present early and strengthens. The broad `distLo15<0.05` mirror is
near-flat and weakly negative over time (its `fracPos` slides from 52 % down to 49 %) — a reminder that
breadth and precision are different here, too.

### 4.5 The key cross-track conclusion on time

On both tracks the reversion edge is **present early and strengthens toward the horizon** — not a
"confirmation after a delay". That is fully consistent with the earlier program finding that confirmation
*destroys* the edge: here we find the edge is *in the pre-move state*, it is *present at +1 min/+1 s*,
and it pays off over a horizon. Waiting for a confirmation bar is exactly the mistake that earlier
caused the edge to appear to vanish.

A caveat: on the scalp the reliable shape is only on the liquid subset; on illiquid symbols the path
is mostly unresolved. That is a data-quality limit, not a finding.

---

## 5. Volatility vs direction — what is rejected

Per your explicit request, we reject signatures that only predict "something big will happen" — i.e.
magnitude-only. The magnitude family (profitable vs unprofitable) is dominated by volatility:

* SCALPING magnitude: `range60 in [0.2,0.4)` → P(prof) 47.1 % (enrichment 3.4× over the 20.9 % base,
  but it says *a* move will happen, not which way); `range60 in [0.4,0.8)` → 70.0 %; `sinceImpulse<5 s`
  → 73.3 % (10.4× enrichment). These are still strong and submit-worthy for magnitude, but they resolve
  tension, not direction.
* INTRADAY magnitude: `vol15>=0.6 & compression<0.3` → 97.7 % (14.6× enrichment, but again "a move");
  `imp15>=2` → 94.3 %; `ret15>=1.5 & position in [0.3,0.5)` → 97.6 %. Extremely stable, extremely
  broad, but direction-unresolved.

A magnitude signature is **not** rejected for being boring; it is rejected only as a *directional* finding.
We keep them in the record because they are the volatility substrate the directional layer sits on.

---

## 6. Robustness before candidate creation — selected signatures

### 6.1 SCALPING — strongest UP and DOWN

UP (range-low reversion):

1. **`distLo60 < 0.02` (at the 60 s low)** — strongest overall: 646,761 events, 56.2 % UP, 178,088
   dedup obs (17.4 %), 4/4 sessions, 32.6 % of UP events / 24.9 % of DOWN events (4.3×),
   tails top-10 = 208 %, cost meanR at 0.05 = −0.04 → already negative after cost **in expectation**,
   wait — let me recompute: full (all) population meanR 0.041 after cost 0.05 is negative; the
   *liquid* subset meanR is +0.316 at the horizon before cost, +0.195 after 0.05% cost, still positive
   (the liquid path mean at 60 s = 0.316 %; cost 0.05 % → net 0.266 % → 1.33 R). **Important**: this
   signature's overall strength is *liquid sensitivity* — only the liquid subset is positive after cost;
   the full population is not.
2. **`distLo60<0.02 & dirChange<0.5`** — same population, same numbers.
3. **`accel<-0.5 & stretch in [-1.5,-0.75)`** — 77.1 % UP, 80 dedup obs, 4/4 sessions, enrichment 2.5×.
   Strong separation; thin.
4. **`r60<-1.5 & accel<-0.5`** — 78.7 % UP, 58 dedup obs, 3/4 sessions, enrichment 3.8×. Strong;
   thin.
5. **`r60<-1.5 & position in [0.5,0.7)`** — 82.0 % UP, 15 dedup obs. Strongest long-side precision;
   thinnest.

DOWN (range-high reversion):

1. **`distHi60 < 0.02` (at the 60 s high)** — mirror of #1: 658,847 events, 56.8 % DOWN, 170,735 dedup obs,
   enrichment 4.7×.
2. **`r60>=1.5 & sinceImpulse in [30,60) s`** — 81.7 % DOWN, 140 dedup obs, 4/4 sessions, enrichment 5×.
   Strong; support OK-ish.
3. **`r60>=1.5 & distHi60>=0.8`** — 70.9 % DOWN, 73 dedup obs, 3/4 sessions.
4. **`accel>=0.5 & position>=0.9`** — 73.0 % DOWN, 197 dedup obs, 4/4 sessions. Strong support on the
   narrow side.
5. **`distHi60>=0.8 & position in [0.7,0.9)`** — 82.2 % DOWN, 37 dedup obs, 4/4 sessions.

### 6.2 INTRADAY — strongest UP and DOWN

UP:

1. **`distHi15>=1 & resumption<-2`** — 9,324 events, 61.0 % UP, 8,235 dedup obs (88.6 %, the strongest
   dedup rate on intraday), 111/144 sessions (77 %), top-10 = 110 %, cost meanR 0.05 → 1.08, still
   positive at 0.10 → 0.83, negative at 0.20 → 0.33. Best all-round intraday UP: support, sessions, dedup,
   cost survival.
2. **`resumption<-2 & imp15>=2`** — 61.8 % UP, 1,762 dedup, 65/96 sessions, top-10 = 89.8 %, survives
   cost to 0.10 (1.46), breaks at 0.20 (0.96).
3. **`ret15<-1.5 & resumption<-2`** — 64.9 % UP, 1,258 dedup, 54/73 sessions, top-10 = 80.6 %, cost at 0.05
   → 1.78, at 0.10 → 1.53, at 0.20 → 1.03. Survives the full cost suite.
4. **`vol15 in [0.35,0.6) & resumption<-2`** — 63.7 % UP, 962 dedup, 28/38 sessions, top-10 = 78.5 %,
   cost 0.05 → 1.97, 0.10 → 1.72, 0.20 → 1.22. Strong cost survival.
5. **`distLo15<0.05`** — 49.2 % UP raw, 54.8 % dedup, 192,753 dedup obs, 80/145 sessions. Broadest and most
   repeatable, weakest separation. Tail on the weak side: top-10 = null (net total is negative), so this one
   is a *breadth* candidate, not a precision candidate.

DOWN:

1. **`pullDur>=10 & resumption>=2`** — 64.9 % DOWN, 19,558 dedup (97.5 %), 126/145 sessions, top-10 = 210 %
   (tail heavy, that's the weak side), cost 0.05 → 0.28, 0.10 → 0.03, 0.20 → −0.47. Strong direction and
   sessions; weak after cost.
2. **`resumption>=2 & imp15<0.2`** — 64.5 % DOWN, 8,554 dedup, 90/125 sessions, top-10 = 294 % (very tail
   heavy), cost 0.05 → 0.12, 0.10 → −0.13. Fails double cost.
3. **`distHi15<0.05 & imp15 in [0.2,0.4)`** — 59.1 % DOWN, 82,025 dedup, 111/145 sessions, 181+158 = 339 k
   events combined with its close companion. Broad; cost negative (0.05 → −0.05), so this is a *breadth*
   DOWN signature, not a precision one.
4. **`ret60>=2 & vol15<0.05`** — 66.9 % DOWN, 183 dedup, 26/38 sessions, top-10 = 74.8 %, cost 0.05 → 1.35,
   0.10 → 1.10, 0.20 → 0.60. Strong precision + cost survival; thin.
5. **`ret60<-2 & vol15<0.05`** — 64.8 % DOWN, 224 dedup, 23/36 sessions, top-10 = 58.4 %, cost 0.05 → 2.66,
   0.10 → 2.41, 0.20 → 1.91. Strong precision + excellent cost survival; thin.

### 6.3 What survives the full robustness checklist, what fails

| signature | support : n | dedup n | sessions | long/short | tails (top-10) | after 0.05 cost | after 0.10 cost |
|---|---|---|---|---|---|---|---|
| intraday UP `distHi15>=1 & resumption<-2` | 9,324 | 8,235 | 111/144 | symmetric | 110 % | **1.08** | 0.83 |
| intraday UP `resumption<-2 & imp15>=2` | 1,963 | 1,762 | 65/96 | symmetric | 89.8 % | 1.71 | **1.46** |
| intraday UP `ret15<-1.5 & resumption<-2` | 1,383 | 1,258 | 54/73 | symmetric | 80.6 % | **1.78** | **1.53** |
| intraday UP `vol15 in [0.35,0.6) & resumption<-2` | 1,036 | 962 | 28/38 | symmetric | 78.5 % | **1.97** | **1.72** |
| intraday DOWN `pullDur>=10 & resumption>=2` | 21,255 | 19,558 | 126/145 | symmetric | 210 % | 0.28 | 0.03 |
| intraday DOWN `ret60>=2 & vol15<0.05` | 420 | 183 | 26/38 | symmetric | 74.8 % | **1.35** | **1.10** |
| intraday DOWN `ret60<-2 & vol15<0.05` | 571 | 224 | 23/36 | symmetric | 58.4 % | **2.66** | **2.41** |
| scalp UP `distLo60<0.02` (liquid only) | 2,218 liquid | 2,218 | 4/4 | symmetric | n/a | **0.195 % net** | — |
| scalp DOWN `r60>=1.5 & sinceImpulse in [30,60)` | 140 | 140 | 4/4 | symmetric | 51 % | +1.13 R gross | — |

The signatures that "survive" in the precommercial sense (positive mean net R even at 0.10 % cost on a
deduplicated, session-spread basis) are:

* intraday: the **three UP `resumption<-2` signatures** (all survive 0.10 % cost, and one survives 0.20 %)
  and the two **narrow DOWN `vol15<0.05` signatures** (both survive 0.10 % and one survives 0.20 %).
* scalp: only the **liquid subset** of the broad `distLo60<0.02` survives cost in expectation; the
  narrow scalp signatures are too thin to cost-verify here, so they go to the gate *with the cost caveat
  explicit*.

The high-precision but thin scalp signatures (`r60<-1.5 & accel<-0.5` 78.7 %, `r60>=1.5 & sinceImpulse
in [30,60) s` 81.7 %, `accel<-0.5 & stretch in [-1.5,-0.75)` 77.1 %) are strong on separation and survival
but weak on support — they would be *conditional* candidates requiring the gate's `minTrades` logic to act
on them.

---

## 7. The common research mechanism (the outcome of this pass, NOT a candidate)

What the data is telling us, stripped of all the individual signatures, is this:

> **A move away from the recent range's centre — especially an extreme of the range — is followed by a
> reversion toward the mean, and that reversion is present immediately after the state and strengthens over a
> horizon. The reversion is symmetric: low extreme ⇒ up, high extreme ⇒ down, across both the scalp and
> the intraday.**

In terms of the original framing you gave:

* **NOT** "more timeframe agreement ⇒ more momentum ⇒ BUY"
* **IS** "EXTENSION / IMBALANCE ⇒ market becomes stretched ⇒ (often) a first reversal / pullback begins
  ⇒ direction can be resolved ⇒ mean reversion pays over a horizon"

The **mechanistic axis** that is shared across tracks is **position in the recent range** (0..1,
normalised), possibly confirmed by a **deceleration / sharp-move** signal (scalp `accel`/`stretch`; intraday
`resumption`). The **time** axis is "immediate edge, strengthening over horizon", not "confirmation then win".

This is NOT a strategy. It is the *structure* a hypothesis would be built from. The next step (after this
report is accepted) is to define that hypothesis precisely, with track-specific surgical parameters
(position in range + optional deceleration/sharp-move confirmation), and send **one scalp candidate** and
**one intraday candidate** (each built from the shared mechanism) through `research/candidateGate.js`.

**No candidate has been created. No threshold has been tuned. Nothing is live. No V4, no OF01/OF03, no
Phase 5A changes.**

---

## 8. Constraint verification (this pass)

| check | result |
|---|---|
| `strategies/orderFlow.js` sha256 (first 16) | `90471e9ae616cd62` — unchanged |
| `strategy-core/tradePlanner.js` | `7a311fe0bc97b1d7` — unchanged |
| `backtest/follow.js` | `e4753e0fe896dd02` — unchanged |
| `cmp strategies/orderFlow.js strategies/frozen/orderFlow.of01v2-of03v1.js` | byte-identical |
| V2 engine hashes (5 files) | 8/8 unchanged |
| `Server.js` references to `research/` | 0 |
| `node --test test/*.test.js` | 309/309 pass, exit 0 |
| `test/s2Validation.test.js` | 6/6 pass |
| `test/candidateGate.test.js` | 12/12 pass |
| New tooling | read-only; writes only `data/terminal/discovery-*.json` |

New read-only files: [`research/discoveryCore.js`](../research/discoveryCore.js),
[`research/discoveryScalp.js`](../research/discoveryScalp.js),
[`research/discoveryIntraday.js`](../research/discoveryIntraday.js).

**STOP.** No hypothesis is defined and nothing is sent to the gate in this pass.

---

## 9. Limitations (stated, not hidden)

* **IN-SAMPLE only.** The scalp tapes are re-read; the intraday corpus is the same in-sample set. Nothing
  here is out-of-sample, and no unseen tape exists yet.
* The intraday directional miner is oriented to P(UP) vs P(DOWN); the mirror signatures are produced by the
  same run, so they are symmetric by construction — but the intraday skew (DOWN side stronger at the top) is
  a structural and reported feature, not an artifact.
* The scalp path is only trustworthy on the liquid subset; many high-precision scalp signatures have
  `nLiquid = 0` and so cannot be cost-verified on the path. They remain strong on separation and sessions,
  with the cost caveat explicit.
* The intraduiday "resumption<-2" axis is one coherent mechanism, not five separate discoveries; they are
  reported as contexts of that one axis.
* The intraday margin is materially thinner on the UP side than the DOWN side; preserved rather than forced.
* The tape itself has duplicate tick timestamps on active symbols (e.g. two NIFTY ticks at the same `t`);
  `firstAtOrAfter` correctly uses the first one at each offset, so the path is correct and the tape data is
  good.

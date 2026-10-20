# DISCOVERY SIGNATURES — SCALPING & INTRADAY

**STATUS: `FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED`**

This is **discovery research**, not a strategy. Nothing here is a candidate, nothing was
optimised, nothing is wired to production, and nothing was sent through the historical gate.
These are **DISCOVERY SIGNATURES** — recurring pre-move states that over-represent one kind of
outcome. Only after a genuine signature is identified do we define a hypothesis and send it
through `research/candidateGate.js`; that step is deliberately **not** taken here.

---

## 1. The inversion: start from the OUTCOME

Every prior study started from a signal and asked whether it worked. This one starts from what
price actually did. For each historical event — a tick on the tapes, a 1-minute bar in the corpus
— we measured the **forward** outcome, then worked backwards to the **strictly prior** state.

**Primary outcome: PROFITABLE vs UNPROFITABLE** (the requested split)

| track | forward horizon | PROFITABLE | UNPROFITABLE | MARGINAL (excluded) |
|---|---|---|---|---|
| SCALPING | 60 s | best direction ≥ +0.50 R after cost | no direction clears cost (best ≤ 0) | 0 < best < 0.50 R |
| INTRADAY | 30 min | best direction ≥ +0.50 R after cost | no direction clears cost (best ≤ 0) | 0 < best < 0.50 R |

Risk unit = 0.20 %, round-trip cost = 0.05 % (the frozen convention). A "move" exists when either
direction clears cost; the best direction is chosen **ex post**, so this measures *whether a
tradeable move existed*, not which way to trade it.

**Secondary outcome: UP vs DOWN** — among the events where a profitable move exists, did it go UP
or DOWN? This is the symmetric, outcome-first question that actually resolves direction.

**Pre-move axes** (bucket edges declared once, before the data was read, and never swept):

* **SCALPING** (from ticks, strictly before the tick): 60 s / 20 s / 10 s return, direction flip,
  acceleration (`r10 − r20`), distance below the 60 s high, distance above the 60 s low, retrace
  fraction of the 60 s leg, 60 s range, compression (`range60/range300`), range expansion
  (`range20/range60`), seconds since an impulse (`|r10| ≥ 0.20 %`), tick rate in the last 10 s.
* **INTRADAY** (from 1 m bars, strictly prior): 15/60/5-bar return, 15-bar range, largest bar
  range, distance to the 15-bar high / low / nearest extreme, bars since the context extreme,
  average 15-bar range, compression (`range15/range45`), failed break / rejection, last-bar move
  normalised by volatility ("resumption").

**Method.** One tape read per track, accumulating PROFITABLE/UNPROFITABLE (and UP/DOWN) counts
over single axes and declared axis pairs, then an exact re-evaluation of the selected signatures
from a compact row store — including **one-per-bucket de-duplication** and **top-1/5/10 % net-R
tail concentration**. Instruments: [`research/discoveryCore.js`](../research/discoveryCore.js),
[`research/discoveryScalp.js`](../research/discoveryScalp.js),
[`research/discoveryIntraday.js`](../research/discoveryIntraday.js). Outputs:
[`data/terminal/discovery-scalp.json`](../data/terminal/discovery-scalp.json),
[`data/terminal/discovery-intraday.json`](../data/terminal/discovery-intraday.json). No threshold
sweep was run; the P/U rule and every bucket edge are fixed in code.

---

## 2. Headline: what precedes a profitable move is VOLATILITY, and magnitude does not give direction

The pre-move signatures that best separate PROFITABLE from UNPROFITABLE are, across both tracks,
**recent range / extension**. This is close to a tautology: a large recent range makes a large
forward range more likely, so *some* direction clears the cost. The bases confirm how structural
this is — **20.9 %** of scalp events hold a profitable move, and **81.4 %** of intraday bars do at
the 30-minute horizon (so intraday lift is capped near 1.23).

The decisive negative: when a magnitude signature was asked *which way* its profitable move went,
the answer was a coin flip (intraday matched events: continuation-with-context 43.5 %,
reversal 45.7 %). **The magnitude signature says a move is coming; it does not say its direction.**
That is why every entry-level confirmation in the earlier candidate search destroyed the edge —
the pre-move state carries *magnitude* information early and *direction* information only weakly.

Section 3.2 / 4.2 therefore add the direction-resolving layer, which is where the tradeable
information actually lives.

Frequency notation below: **P(prof)** = share of matching events that were PROFITABLE;
**enrichment** = (signature's share of all profitable moves) ÷ (its share of all unprofitable
moves) — i.e. how much more often the state precedes a profitable move than a losing one.

---

## 3. SCALPING — DISCOVERY SIGNATURES

**Evidence:** the four tick tapes `2026-09-28 … 10-01` — 16,134,718 ticks, 10,791,275 labelled
events, 1,426 symbols. **IN-SAMPLE** (the tapes are re-read, so this can never be called
out-of-sample). Magnitude base **20.9 %** (dedup 31.2 %).

### 3.1 Top 5 pre-move signatures found in PROFITABLE moves (the requested deliverable)

Ranked by separation between good and bad outcomes, then repeatability / breadth / robustness.

| # | signature (pre-move state) | n | P(prof) | enrichment | dedup obs | dedup P(prof) | long / short | top-10 net-R | mean netR |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `r60 ≥ 1.5 % & distHi60 ∈ [0.4,0.8) %` | 960 | **95.6 %** | **83×** | 146 | 91.8 % | 92.6 / 97.5 % | 37 % | 3.83 |
| 2 | `r60 < −1.5 % & pullFrac ∈ [0.35,0.55)` | 212 | **95.3 %** | **77×** | 45 | 93.3 % | 93.0 / 98.8 % | 30 % | 4.41 |
| 3 | `r60 < −1.5 % & accel ∈ [−0.2,−0.05)` | 494 | **94.3 %** | **63×** | 155 | 91.6 % | 93.9 / 95.0 % | 40 % | 4.19 |
| 4 | `r60 < −1.5 % & distLo60 ∈ [0.4,0.8) %` | 788 | **94.0 %** | **60×** | 130 | 89.2 % | 92.9 / 95.9 % | 38 % | 3.28 |
| 5 | `sinceImpulse < 5 s` (a fresh impulse just fired) | 325,880 | **72.4 %** | **10×** | 71,696 | 57.4 % | 68.6 / 76.6 % | 42 % | 1.48 |

* **Frequency in profitable vs losing moves:** #1–#4 are rare and near-deterministic (a large
  recent 60 s extension ⇒ a move almost always follows; enrichment 60–83×, but each is ~0.001–0.01 %
  of all events). #5 is common (occurs before 10.5 % of all profitable moves vs 1.05 % of losing
  moves) — the repeatable one.
* **De-duplication:** #1–#4 **survive** (dedup P stays 89–93 %). #5 **decays** hard (72.4 % → 57.4 %),
  i.e. a large part of its raw edge is repeated/overlapping samples.
* **Extreme-winner concentration:** #1–#4 are not tail-dominated (top-10 % = 30–40 % of net R);
  #5 is mildly concentrated (42 %).
* **Long/short stability:** holds on both sides for every signature; the short side is always
  slightly stronger.
* **Broad, high-support alternates** (lower separation, far more repeatable, also surviving dedup):
  `distHi60 ∈ [0.2,0.4) %` → P(prof) 55.3 %, enrichment 4.7×, 106,441 dedup obs; `distLo60 ∈ [0.2,0.4) %`
  → 55.1 %, 4.7×, 102,822 dedup obs; `range60 ∈ [0.2,0.4) %` → 47.1 %, 3.4×, 186,407 dedup obs.

### 3.2 Direction-resolving extension (what precedes an UP move vs a DOWN move)

Directional base 49.4 % (dedup 51.2 %). This is where the tradeable information is; the top 5 are
all **mean-reversion** states.

| # | signature | n | P(UP) | dedup obs | dedup P(UP) | sessions above base | top-10 | mean netR | netPF |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `pullFrac < 0.15 & distLo60 < 0.02` (at the 60 s low, shallow retrace) | 456,170 | **58.4 %** | 131,829 | **64.9 %** | 4/4 | 163 % | 0.19 | 1.36 |
| 2 | `distLo60 < 0.02` (at the 60 s LOW) | 646,761 | **56.2 %** | 178,088 | **61.5 %** | 4/4 | 208 % | 0.18 | 1.30 |
| 3 | `distHi60 ≥ 0.8 & sinceImpulse ≥ 120 s` (far below the high, quiet ≥2 min) | 279 | **76.0 %** | 279 | **76.0 %** | 4/4 | 50 % | 3.40 | 3.97 |
| 4 | `r60 < −1.5 & sinceImpulse ∈ [30,60) s` (down extension, no fresh impulse) | 234 | **76.1 %** | 145 | **80.7 %** | 3/4 | 37 % | 7.01 | 7.68 |
| 5 | `r60 < −1.5 & accel < −0.5` (down extension, decelerating) | 235 | **78.7 %** | 58 | **70.7 %** | 3/4 | 39 % | 3.20 | 7.09 |

* All five predict **UP** from a down / at-the-low state ⇒ **short-horizon mean reversion**. The
  mirror (at the 60 s high ⇒ DOWN) is expected by symmetry but was not separately mined here.
* #1–#2 are the repeatable ones (132 k–178 k de-duplicated obs, 4/4 sessions, but tail-heavy:
  top-10 % = 163–208 % of net R). #3–#5 are high-separation but thin (~60–280 de-duplicated obs).
* **Flagged, not ranked:** `tickRate10 ∈ [120,250)` showed P(UP) 92.6 % raw but collapsed to
  **3 de-duplicated observations** — it fails the breadth test and is reported only to show the
  check working.

---

## 4. INTRADAY — DISCOVERY SIGNATURES

**Evidence:** the 1-minute corpus, all 1,028 symbols, 5,735,900 bars, 4,428,734 labelled events,
145 sessions. **IN-SAMPLE.** A 10 s / 20 s trigger is **not** claimed or validated from 1 m data.
Magnitude base **81.4 %** (dedup 79.1 %).

### 4.1 Top 5 pre-move signatures found in PROFITABLE moves (the requested deliverable)

Because the magnitude base is near-saturated, absolute separation (+13 to +16 pp) matters more
than lift (all ≈1.15–1.20).

| # | signature (pre-move state) | n | P(prof) | enrichment | dedup obs | dedup P(prof) | long / short | sessions above base | top-10 | mean netR |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `vol15 ≥ 0.6 % & compression < 0.3` | 776 | **97.7 %** | **9.6×** | 190 | 97.9 % | 97.4 / 98.0 % | 26/26 | 30 % | 8.36 |
| 2 | `distHi15 ∈ [0.15,0.3) % & vol15 ≥ 0.6` | 953 | **96.9 %** | **7.0×** | 571 | 97.0 % | 96.2 / 97.4 % | 28/30 | 31 % | 7.42 |
| 3 | `ret15 < −1.5 % & ret60 ≥ 2 %` | 1,516 | **96.8 %** | **6.8×** | 534 | 96.4 % | 96.3 / 97.2 % | 55/57 | 32 % | 6.18 |
| 4 | `ret60 ≥ 2 % & vol15 ≥ 0.6` | 11,953 | **96.6 %** | **6.5×** | 1,699 | 95.9 % | 95.1 / 97.7 % | 78/78 | 32 % | 7.82 |
| 5 | `vol15 ∈ [0.35,0.6) %` | 85,192 | **94.0 %** | **3.6×** | 13,583 | 93.4 % | 92.4 / 95.5 % | 141/144 | 33 % | 4.53 |

* **Frequency in profitable vs losing moves:** #1–#4 precede 6.5–9.6× more profitable moves than
  losing ones but are rare; #5 is the repeatable one (before 2.2 % of all profitable moves vs
  0.62 % of losing moves, 13,583 de-duplicated observations).
* **De-duplication:** all five **survive** cleanly (dedup P within ~1 pp of raw).
* **Session / time stability:** very high — #5 appears above base in 141/144 sessions, #4 in 78/78.
* **Long/short stability:** holds on both sides; the short side is consistently a little stronger.
* **Extreme-winner concentration:** moderate (top-10 % = 30–33 % of net R).
* **Broad alternates:** `imp15 ≥ 2 %` → P(prof) 94.3 %, enrichment 3.75×, 12,854 dedup obs;
  `distNearest ≥ 0.6 %` → 94.0 %, 3.6×, 20,569 dedup obs; both stable in ≥143/145 sessions.

The reading is blunt and honest: these separate profitable from losing moves **because they measure
volatility**, not because they identify a direction.

### 4.2 Direction-resolving extension (what precedes an UP move vs a DOWN move)

Directional base 45.3 % (dedup **50.7 %**).

| # | signature | n | P(UP) | dedup obs | dedup P(UP) | sessions above base | top-10 | mean netR | netPF |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `distHi15 ≥ 1 % & resumption < −2` (≥1 % below the high, last bar sharply down) | 9,324 | **61.0 %** | 8,235 | **61.6 %** | 111/144 (77 %) | 93 % | 1.27 | 1.90 |
| 2 | `ret15 < −1.5 % & resumption < −2` | 1,383 | **64.9 %** | 1,258 | **65.7 %** | 54/73 (74 %) | 73 % | 1.96 | 2.19 |
| 3 | `ret60 < −2 % & resumption < −2` | 2,824 | **60.5 %** | 2,449 | **61.6 %** | 75/110 (68 %) | 97 % | 1.26 | 1.87 |
| 4 | `resumption < −2 & imp15 ≥ 2 %` | 1,963 | **61.8 %** | 1,762 | **61.7 %** | 65/96 (68 %) | 81 % | 1.90 | 2.03 |
| 5 | `vol15 ∈ [0.35,0.6) & resumption < −2` | 1,036 | **63.7 %** | 962 | **63.7 %** | 28/38 (74 %) | 72 % | 2.15 | 2.24 |

* **Independence — the key caveat:** **all five contain `resumption < −2`.** They are one axis
  (the last completed bar closing sharply down, relative to volatility) shown in five contexts, not
  five independent findings. The intraday directional discovery collapses to **a single**
  pre-move signature: a short-term oversold bounce.
* **Separation:** +15 to +20 pp over the raw base and still +11 to +15 pp over the stricter
  de-duplicated base.
* **Session / time stability:** above base in 68–77 % of the sessions in which the signature occurs.
* **Tail dependence:** **strong** — top-10 % of matched trades carry 72–97 % of net R.
* A high-support variant `distLo15 < 0.05` (at the 15-bar low) → P(UP) 49.2 % raw, 54.8 %
  de-duplicated, 192,753 de-duplicated obs, 80/145 sessions — broad but weak and heavily
  tail-dominated (top-10 = 448 %).

---

## 5. Ranking by the five criteria

### 5.1 SCALPING — profitable vs unprofitable (requested ranking)

1. `r60 ≥ 1.5 % & distHi60 ∈ [0.4,0.8) %` — best separation (95.6 %, 83× enrichment), survives
   dedup at 91.8 %; thin breadth. *Independence: two range/extension axes (weakly independent).*
2. `r60 < −1.5 % & pullFrac ∈ [0.35,0.55)` — 95.3 %, 77×, dedup 93.3 %; thinnest breadth (45).
3. `sinceImpulse < 5 s` — the repeatable one: 72.4 %, 10× enrichment, 71,696 dedup obs; **dedup
   decays to 57.4 %**, which caps its rank.
4. `r60 < −1.5 % & accel ∈ [−0.2,−0.05)` — 94.3 %, 63×, dedup 91.6 %, 155 obs.
5. `r60 < −1.5 % & distLo60 ∈ [0.4,0.8) %` — 94.0 %, 60×, dedup 89.2 %, 130 obs.

Direction-resolving ranking (secondary): (1) `pullFrac < 0.15 & distLo60 < 0.02`;
(2) `distLo60 < 0.02`; (3) `distHi60 ≥ 0.8 & sinceImpulse ≥ 120 s`;
(4) `r60 < −1.5 & sinceImpulse ∈ [30,60) s`; (5) `r60 < −1.5 & accel < −0.5`.

### 5.2 INTRADAY — profitable vs unprofitable (requested ranking)

1. `vol15 ≥ 0.6 % & compression < 0.3` — best separation (97.7 %, 9.6×), dedup 97.9 %; thin.
2. `distHi15 ∈ [0.15,0.3) % & vol15 ≥ 0.6` — 96.9 %, 7.0×, dedup 97.0 %, 26/30 sessions.
3. `ret60 ≥ 2 % & vol15 ≥ 0.6` — 96.6 %, 6.5×, dedup 95.9 %, 78/78 sessions.
4. `vol15 ∈ [0.35,0.6) %` — the repeatable one: 94.0 %, 3.6×, 13,583 dedup obs, 141/144 sessions.
5. `ret15 < −1.5 % & ret60 ≥ 2 %` — 96.8 %, 6.8×, dedup 96.4 %.

Direction-resolving ranking (secondary, all one axis): (1) `distHi15 ≥ 1 % & resumption < −2`;
(2) `ret15 < −1.5 % & resumption < −2`; (3) `ret60 < −2 % & resumption < −2`;
(4) `resumption < −2 & imp15 ≥ 2 %`; (5) `vol15 ∈ [0.35,0.6) & resumption < −2`.

---

## 6. What the discovery actually says (the mechanism)

Two findings, one negative and one positive:

1. **Magnitude ≠ direction.** The signatures that separate profitable from losing moves are
   volatility/range signatures, and they leave direction near a coin flip. Any design that reads
   them as a direction is reading noise.
2. **The direction-resolving signal is short-horizon MEAN REVERSION.** In both tracks the
   profitable move tends to run *against* the recent move once price is at the edge of its recent
   range: SCALPING — at/near the 60 s low, or after a down extension that has decelerated or gone
   quiet, the move is UP (56–79 % vs a 49 % base); INTRADAY — after the last bar closes sharply
   down, the move is UP (61–65 % vs a 45 % base / 50.7 % de-duplicated).

This is consistent with the earlier program finding that the S2 object's edge is a **reversal**
edge and that **earlier is better** — every confirmation tick destroyed the edge because the
reversion information is already in the pre-move state.

---

## 7. Scope, limits, and what is deliberately NOT done

**Limits (stated, not hidden):**

* **IN-SAMPLE only.** The scalping tapes are re-read; the 1 m corpus is the same in-sample set. No
  unseen tape exists yet, so nothing here is out-of-sample.
* The intraday directional miner was oriented to P(UP); down-predicting mirror signatures are
  expected by symmetry but were not separately mined.
* The magnitude miner was oriented to P(profitable); it cannot surface down-predictors by
  construction.
* Several reported signatures would fail a real gate on tail concentration alone — which is
  exactly why tail share and de-duplication are shown for every one.

**NOT done (by instruction):** no strategy, no candidate, no V4, no threshold optimisation, no
production wiring, no orders, no OF01/OF03 or Phase 5A change, no live deployment, and **no gate
submission**. The gate is used only after a signature becomes a defined hypothesis.

**Constraint verification (this pass):**

| check | result |
|---|---|
| `strategies/orderFlow.js` sha256 (first 16) | `90471e9ae616cd62` — unchanged |
| `strategy-core/tradePlanner.js` | `7a311fe0bc97b1d7` — unchanged |
| `backtest/follow.js` | `e4753e0fe896dd02` — unchanged |
| `cmp strategies/orderFlow.js strategies/frozen/orderFlow.of01v2-of03v1.js` | byte-identical |
| V2 engine hashes (`rocEngineV2`, `rocEngine`, `outcomeTracker`, `signalJournal`, `scalpV2Service`) | 8/8 unchanged |
| `Server.js` references to `research/` | 0 |
| `node --test test/*.test.js` | 309/309 pass, exit 0 |
| new tooling | read-only; writes only `data/terminal/discovery-*.json` |

New read-only files: [`research/discoveryCore.js`](../research/discoveryCore.js),
[`research/discoveryScalp.js`](../research/discoveryScalp.js),
[`research/discoveryIntraday.js`](../research/discoveryIntraday.js).

**STOP.** No hypothesis is defined and nothing is sent to the gate in this pass.

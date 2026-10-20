# OF04 — RESEARCH INFRASTRUCTURE + COST ANALYSIS

> **No candidate created. No threshold tuned. No V5. No production change. OF01/OF03 and Phase 5A
> untouched. No post-hoc liquidity filter. The failed OF04 candidates stay failed and unchanged.**

Scope of this turn: **research infrastructure and cost analysis only.**

**New / changed read-only tooling:**
[research/discoveryCore.js](research/discoveryCore.js) (added `dumpEvents`) ·
[research/discoveryScalp.js](research/discoveryScalp.js) (added `--events=`) ·
[research/discoveryIntraday.js](research/discoveryIntraday.js) (added `--events=`) ·
[research/eventOutcomes.js](research/eventOutcomes.js) (new analyser) ·
[research/of04CostLadder.js](research/of04CostLadder.js) (new ladder)

**Artifacts:**
[data/terminal/of04-events-scalp.jsonl](data/terminal/of04-events-scalp.jsonl) (473 MB) ·
[data/terminal/of04-events-intraday.jsonl](data/terminal/of04-events-intraday.jsonl) (249 MB) ·
[data/terminal/of04-event-outcomes-scalp.json](data/terminal/of04-event-outcomes-scalp.json) ·
[data/terminal/of04-event-outcomes-scalp-liquid.json](data/terminal/of04-event-outcomes-scalp-liquid.json) ·
[data/terminal/of04-event-outcomes-scalp-universe.json](data/terminal/of04-event-outcomes-scalp-universe.json) ·
[data/terminal/of04-event-outcomes-intraday.json](data/terminal/of04-event-outcomes-intraday.json) ·
[data/terminal/of04-event-outcomes-intraday-universe.json](data/terminal/of04-event-outcomes-intraday-universe.json)

Evidence is still the discovery corpus — **IN-SAMPLE**.

---

## 1. Data-storage fix — STATUS: DONE

**Problem.** The discovery row store carried, per event, day / direction / class / feature buckets /
the forward path / second-of-day / symbol — but only *aggregates* were persisted. The aggregate JSON
cannot reconstruct a **true win rate, per-session net R, max drawdown, tail contribution, symbol
concentration, or an exact de-duplicated outcome**, because those are properties of the events, not
of the signature mean.

**Fix (additive, opt-in).** `discoveryCore.dumpEvents(rowsFile, features, selected, opts, outFile)`
re-reads the existing row store and writes one JSONL record per **matched** event:

```
{"s":<sigIdx>,"d":<dayIdx>,"y":<symbol>,"k":<secOfDay>,"u":<1 UP|0 DOWN>,"c":<class>,
 "g":<gross %>,"n":<net % after cost>,"r":<net R>,"p":[forward path in predicted direction],
 "f":[feature buckets]}
```

plus a header line (feature keys, offsets, risk/cost, days, symbol names, signature list). Both
drivers accept `--events=<file>`; when omitted nothing changes. The matching test and the
signed-return convention are **identical** to `evaluateSelected`, so the persisted conclusions are
unchanged.

**Runs (read-only; existing discovery JSONs were written to separate `--out` paths and their mtimes
are unchanged):**

| track | file | events | size | wall |
|---|---|---|---|---|
| SCALP | [of04-events-scalp.jsonl](data/terminal/of04-events-scalp.jsonl) | 2,609,237 | 473 MB | 9m06s |
| INTRADAY | [of04-events-intraday.jsonl](data/terminal/of04-events-intraday.jsonl) | 1,308,342 | 249 MB | 48s |

**Faithfulness check.** Re-deriving the four OF04 branches from the event file reproduces the
persisted aggregates exactly: scalp `distLo60<0.02` n = 646,761, win 56.2 %, gross 0.206 R,
net −0.044 R @0.05 %; `distHi60<0.02` n = 658,847, win 56.8 %, net −0.136 R — and the intraday
branches likewise. The storage change is additive and conclusion-neutral.

`research/eventOutcomes.js` turns an event file into: true win rate, gross/net expectancy, net PF,
whole-sample max drawdown, per-session net R + positive-session coverage, top-1/5/10 % tail shares,
symbol concentration (top-symbol share and HHI), exact de-duplicated outcomes, and the full cost
ladder. It accepts an optional **pre-declared** universe (`--symbols=<list|json>`) or a pre-declared
feature flag (`--liquid=<feature:minBucket>`) — one frozen rule, never a search.

---

## 2. Cost ladder — SCALP

`netR(cost) = (gross% − cost)/0.20` — exact and linear; 0.15 % is interpolated on that identity,
not fitted. Source: [research/of04CostLadder.js](research/of04CostLadder.js).

| branch | gross R | **break-even cost** | 0 % | 0.02 % | **0.05 %** | 0.10 % | 0.15 % |
|---|---|---|---|---|---|---|---|
| UP `distLo60<0.02` | +0.206 | **0.0412 %** | +0.206 | +0.106 | **−0.044** | −0.294 | −0.544 |
| DOWN `distHi60<0.02` | +0.114 | **0.0229 %** | +0.114 | +0.014 | **−0.136** | −0.386 | −0.636 |
| **COMBINED** | +0.160 | **0.0320 %** | +0.160 | +0.060 | **−0.090** | −0.340 | −0.590 |

**Where it turns:** the combined scalp mechanism is profitable only **below ≈ 0.032 % round-trip**
(≈ 3.2 bp). At the assumed 0.05 % it is negative; at 0.10 % and 0.15 % it is deeply negative.
The DOWN leg's break-even (2.3 bp) is worse than the UP leg's (4.1 bp).

---

## 3. Cost ladder — INTRADAY

| branch | gross R | **break-even cost** | 0 % | 0.02 % | **0.05 %** | 0.10 % | 0.15 % |
|---|---|---|---|---|---|---|---|
| UP `distLo15<0.05` | +0.122 | **0.0244 %** | +0.122 | +0.022 | **−0.128** | −0.378 | −0.628 |
| DOWN `distHi15<0.05 & imp15 in [0.2,0.4)` | +0.197 | **0.0394 %** | +0.197 | +0.097 | **−0.053** | −0.303 | −0.553 |
| **COMBINED** | +0.142 | **0.0284 %** | +0.142 | +0.042 | **−0.108** | −0.358 | −0.608 |

**Where it turns:** the combined intraday mechanism is profitable only **below ≈ 0.028 %
round-trip** (≈ 2.8 bp). At 0.05 % it is negative; at 0.10 %/0.15 % deeply negative. The DOWN leg
(3.9 bp) is the stronger side; the UP leg's break-even is 2.4 bp.

> **Both mechanisms cross zero between 0.02 % and 0.05 %.** The assumed 0.05 % is therefore *not*
> the cause of failure — the honest headline is that each needs roughly **3 bp or less**, well below
> a realistic Indian-equity round trip (brokerage + STT + exchange + GST + slippage).

---

## 4. Is there a PRE-DECLARED cost-surviving universe?

Two pre-existing, independently-justified eligibility definitions were available. **Neither was
searched**; each was frozen, then measured once.

### 4.1 Scalp — production universe snapshot
`data/universe_filtered.json` (1,006 symbols; rules: price ≥ ₹100, turnover ≥ ₹5 Cr/20-bar,
volume ≥ 1000, ATR band 1.5–8 %, staleness ≤ 3 days — a liquidity/volatility/data-integrity
definition, independent of any strategy).

| scalp universe | combined n | net R @0.05 % | positive sessions | symbols | topSym share | HHI |
|---|---|---|---|---|---|---|
| full population | 1,305,608 | **−0.090** | 0/4 | 1,257 | 1.6 % | 0.002 |
| production universe | 1,109,912 | **−0.106** | 0/4 | 1,006 | 0.9 % | 0.002 |

**Still negative.** The production universe does **not** rescue the scalp mechanism.

### 4.2 Scalp — the in-discovery liquid flag (`tickRate10 ≥ 30 ticks/10 s`)
This flag was declared **inside** the discovery code before any result (a data-quality rule: a symbol
at ~1 tick/s moves 10–20 micro-pips/s, so its 60 s path is structurally invisible).

| scalp universe | combined n | net R @0.05 % | net R @0.15 % | symbols | topSym | HHI | dedupN |
|---|---|---|---|---|---|---|---|
| `tickRate10 ≥ 30` | 3,696 | **+0.536** | +0.036 | **1** | **NIFTY** | **1.000** | **10** |

This slice *does* look cost-positive — **and it is invalid as a universe.** It is a **single
instrument (NIFTY)**: one symbol (HHI = 1.000), 2,692 events, only **10 de-duplicated observations**
across 4 sessions. It has **zero overlap** with the production equity universe
(`--symbols=data/universe_filtered.json --liquid=tickRate10:3` → **0 matched events**). The
"liquid subset becomes positive" observation from the discovery report is therefore an
**index-tick artifact**, not a tradeable equity universe.

### 4.3 Intraday — production universe snapshot

| intraday universe | combined n | net R @0.05 % | positive sessions | symbols | topSym share | HHI |
|---|---|---|---|---|---|---|
| full population | 692,009 | **−0.108** | 77/145 | 1,028 | 1.3 % | 0.002 |
| production universe | 631,814 | **−0.118** | 66/142 | 995 | 0.8 % | 0.002 |

**Still negative.** The intraday discovery feature set has **no liquidity axis at all**, so no other
pre-declared liquid universe can be evaluated from the frozen artifacts — a stated limitation, and
the reason event persistence (now built) matters for any future run.

### 4.4 Concentration and de-duplication (the failure is not concentration)

* **Symbol concentration is low on both full populations** (HHI 0.002; the top symbol carries
  0.8–1.6 % of absolute net R). Neither mechanism fails because of one name.
* Tail shares are **undefined** because the branch net totals are negative — a share of a negative
  total is not interpretable, and this is reported as unavailable rather than invented.
* **De-duplicated** (one event per symbol × 60 s / 15 min bucket): scalp combined **+0.111 R**
  (n = 195,259), intraday combined **−0.146 R** (n = 19,432). The scalp dedup value is positive as a
  *diagnostic* (first-event-per-bucket selection, in-sample) but it does not repair the result: the
  raw combined is negative, positive-session coverage is 0/4, and the effect is still sub-cost for
  most of the population. It is recorded, not promoted.

---

## 5. Does the mechanism survive after realistic costs?

**No — on the intended (full and production-universe) population, at any realistic cost.**

* SCALP: full −0.090 R @0.05 %; production universe −0.106 R; break-even ≈ 0.032 %.
* INTRADAY: full −0.108 R @0.05 %; production universe −0.118 R; break-even ≈ 0.028 %.
* Both are negative at 0.10 % and 0.15 %; both are positive only at ≤ 0.02 %.
* The one positive scalar (scalp `tickRate10 ≥ 30` → +0.536 R) is a **single-index artifact** with
  no overlap in the real universe.

---

## 6. Mechanism verdict — A / B / C

* **A) genuinely untradeable at our cost — SUPPORTED for both tracks.** On the intended universe the
  combined two-sided candidates are cost-negative with break-even costs (~3 bp) below any realistic
  round trip. This is the primary conclusion.
* **B) tradeable only in an independently defined execution/liquidity universe — NOT SUPPORTED.**
  The only positive slice (scalp `tickRate10`) collapses to a **single symbol (NIFTY)** with
  HHI = 1.0 and **zero overlap with the production universe**; the production universes leave both
  tracks negative. No *valid* cost-surviving universe was found.
* **C) the gross effect is too weak/unstable to pursue — PARTIALLY, and precisley "too weak", not
  "unstable".** The gross edge is small but *stable and broad* (+0.16 R scalp / +0.14 R intraday,
  HHI ≈ 0.002, directionally consistent across many sessions). It is simply **smaller than the
  cost**. So the accurate reading is **A**, with **C's "weak"** qualifier; **B is rejected**.

Equivalently: the mechanism is real and broad, and it is priced out.

---

## 7. What evidence would be required before creating another candidate

1. **An independently justified cost that is actually ≤ break-even.** If a round trip for the target
   universe is claimed at ≤ ~3 bp, it must be shown from a **fee schedule and measured slippage** —
   never chosen because it makes PF positive. (The assumed 0.05 % is not lowered here.)
2. **A pre-declared, multi-instrument execution universe** that is genuinely liquid *by an
   independent rule*, frozen before measurement, with **breadth** (many symbols) — not one index.
3. **Event-level evidence on that universe** (now available via `--events=` + `eventOutcomes.js`):
   per-session net R, exact de-duplicated outcomes, tail shares, and symbol breadth, all reported.
4. **Genuinely unseen sessions** consumed by a frozen definition — no in-sample re-use to optimise.
5. **No filter added to OF04.** A new candidate may only be justified by a *separate* research
   question (e.g. a proven lower-cost execution universe, or a different horizon), not by tuning the
   failed design.

Until those exist, **nothing here becomes a strategy and OF04 stays failed.**

---

## Constraint verification

| check | result |
|---|---|
| OF04 candidates modified / tuned | **no** — unchanged, still REJECT ✅ |
| cost assumption lowered to force a pass | **no** — 0.05 % kept; 0.15 % added ✅ |
| filters added to OF04 based on results | **no** ✅ |
| V4 / V5 created | **no** ✅ |
| production code / live signal logic changed | **no** ✅ |
| OF01/OF03 / Phase 5A touched | **no** ✅ |
| post-hoc liquidity filter applied | **no** — one pre-declared rule measured once ✅ |
| discovery conclusions changed | **no** — `dumpEvents` is additive; discovery JSON mtimes unchanged ✅ |
| new tooling | read-only; writes `data/terminal/of04-events-*.jsonl` and `of04-event-outcomes-*.json` ✅ |

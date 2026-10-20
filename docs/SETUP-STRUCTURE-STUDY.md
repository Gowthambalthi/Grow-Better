# SETUP STRUCTURE STUDY — READ-ONLY

**No strategy was implemented. No engine was wired in. No score, no voting, no composite indicator, no orders. V2/V3 and the frozen OF01/OF03 strategy and Phase 5A are untouched. No V4.**

The question was: which **market structures / setups** actually carry edge — determined from the *sequence of events on the price path*, not from a count of green indicators. This study classifies every moment by the shape of its preceding path and measures what price did next, using the **same outcome tracker** and the **same cost model** (risk 0.20%, cost 0.05%) as everything else.

Tools (read-only, not wired into the server):
- [research/scalpStructures.js](research/scalpStructures.js) — tick tapes
- [research/intradayStructures.js](research/intradayStructures.js) — 1m corpus
- [research/structureMetrics.js](research/structureMetrics.js) — PF/DD/long-short/chase/cost metrics
- Data: [data/terminal/setup-study-scalping.json](data/terminal/setup-study-scalping.json) · [data/terminal/setup-study-intraday.json](data/terminal/setup-study-intraday.json)

## Data examined

| system | source | sample |
|---|---|---|
| Scalping | 4 tick tapes (2026-09-28…10-01) | 16,134,718 ticks · ~938/967/1404/1145 symbols per day |
| Intraday | `data/ohlcv_1m` | 1,028 symbols · 23,766 symbol-sessions · 6,350,921 1m bars · 145 sessions |

Context for intraday is computed as rolling windows over 1m closes (15-bar ≈ 15m, 60-bar ≈ 60m), so no separate aggregation can drift. **The 1m corpus has no sub-minute data, so the tightest available trigger is 1m**; the 10s/20s trigger layer exists only in the tick tapes.

## The archetypes (fixed, pre-declared, NOT tuned)

Each uses only the 2–3 facts that define it. Every one records its setup type and reason, and a `late` flag.

**S1 / I1 — CONTINUATION PULLBACK**
- *Market state*: a directional impulse already exists.
- *Setup*: price pulls back into a controlled band (25–70% of the impulse) without giving the impulse back.
- *Trigger*: the short window re-accelerates in the impulse direction.
- *Invalidation*: pullback exceeds the impulse origin, or re-acceleration fails.
- *No-chase*: entering within 0.05% (scalp) / at the 60-bar extreme (intraday) of the impulse high — no real pullback.

**S2 / I2 — EXTENSION REVERSAL**
- *Market state*: a large move has already happened (|20s| ≥ 0.30% scalp; |15m| ≥ 1.00% intraday).
- *Setup*: the move is decelerating (short return shrinking / turning) while still extended.
- *Trigger*: the short return crosses against the extension.
- *Invalidation*: the extension re-accelerates.
- *No-chase*: entering after >50% of the extension has already retraced.

**S3 / I3 — COMPRESSION EXPANSION**
- *Market state*: recent range is compressed vs its own baseline (60s ≤ 0.5×300s, ≤0.40% scalp; 15-bar ≤ 0.5×45-bar intraday).
- *Setup*: an expansion bar/tick breaks the compression box.
- *Trigger*: the break itself.
- *Invalidation*: price falls back inside the box.
- *No-chase*: entering after the break already extended >2× the burst unit.

**S4 / I4 — FAILED MOVE / FAILED BREAKOUT**
- *Market state*: a leg was in progress and made a marginal new extreme.
- *Setup*: the extreme fails and price crosses back through it.
- *Trigger*: the cross-back.
- *Invalidation*: price reclaims the extreme.
- *No-chase*: entering after the failure move already ran >2× the failure threshold.

**S5 / I5 — EXTENDED / NO-CHASE (control, not a trade candidate)**
- *Market state*: short, medium and long windows are all aligned in one direction.
- *Setup/trigger*: price is at the recent extreme. **This is the "all timeframes green" case.**
- *No-chase*: this archetype IS the chase. It exists to measure what happens when you take it.

---

## SYSTEM 1 — SCALPING — results (ranked)

| rank | archetype | trades | win% | grossPF | netPF | expR | netExpR | late% | freq/ss |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **S2_EXTENSION_REVERSAL** | 8,368 | 52.8% | **1.05** | 0.75 | **+0.033** | −0.217 | 8.0% | 1.88 |
| 2 | **S1_CONTINUATION_PULLBACK** | 109,993 | 46.7% | 1.00 | 0.51 | +0.001 | −0.249 | 7.2% | 24.70 |
| 3 | S4_FAILED_MOVE | 224,409 | 36.7% | 0.65 | 0.34 | −0.159 | −0.409 | 16.9% | 50.38 |
| 4 | S3_COMPRESSION_EXPANSION | 90,480 | 35.4% | 0.64 | 0.32 | −0.149 | −0.399 | 4.7% | 20.31 |
| 5 | **S5_EXTENDED_NO_CHASE** | 54,255 | 34.4% | **0.59** | 0.41 | **−0.318** | −0.568 | 100% | 12.18 |

Every hour, both directions, both long and short were consistent: only S2 has a gross edge, and it is small. **No scalping structure clears the 0.05% cost.** The chase control (S5) is the single worst archetype on the scalp horizon — a 34.4% win rate and PF 0.59.

## SYSTEM 2 — INTRADAY — results (ranked)

| rank | archetype | trades | win% | grossPF | netPF | expR | netExpR | late% | freq/ss |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **I2_EXTENSION_REVERSAL** | 23,733 | 49.1% | **1.17** | 1.01 | **+0.271** | **+0.021** ⚠ | 3.6% | 1.00 |
| 2 | **I1_TREND_PULLBACK_CONTINUATION** | 7,137 | 41.2% | **1.10** | 0.91 | +0.123 | −0.127 | 0.0% | 0.30 |
| 3 | I4_FAILED_BREAKOUT_REVERSAL | 118,540 | 44.6% | 0.99 | 0.80 | −0.011 | −0.261 | 19.9% | 4.99 |
| 4 | I3_COMPRESSION_EXPANSION | 117,582 | 42.9% | 0.85 | 0.63 | −0.126 | −0.376 | 0.0% | 4.95 |
| 5 | **I5_EXTENDED_NO_CHASE** | 40,206 | 36.3% | **0.72** | 0.62 | **−0.560** | −0.810 | 100% | 1.69 |

---

## THE DECISIVE CAVEAT — the intraday "positive" is a close-of-session artifact

`I2_EXTENSION_REVERSAL` shows a positive *aggregate* (netPF 1.01, netExpR +0.021). It is **not** a robust edge. Broken down by IST hour:

| hour | trades | win% | netExpR | share of total |
|---|---|---|---|---|
| 10:00 | 4,314 | 49.4% | −0.546 | −472% |
| 11:00 | 4,843 | 50.2% | −0.366 | −355% |
| 12:00 | 3,703 | 52.6% | −0.212 | −157% |
| 13:00 | 3,216 | 53.0% | −0.153 | −98% |
| 14:00 | 4,078 | 53.4% | −0.073 | −60% |
| **15:00** | **3,579** | **35.5%** | **+1.733** | **+1242%** |

**Every hour except the last is negative.** The aggregate is positive only because ~3,579 late-session entries produce a few outsized winners (35.5% win rate with a large positive mean = extreme positive skew). That is a close-of-session structure, not a repeatable edge, and it must be investigated before anything is believed. The same bucket shows `I1` collapsing to a 1.6% win rate (entries that cannot complete their horizon before the close settle essentially flat and pay the cost).

**This is exactly the failure mode the framework was meant to avoid: a good-looking aggregate that survives only in one regime.** Ranking by aggregate PF alone would have promoted `I2`.

---

## THE NO-CHASE FINDING (validated in both systems)

The "all timeframes aligned, price at the extreme" case is, in both systems, the **worst** archetype:

| | trades | win% | grossPF | expR |
|---|---|---|---|---|
| S5_EXTENDED_NO_CHASE (scalp) | 54,255 | 34.4% | 0.59 | −0.318 |
| I5_EXTENDED_NO_CHASE (intraday) | 40,206 | 36.3% | 0.72 | −0.560 |

Compared with the *pullback* versions of the same directional idea (S1: grossPF 1.00; I1: grossPF 1.10), **waiting for a controlled pullback instead of chasing the extended move swings gross PF from ~0.6 to ~1.0–1.1.** The core principle — direction ≠ entry, and more timeframe agreement = later entry — is supported by this data. `lateEntries` is recorded per archetype (S2 8.0%, I4 19.9%, I5 100%).

---

## Ranking summary (top 5 each, by historical evidence)

**SCALPING**
1. **S2_EXTENSION_REVERSAL** — the only gross-positive scalp structure (PF 1.05, expR +0.033). *Rejected net:* −0.217R at cost.
2. **S1_CONTINUATION_PULLBACK** — structurally sound, gross ~flat (PF 1.00); the pullback requirement clearly helps vs chasing. *Rejected net.*
3. **S4_FAILED_MOVE** — high frequency (50/ss) but negative gross; the "failure" is too common to be informative.
4. **S3_COMPRESSION_EXPANSION** — negative gross; the compression trigger fires far too often to be a real compression.
5. **S5_EXTENDED_NO_CHASE** — the control; decisively negative, as designed.

**INTRADAY**
1. **I2_EXTENSION_REVERSAL** — best gross (PF 1.17) and the only positive *aggregate*, but ⚠ **the edge lives entirely in the 15:00 bucket**; all earlier hours are negative. *Candidate only if the late-session effect survives investigation.*
2. **I1_TREND_PULLBACK_CONTINUATION** — solid gross (PF 1.10) and the cleanest structure (0% late entries), but low frequency (0.30/ss) and net-negative (−0.127R).
3. **I4_FAILED_BREAKOUT_REVERSAL** — gross ~flat (PF 0.99); rejection is too frequent/marginal.
4. **I3_COMPRESSION_EXPANSION** — negative gross; compression detection is too loose (freq 4.95/ss).
5. **I5_EXTENDED_NO_CHASE** — the control; worst archetype (PF 0.72, expR −0.560).

## Positive-history gate verdict

**No structure is approved for live shadow testing.** Under the stated gate — negative candidates are not sent to live testing — the honest status is:

- **Nothing passes cleanly.** All scalping structures are net-negative after cost.
- **`I2_EXTENSION_REVERSAL` is the only aggregate-positive candidate, but it is not robust** (single-hour concentration). It goes to investigation, not to live.
- **`I1_TREND_PULLBACK_CONTINUATION` and `S2_EXTENSION_REVERSAL`** are the two structures with a genuine *gross* edge and a sound mechanism; they are the most defensible basis for a future candidate, but currently sub-cost.

The one thing this study establishes firmly is negative: **chasing extended aligned moves is the worst thing either system can do**, and requiring a pullback is a large improvement in gross terms.

## Limitations

- Scalping evidence is 4 discovery sessions only — **not** Phase 5A independent evidence (`Phase 5A = INCONCLUSIVE`, `Phase 6 = NOT ALLOWED`, `Phase 7 = NOT ALLOWED`).
- Intraday trigger is 1m (no sub-minute data in the corpus); the intended 10s/20s trigger layer is untested on 145 sessions.
- `maxDrawdownR` is cumulative R across the pooled sample and therefore scales with trade count; `maxDrawdownRPerTrade` is the comparable figure.
- Thresholds were pre-declared and fixed, but they are still choices; a different band would move the counts. None was tuned after seeing results.
- The 15:00 intraday bucket needs a dedicated look (settlement timing / last-bar behaviour) before any conclusion about late-session edge.

**Next step (not done here):** investigate the intraday late-session effect, and if it is real and mechanically explainable, take `I2` or `I1` forward — one at a time — as a frozen candidate for shadow testing. No implementation yet.

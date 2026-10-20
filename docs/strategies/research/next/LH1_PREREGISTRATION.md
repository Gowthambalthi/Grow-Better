# LH-1 — LONGER-HORIZON DIRECTIONAL RESPONSE
## Paste-ready pre-registration (one mechanism, one cell, post-today data only)

**Axis chosen: longer holding period.** Rationale over NIFTY futures is at the end.

---

## 0. Preconditions (do not run until all true)

1. **Data pipeline live**: daily 1m ingest for the PIT-eligible universe, token refresh, staleness
   alert, holiday calendar. A session is "valid" only if it passes the same completeness rule used by
   the OR1 shadow layer (>= 90% of that session's PIT-eligible symbols with 1m bars reaching 15:00).
2. **Data boundary**: every session used for the *decision* is dated **after 2026-10-05**. The 12
   historical dev sessions are NOT evidence for LH-1. The locked 5 sessions (2026-09-24…09-30)
   remain sealed and are not opened.
3. Baselines, ATR/volatility thresholds and universe come from prior sessions only (PIT).

---

## 1. Single hypothesis (frozen)

After a **completed 1m high-volatility + price/volume expansion event in the opening window**, price
**continues directionally over a 60-minute horizon** by materially more than a 7 bp round-trip cost.

**Change from prior work:** exactly one axis — the **horizon** (10 minutes → 60 minutes). The event
and the entry are unchanged, so the test isolates the cost-to-move ratio.

---

## 2. Frozen specification

| Element | Value |
|---|---|
| Instrument | Normal NSE cash equities only (no futures/options/ETF/SME/T2T) |
| Universe | existing PIT screen: trailing-5-session turnover >= ₹25 Cr, price >= ₹100, >=16/20 nonzero 1m bars |
| Volatility condition | causal 1m ATR in the **census Q5** (boundary read from SC Census 1; no re-optimisation) |
| Expansion event | completed 1m bar with range >= 1.5x prior-20 median AND volume >= 2.0x prior-20 median |
| Direction | sign of the signal bar's ROC(1) (candle direction); both sides pooled |
| Window | 09:30–10:30 only |
| Entry | next 1m open after the completed signal bar |
| **Exit** | **close of the 60th completed 1m bar after entry (one horizon, fixed)** |
| Stop / target | none (measures the raw directional move) |
| Cost | 7 bp primary; 3 / 5 / 10 bp sensitivity |
| Position control | one open position per symbol; 5-bar cooldown after exit |
| Diagnostics only | 30-min and 90-min horizons, and reach rates at 15/25/40/60/80 bp (never used for the decision, never tuned) |

This is **one cell**, not a grid: one event × one context × one window × one horizon.

---

## 3. Power plan (set before any result is read)

Session-level aggregation only (overlapping minutes are not independent). For a one-sample test on
session means, the number of sessions needed for 80% power at one-sided α = 0.05 is

  n ≈ 6.18 · (σ_session / δ)²

where δ is the true net edge (bp) and σ_session the across-session SD of net edge (bp).

| True edge δ | σ = 30 bp | σ = 40 bp | σ = 60 bp |
|---:|---:|---:|---:|
| +5 bp | 222 | 395 | 890 |
| +10 bp | 56 | 99 | 222 |
| +15 bp | 25 | 44 | 99 |
| +20 bp | 14 | 25 | 56 |

**Rules:**
- Estimate σ_session from a **descriptive pilot** on the historical 12 dev sessions (labeled pilot,
  no decision). Fix n = ceil(6.18·(σ/δ)²) for the smallest edge you would actually act on
  (recommend δ = +10 bp net).
- **Do not read interim results** and do not stop early on a favourable peek. Only read once n valid
  post-2026-10-05 sessions exist. If a pre-agreed maximum collection window (e.g. 6 months) ends
  below n, report **INCONCLUSIVE (underpowered)** and stop.
- **Pre-collection kill check (descriptive, allowed):** on the 12 dev sessions compute the median
  60-minute forward range after these events. If it is **below 3× the round-trip cost (< ~21 bp)**,
  do not collect — the cost wall cannot be cleared at this horizon and the hypothesis is closed.

---

## 4. Required statistics (on the 60-minute cell, valid sessions only)

trades · unique symbols · sessions · win rate · **gross** and **net** expectancy (bp) · net PF ·
positive-session % · 3/5/7/10 bp sensitivity · session-level mean, SD, **t-statistic**, n sessions ·
session-clustered bootstrap CI · NIFTY beta and beta-residual expectancy · results by NIFTY up/down
day · MAE/MFE · holding time · top-10 trade concentration and top-symbol share · **matched-random
control** (same symbol-session-time eligibility, same 60-minute exit, matched direction) ·
reach rates (diagnostic).

---

## 5. Verdict (frozen)

- **FAIL** if net expectancy <= 0 at 7 bp. CLOSE. No LH-1b, no horizon re-tune.
- **INCONCLUSIVE** if net expectancy > 0 at 7 bp but n sessions < the power requirement, or the
  bootstrap CI includes 0 while the point estimate is positive. Stop; report.
- **PASS (screening only)** requires ALL: net expectancy > 0 at **both** 7 and 10 bp; net PF >= 1.15;
  positive-session % >= 55%; beta residual > 0; matched-random differential > 0; top-10 gross share
  <= 40% and top-symbol net share <= 10%; >= 60 symbols; and the **single pre-registered
  session-level test** (one-sided t on session net means, no multiple-testing correction because
  there is exactly one decision cell) at p < 0.05.
  PASS means "candidate for shadow validation", never live trading.

---

## 6. Prohibitions

- No variants (LH-1A/B/C), no alternate horizons, thresholds, windows, exits or entries.
- No re-opening of failed mechanisms; no Grid 2 on the old sessions.
- No locked-segment access.
- Every run logged; the decision uses the 60-minute cell only.

---

## 7. Why longer holds, not NIFTY futures

- **Same instrument, same data, same universe, same cost model.** Longer holds change exactly one
  variable (the horizon), so a positive or negative result is interpretable. NIFTY futures changes
  the instrument, the data feed, expiry/roll handling, sizing and the cost model simultaneously —
  a positive result would confound friction with instrument microstructure.
- **Attacks the diagnosed bottleneck directly.** Every failure so far is a move too small relative to
  ~7 bp. At 60 minutes a 40–80 bp move makes cost a small share, which is the only structural lever
  available on this panel.
- **Futures is the right *second* axis, not the first.** Lower friction is genuinely attractive, but
  it should be tested once the pipeline exists and after the cash-equity longer-horizon question is
  answered, so the two effects are not mixed.

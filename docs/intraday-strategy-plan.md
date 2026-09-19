# Intraday Strategy Plan — v2 (evidence-grounded)

Supersedes all prior verbal plans. Every rule below is derived from a measurement in this
repo, not from trading intuition. Where a claim is not yet measured, it is marked
**UNVERIFIED** and a gate is attached to it.

---

## 1. The invariant that governs everything

```
Gross edge per trade  >  cost per trade          → the strategy can work
Gross edge per trade  ≤  cost per trade          → no filter can save it
```

Cost per trade in R units = `round-trip bps ÷ stop size (%)`.

| Stop size | Cost at 12 bps | Cost at 20 bps | Cost at 30 bps |
|---|---|---|---|
| 0.5% | 0.24R | 0.40R | 0.60R |
| 1.0% | 0.12R | 0.20R | 0.30R |
| 2.0% | 0.06R | 0.10R | 0.15R |
| 3.0% | 0.04R | 0.07R | 0.10R |

**Consequence:** a 1% stop demands +0.12R gross before the first rupee is earned. This
single arithmetic fact explains most of the negative results in this project. Any design
with a stop under 1.5% must be justified explicitly, and every backtest is run **net by
default** — gross numbers are reported only as a diagnostic, never as a result.

## 2. What the measurements actually established

| Finding | Evidence |
|---|---|
| Blanket entry has **zero gross edge** | 960 symbols, 3y daily signals + 15m execution, 76,211 ALL signal-days: best gross +0.051R (PF 1.08), typical +0.02R (PF 1.03–1.05) |
| **Every** config is net-negative | 3 modes × 8 exits × 9 filters = 216 combos, 12 bps: −0.07R to −0.19R, no exceptions |
| Confirming filters **raise win rate and lower expectancy** | Candle/2%: base 35.7% win / +0.018R → big-buyers 42.4% / −0.023R → +ROC 43.0% / −0.036R → +volume-building 44.5% / −0.029R. Stop-outs 53% → 34% |
| Chasing is the worst expectancy | Extended bucket (>0.75% run in first 30 min): **highest** win rate 45.9%, negative expectancy. Not-extended: **lowest** win rate 29–31%, positive expectancy +0.037R to +0.051R |
| Late entries are structurally dead | Entries 14:00–15:00 hit targets 6% of the time (61% EOD exit) |
| "Strong print" filters invert | Six measured: big volume, close-at-highs, wide-range close, RSI bands — all inverted or were noise |
| Two whole concepts already nulled | Breakout-validation: daily PF 0.95 over 11,325 trades; hourly PF 0.82 over 3,301 trades |

**The unifying story:** the information available at entry (buyer absorption, ROC, volume
acceleration) has no *directional* edge in this market at this horizon. It only reshapes
the distribution — many small wins instead of few big wins. Win rate is therefore a
**misleading** objective; expectancy net of cost is the only objective.

## 3. Design rules (non-negotiable)

1. **Net by default.** Every backtest reports net-of-cost R at 12 bps, with a 20 bps and
   30 bps sensitivity line. A result that only survives at 0 bps is a null.
2. **Minimum 1.5R target, minimum 1.5% risk** unless a specific test justifies otherwise.
   Keeps cost per R at or below ~0.08R.
3. **Trigger-based entry only.** No calendar entries ("buy the watchlist at 10:00" is
   disproven). Entry needs a specific, timestamped condition.
4. **Select on expectancy, never on win rate.** A filter is accepted only if it raises
   *net avg R*; higher win rate with lower avg R is a rejection.
5. **Walk-forward, not in-sample.** Any threshold is chosen on a training window and
   confirmed on a held-out window. No threshold is set from the same data it is reported on.
6. **Minimum sample before belief:** ≥300 trades for a headline, ≥100 for a subset, and
   the ex-top-10% average must stay positive (tail-dependence check).
7. **Log rejections.** Every gate records what it rejected, so thresholds can be
   grid-searched later without re-running detection.
8. **Kill criteria are written before the test runs**, not after seeing the result.

## 4. Phases, with pre-registered gates

### Phase 0 — Instrumentation (blocks everything else)
- Cost model in every backtest path, net by default, with a `--cost` switch.
- Append-only daily audit: `date, symbol, ATR%, close, turnover, volBand, mode, signal,
  reject_gate`. Log rejects, not just passers, for both accepted and rejected populations.
- Every reported strategy number carries its `n`, window, and cost assumption.

**Gate:** two consecutive runs of the same test produce identical numbers (determinism).

### Phase 1 — Cost-aware exit redesign (cheapest, highest expected value)
Sweep stop ∈ {1.5%, 2%, 2.5%, 3%, ATR×1.2, ATR×1.5} × target ∈ {1.5R, 2R, 2.5R, 3R} on
the existing signal set, net of cost, with a hard 09:15–15:15 session and the 14:30 entry
cutoff. Include a trailing variant and a breakeven-at-1R variant.

**Gate (pre-registered):** a configuration is promoted only if **net** avg R ≥ **+0.05R**
with n ≥ 300 and positive ex-top-10%. **Kill:** if no configuration clears +0.05R net, the
signals themselves have no edge and Phase 2 is abandoned in favour of Phase 5 (paper-trade
the existing validated daily engine only).

### Phase 2 — Trigger verification at execution resolution
Reproduce the live engine's actual minute-level trigger (ROC + volume surge + VWAP
alignment) rather than a blanket entry, and measure it at 15-min execution first (proxy),
then 1-min if the proxy shows anything.

**Gate:** gross ≥ **0.15R** with n ≥ 300 (i.e. comfortably above the 0.06–0.12R cost band)
**before** any further engineering. **Kill:** a trigger whose gross edge sits inside the
cost band is dead regardless of how good its win rate looks.

### Phase 3 — Selection, ranked by expectancy
Only after Phase 1 or 2 produces a net-positive candidate. Evaluate candidate filters by
*marginal net avg R*, one at a time, on held-out periods:
- the not-chasing guard (skip names already extended at entry) — currently the only
  expectancy-positive signal measured
- relative strength vs Nifty
- higher-timeframe trend agreement
- engine score tier

**Gate:** a filter ships only if it adds ≥ +0.05R net on the held-out window with n ≥ 200.
**Kill:** filters that raise win rate while lowering avg R are permanently rejected and go
into the dead-ends registry.

### Phase 4 — Risk and execution
- Fixed fractional risk per trade (start 0.5% of equity), never size-up after a losing streak.
- Max concurrent positions and a daily loss limit that halts new entries.
- No new entries after 14:30. No entries in the first 5 minutes after 09:15.
- Ban-list / circuit / ATR-band / turnover integrity filters applied before everything else
  (data integrity → staleness → price → turnover → dead-candle → ATR band → ban list).
- Slippage modelled at 20 and 30 bps, not just 12.

### Phase 5 — Paper, then staged capital
4–6 weeks on live feed with zero capital. **Acceptance:** net positive after real costs,
≥100 trades, no single day contributing >30% of total P&L. Then scale 25% → 50% → full,
each step gated on 20 more net-positive sessions.

## 5. Dead ends — do not re-test

Recorded so this work is not repeated:

| Dead end | Why |
|---|---|
| Blanket 10:00 entry on watchlist names | zero gross edge over 76k signal-days |
| The nine confirming filters as *selection* | raise win rate, cut expectancy |
| Buying already-extended opens | highest win rate, negative expectancy |
| Sub-1% stops with <1.5R targets | cost per R ≥ 0.12R — unwinnable before signal quality |
| Testing intraday stops on daily bars | 1% stop sits inside daily noise (~76% first-bar stop-outs) |
| Breakout-validation concept (daily and hourly) | 11,325 trades PF 0.95; 3,301 trades PF 0.82 |
| Judging any strategy by win rate alone | repeatedly inverted in this project |

## 6. What would change the plan

- A minute-level trigger whose **gross** edge exceeds 0.15R with n ≥ 300 → Phases 2–3 proceed.
- Reliable order-flow / depth data at acceptable cost → volume-at-price moves from proxy to
  real, and the buyer-absorption question gets re-opened **as a trigger**, not as a filter.
- Three consecutive months where the daily-engine candidate prints net positive on paper →
  capital allocation moves to Phase 5.

## 7. Honest expectation setting

At 60 trades/month with 0.5% risk and +0.05R net, the account returns roughly
`60 × 0.05 × 0.5% = +1.5%/month` before taxes — modest, and it depends entirely on the
gate in Phase 1 being cleared at all. Most of the value delivered so far is *negative*
knowledge: seven concepts and several hundred configurations measured and eliminated.
That is progress, but it is not yet a tradeable system, and the plan treats it that way.

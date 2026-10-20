# How every number is computed — topic by topic, for auditing

Written 2026-10-09 so each quantity can be checked independently: what goes in, the exact formula, the
unit, where it lives, and what is known to go wrong with it. **This is deliberately not a strategy or
indicator list** — it is the measurement layer under F1, so a mistake can be located to a formula.

Notation: `p` trade price, `q` the tape's quantity field, `v` the tape's cumulative-volume field,
`bid`/`ask` level-1 quotes, `bq`/`sq` total buy/sell book quantity.

---

## T0. Input contract — the tape rows

One JSON object per line in `data/orderflow/ticks-<day>.jsonl`:
`{t, s, p, q, v, bid, ask, bidq, askq, bq, sq}` — `t` epoch **milliseconds**, `s` symbol.

Live coverage measured 2026-10-09 11:31–11:35: `v` 100% of rows, `bid`/`ask`/`bq`/`sq` 95%.
Recorded days run **06:55→16:08**, i.e. hours beyond the session; those rows are dropped, not used.

**Pitfall: every field name is a claim, not a fact.** `q` and `v` were both assumed to be quantity
fields; only `v` turned out to be usable (T6). Check each field against an external source before
trusting it.

---

## T1. Timestamps and bar bucketing

`tapeflow.bar_start(t)`; `f1Live.barStart(t)`.

```
minute_of_day = ((t + 5h30m) / 60000) mod 1440      # IST, integer division
if minute_of_day < 555  (09:15) or >= 930 (15:30):  bar = None
else: bar = 555 + 5 * ((minute_of_day - 555) / 5)   # integer division
```

Unit: minute-of-day = **bar START** (09:15, 09:20, …). A full session is 375 minutes = **75 bars**,
09:15→15:25, with the 15:25 bar covering 15:25–15:30.

**Pitfalls.** (a) An END-stamped source would shift every bar by one interval — Yahoo is start-stamped,
verified by counting 73 bars from 09:15 to 15:15. (b) A capture that starts mid-session yields an
afternoon-only set (10-08 began 12:14:46 → 38 bars). (c) The newest bar is always partially formed.

---

## T2. Session window

09:15 ≤ minute < 15:30. Rows outside are dropped before any accumulation.

**Pitfall:** in the live module the session check must happen **before** the volume mark advances
(T6), or the whole pre-open volume lands in the first bar. That ordering mistake cost 342 signals on
an earlier run; parity caught it.

---

## T3. Orientation — are `bid`/`ask` swapped?

`tapeflow.orient()`.

```
carry last non-zero raw bid and raw ask INDEPENDENTLY (they arrive one side per row)
both known -> if last_bid > last_ask: crossed++
crossed_pct = crossed / both_known
swapped = crossed_pct > 50
```

Measured: 10-06 79.2%, 10-07 75.3%, 10-08 100.0% → `swapped = True` on all three. A genuine book is
never crossed; a majority-crossed reconstruction means the labels are swapped.

**Pitfall:** the correction is re-derived per session, so a feed that fixes its own labels would flip
`swapped` to False and change every consequent number. **`bq`/`sq` are NOT swapped** — the code swaps
only the price labels. BI is positive for BHARATFORG and negative for ANGELONE, so there is no
evidence of a systematic inversion, but it is not proven correct either.

---

## T4. Quote book — carry forward

Bid and ask are children of different rows (one side per record), so each is carried forward
independently, and the bar records the **last** book seen in the bar.

**Pitfall:** the bar's `bq`/`sq` are a snapshot of the final tick, not a bar average. A late quote
dominates. Measured effect on the final bars of 10-08: crossed quotes (bid 683.70 / ask 643.90).

---

## T5. Aggressor classification (SPEC 8.27C)

`tapeflow.build_session`; `f1Live.onTick`.

```
if bid < ask (using the swap-corrected book):
      p >= ask -> buy-initiated          (side = +1)
      p <= bid -> sell-initiated         (side = -1)
      else     -> inside the spread, fall through
if still unknown:
      p > last_p -> +1 ;  p < last_p -> -1 ;  p == last_p -> side = last_side (carry)
if still unknown -> unclassified (counted separately)
```

The exported "unclassified" count on 10-08 was 0 for all three names.

**Pitfalls.** (a) When the book is crossed the first branch is skipped entirely and **every** tick
falls to the tick rule — that is what happens in the last bars of 10-08. (b) On a flat bar
(`p == last_p` for the whole bar) the tick rule can only ever repeat the previous side, so the bar's
delta is the previous side's magnitude replayed: 10-08 ANGELONE 15:15 and 15:25 each give
**FI = −1.0000 with buy = 0** from zero price movement. **Open defect.**

---

## T6. Traded quantity — `q` is NOT it

```
dv per row  = max(0, v - v_hwm)          # v_hwm = per-symbol high-water mark of v
v_hwm       = max(v_hwm, v)
first in-session row sets v_hwm = v (baseline; volume traded before the capture is not ours)
```

`dv` is attributed to the row where it appears, and classified by that row's T5 side.

Why not `q`: rows repeat byte-for-byte (`p`, `q`, `v`, `bid`, `ask`, `bq`, `sq` identical) while `v`
stands still — `q` is a **last-traded quantity** re-emitted with each snapshot. Summing it per row
gives **0.13–0.50×** the exchange's own volume; `dv` gives **1.01–1.13×** (Yahoo, same minutes).

Why a high-water mark: the 10-07 tape has **299,053 backward steps** in `v` (duplicated delivery).
Summing forward steps only, 10-07 reads **3.11×** Yahoo; the mark reads **1.06×**.

Unit: shares. Visible per bar as `total` in `bar_trace`, and audited by `qfield_audit.py`
(prints `sum(q)/yahoo` beside `dv/yahoo`).

**Open defect:** a burst can land in the following bar (10-08 12:35 short 144,828 / 12:40 over
144,820 — the pair sums correctly, so it is a boundary, not a loss).

---

## T7. Bar OHLC

o/h/l/c from the **trade prices** of rows that pass T2 and T6's gate. `o` = first, `c` = last.

**Pitfall:** a row with `q > 0` but `dv = 0` (a repeat with no new volume) still moves `o/h/l/c`, so a
bar can exist with `total = 0` (10-08 ANGELONE 15:20 does exactly that).

---

## T8. Footprint — per-price volume

```
lvl = round(p / 0.05) * 0.05                       # NSE equity tick grid
levels[lvl] = [buy, sell, unc]                     # each += dv for the row's side
```

Unit: shares per 5¢ level. This is the operator's footprint rebuild.

**Pitfall:** the grid is a rounding, so a price that is not on the 5¢ grid (or a different tick size
for another instrument type) is silently snapped.

---

## T9. Bar delta and bar total

```
delta = buy - sell
total = buy + sell + unc
```

Unit: shares (`delta` is signed). Both are `dv`-based (T6). `total` is what the big-bar test reads.

**Pitfall:** in the live module `total` is always recomputed as `buy+sell+unc`, never carried as a
separate accumulator, so the two implementations cannot drift apart on rounding.

---

## T10. Bar POC

`poc = argmax over levels of (buy + sell + unc)` — the heaviest traded price of that bar.

---

## T11. Session POC and value area (SPEC 8.27D)

`flow_scalper.running_profile` / `poc_val`; `f1Live.profile`/`pocVal`.

```
profile = sum of level volumes over bars[0..i]      # CAUSAL: includes bar i, nothing later
POC     = argmax(profile)
VA      = smallest set of CONTIGUOUS levels around the POC covering >= 70% of profile volume
          (grow one level at a time, taking the heavier of the two neighbours on each step)
VAH/VAL = highest/lowest level in VA
```

Unit: rupees (price levels). Causal — no future bar contributes.

**Pitfall:** "smallest contiguous covering ≥70%" has a standard tie-break (heavier neighbour first);
a different tie-break gives different VAH/VAL and therefore different targets.

---

## T12. VWAP

Session VWAP **up to the current bar**, weighted by traded quantity (`dv`), computed from trades only.

---

## T13. FI — flow imbalance (the "big buyer vs big seller" direction)

```
FI = (buy - sell) / (buy + sell)
```

Range [−1, +1], unitless. Threshold grid: |FI| ≥ {0.00, 0.10, 0.20}.

**Pitfall:** the denominator excludes `unc`; a bar with a large unclassified share reports a
confident FI from a small part of its volume. On the recorded days all three names showed `unc = 0`.

---

## T14. BI — book imbalance

```
BI = (bq - sq) / (bq + sq)
```

Symmetric ±1 convention. Read from the **last** quote in the bar (T4).

**Pitfall:** it is a snapshot of one instant, not a bar average, and it is unswapped (T3).

---

## T15. Spread (bps)

```
spread_bps = (ask - bid) / ((ask + bid)/2) * 1e4
```

Median on these tapes: **1.7–8.4 bps** in normal bars, but **−599 bps** in the last two bars of 10-08,
i.e. a crossed book — the arithmetic reports it rather than hiding it, which is how the defect was
found.

---

## T16. The big-bar test

```
base  = median(total of the previous 20 bars)      # bars with total > 0 only
ratio = total / base
big   = ratio >= vol_mult                          # vol_mult in {1.5, 2.0, 3.0}
```

Unit: multiple of the rolling median. `bar_trace` prints `ratio` and a Y/- flag at all three
multipliers so the gate can be checked by eye.

**Pitfall:** the median is over the same series, so it is only meaningful if the series is a faithful
volume measure — which is exactly what T6 destroyed before it was fixed.

---

## T17. Chart patterns

From `o/h/l/c` of the signal bar and the previous bar (engulfing, inside/outside, hammer/shooting-star
family), scored per pattern, each scored separately in the report.

---

## T18. The signal conjunction (the only place anything is decided)

```
big bar (T16)  AND  FI <= -theta (T13)  AND  BI <= -theta (T14)
               AND  close >= POC (T11)  AND  pattern in BEARISH   -> SHORT
big bar        AND  FI >= +theta        AND  BI >= +theta
               AND  close <= POC        AND  pattern in BULLISH   -> LONG
```

`bar_trace`'s `arm` column is an **eyeball approximation** at |FI|,|BI| ≥ 0 without the pattern and
median-gate requirements — it shows direction, not the signal set.

---

## T19. Trade geometry and exits

Entry at the signal bar's close (or a defined level per cell). Stop/target from the POC and the value
area: the running POC if it lies on the profitable side, else the nearest traded node on that side.
`risk_bps` and `tgt_bps` are the distances in bps; `mfe`/`mae` are the excursions in bps, floored at 0.

**Pitfall:** a bar whose geometry leaves no room is skipped and counted under `skip_reasons`
(`no-target`, `stop-too-tight`) — the skip count is part of the result, not a detail.

---

## T20. Cost: frozen vs measured (SPEC 8.27I)

```
FROZEN_COST = 41.5578 bps      # pre-registered, fixed before any result
toll_measured(trade) = the causal trailing-20 estimate at that trade
net_frozen = gross - FROZEN_COST
net_meas   = gross - toll_measured
```

**Pitfall: `net_meas` is not comparable between different runs** (it is a hindsight-flavoured session
toll in one path and a causal trailing one in the other). Comparisons must use `net_frozen`.

---

## T21. Aggregate reporting

Per cell: `n`, `win%`, mean gross, mean net, a confidence interval, and a target-sensitivity curve
(`need_pct = 0.5 + toll/(2*T)` for T in 50…500 bps).

**Pitfall:** a cell with n=2–5 and a CI spanning zero is not evidence; the report prints the CI so the
width is visible rather than implied.

---

## T22. Audit metrics added 2026-10-09

| metric | formula | acceptance |
|---|---|---|
| `dv/yahoo` | our bar total ÷ Yahoo 5m volume, same minutes | **0.85–1.15×** |
| `sum(q)/yahoo` | the old field, kept for contrast | will be 0.1–0.5× |
| `backsteps` | count of rows where `v` < previous `v` | < 1% of rows |
| `outside range` | bars where our high > Yahoo high or low < Yahoo low | should be small |
| `minutes absent` | Yahoo 1m minutes missing inside our bars | 4–8% (Yahoo stops at 15:15) |
| delay | newest Yahoo bar stamp vs IST clock | 0–1 min |

---

## T23. Fibonacci — reference only, not part of F1

`bar_trace.py` prints retracements of the **running swing** (session low→high up to the bar):

```
retrace r:  high - r * (high - low)   for r in {0.236, 0.382, 0.5, 0.618, 0.786}
extension:  high + r * (high - low)   for r in {1.272, 1.618}
```

**This is not in the registered mechanism.** F1's levels are the volume profile (T11). Fibonacci
belongs to the earlier strategy S1 (SPEC 8.26B), which FAILED (net −41.69 / −44.27 bps). Adding a
Fibonacci condition to F1 and re-running is a new strategy and needs its own pre-registration.

---

## T24. Yahoo-specific handling

- Session filter 09:15–15:15 — Yahoo omits the last 15 minutes, so the 15:15–15:30 bars have no
  counterpart and are excluded from every comparison ("bars both" < bars).
- The newest bar is the **forming** bucket (volume 0 at its start), so a "delay" computed from it is
  0–1 minutes, not 15.
- `proxy delta` = Σ volume of up-closing 1-minute bars − Σ volume of down-closing ones. This is NOT
  the footprint delta (no aggressor), and it saturates (an all-up 5-minute window reads 100% of its
  volume as positive).

---

## T25. Where the two implementations can drift

The parity harness (`strategies/orderflow/f1ParityVerify.js`) replays the tape through the live module and
compares against the research CSVs: signals, entry/exit, gross bps, exit reason, excursions. Tolerances
`1e-6` (gross) and `2e-4` (CSV-rounded geometry). It catches **implementation** drift only — a bug in
the shared measurement layer (T6 was exactly that) is invisible to it, which is why the external
grading in T22 exists.

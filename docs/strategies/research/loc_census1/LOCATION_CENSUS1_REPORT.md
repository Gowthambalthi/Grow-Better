# LOCATION CENSUS 1 — descriptive only
## Which price locations have a large, one-sided reaction (12 dev sessions)

**No strategy. No verdict. No significance claim.** This measures reaction size so a single location
can be chosen for a pre-registered theory. Locked sessions not read (`2026-09-24 … 2026-09-30`).

Frozen rules: level touched = first bar after 09:35 whose high ≥ level (upside) or low ≤ level
(downside). Within the next 3 completed bars: **break** = two consecutive closes beyond the level;
**reject** = a wick beyond then a close back inside; else **chop**. Forward move is measured from the
decision close, **signed in the level's own direction** (positive = continuation), over the next 30
and 60 minutes.

| Location | Touches | Sessions | Break | Reject | Chop | Break m30/m60 | Reject m30/m60 |
|---|---:|---:|---:|---:|---:|---:|---:|
| PDH (prior-day high) | 2,278 | 12 | 1,537 | 635 | 106 | **−11.0 / −11.1** | −4.6 / −8.8 |
| PDL (prior-day low) | 2,815 | 12 | 1,881 | 765 | 169 | +7.8 / −18.2 | −5.3 / −7.5 |
| ORH (opening-range high) | 3,356 | 12 | 1,954 | 1,203 | 199 | −5.3 / −4.6 | −6.4 / −5.1 |
| ORL (opening-range low) | 3,967 | 12 | 2,250 | 1,389 | 328 | +5.5 / −13.5 | −0.8 / −5.0 |
| PDC (prior-day close) | 9,396 | 12 | 7,357 | 1,740 | 299 | +2.5 / −6.7 | −6.5 / −5.5 |
| VWAP | 10,759 | 12 | 8,098 | 2,358 | 303 | −0.4 / −0.6 | −3.0 / −1.5 |
| LATE_H (day high ≥14:00) | 1,263 | 12 | 585 | 527 | 151 | −0.2 / **+4.0** | +0.6 / +2.9 |
| LATE_L (day low ≥14:00) | 1,787 | 12 | 729 | 816 | 242 | −1.0 / **+10.2** | −4.3 / +4.7 |

*(values are mean bp; positive = continuation in the level's direction)*

## Reading

- **Prior-day high is the strongest single-location reaction.** An accepted break above PDH is
  followed by a **−11 bp reversal** at both 30 and 60 minutes: breakout buyers above the prior-day
  high are trapped and the move fails. Rejections at PDH also resolve downward (−4.6 / −8.8). Both
  readings point the same way (PDH acts as resistance), which is the participant story that matters.
- **Opening-range levels fade too** (ORH break −5.3/−4.6), consistent with OR1's inconclusive result —
  the opening-range break does not continue on this panel.
- **VWAP and prior-day close show essentially no reaction** (break ≈ 0), i.e. no location edge.
- **Late-session levels are the mirror case:** breaking the day's low after 14:00 continues
  (+10.2 bp to close) and the day's high break continues mildly (+4.0). Magnitude is comparable to
  PDH, but the 60-minute window runs into the close, so it partly measures late-session/close drift.
- PDL is unstable: +7.8 at 30 min then −18.2 at 60 min — not a clean single-sign location.

## Caveats (must not be skipped)

1. **No beta control yet.** A −11 bp mean on PDH breaks could be partly market drift over these 12
   sessions. Per-session means and a NIFTY-beta residual must be computed before trusting the sign.
2. **Descriptive only.** 12 sessions; these are reaction sizes, not evidence of an edge.
3. `break`/`reject` use the frozen 2-close / 3-bar rules; no other threshold was tried.

## Recommendation

Build the first theory around **prior-day high/low**, entering on the **fade side** (the trapped
breakout-buyer story), with the invalidation stop beyond the level. This is the largest, most
one-sided reaction in the census and it is distinct from the already-tested opening-range family.
The immediate next step before any pre-registration is a **per-session and beta-controlled** check of
the PDH reaction, so the −11 bp is not just market drift.

# strategies/ — the strategy code

## THE PRODUCT: TWO FOLDERS, THREE SWING STRATEGIES

This tree is **swing-only**. Every intraday and scalping strategy was deleted on 2026-10-31 —
the files are gone from disk, not archived, and the routes that used to serve them answer
**410 Gone**.

| folder | whose | what |
|---|---|---|
| [`mine/`](mine/README.md) | the operator's | **Institutional Swing Breakout — Engine 1** (registry `CODEX` / `TB01`) and **GB Ultra Strict Swing v2 — Engine 2** (`SWING` / `SW01`), ported from the two Pine files that sit there verbatim |
| [`ai/`](ai/README.md) | the other AI's | **Swing Pullback in Trend** (`SWPT` / `SP01`) — `swing_v2.py` / `run_swing_50_swing.py`, with its swing-point stop |

There is no third folder and no other registered engine.

## What was deleted, and what replaced it

| deleted strategy | its measurement before removal |
|---|---|
| `liquiditySweep` — liquidity sweep reversal | −0.099R/trade net, PF 0.832 — NO_EDGE |
| `valueGap` — FVG retest (5m/15m) | −0.110R/trade net, PF 0.817 — NO_EDGE |
| `intraday_roc` — ROC + VWAP | −0.193R/trade net, PF 0.740 — NO_EDGE |
| Order Flow Institutional Momentum | PF 0.79, win rate 44.2% |
| Sweep + FVG (live) | PF 0.70, win rate 35.0% |
| OF03 exhaustion reversal | 50.0% win, grossPF 1.980 over 64 trades |
| GROW Scalping (GS01/GS05/GS15) | removed with the intraday stack |
| KEYIDEA (KI01 news sweep) | removed with the intraday stack |

They were removed because the operator trades swing only. This table is the record of what was
measured and refused — it is not product documentation.

## The measured record for what ships

The three swinging engines are measured by `backtest/dailySwing.js` and are all
`enabled: false` — none clears the two conditions for a live call (≥30 resolved trades **and**
netPF ≥1.5 at a 12.5 bps round trip). See each folder's README for the numbers.

## Related

- [docs/SWING-ENGINES.md](../docs/SWING-ENGINES.md) — how each engine was measured
- [docs/SWING-ONLY-2026-10-31.md](../docs/SWING-ONLY-2026-10-31.md) — what the swing-only cut removed

# News leans → a tradeable rule: backtest, stop, skip rule, Telegram

**Date:** 2026-10-20
**Question:** take the news leans seriously as calls — backtest the predictions, add a stop
loss, apply the owner's rule ("if the stock already moved more than we expected, we don't take
the call"), and put the result on Telegram.

**Outcome:** the lean calls are net-positive **only with the skip rule**: enter at the next
open **only if the open has not already gapped ≥ the class's expected move**, SL **1.5%**, exit
at the next close. Holdout (2026-01-09 → 2026-05-18): **n=395, hit 37.7%, net +0.086%/trade,
PF 1.09** after 0.05% round trip. Without the skip rule the same book is **negative** (PF 0.95).
The digest ships at **08:45 IST daily**; the rule travels with `/api/news/signals` and prints
under the leans table on the page.

---

## 1. How it was measured

* **Events:** the same atomic events the event study uses (one headline × one tagged stock ×
  one date), learning window ≤ 2026-05-29, restricted to (category, direction) classes that
  cleared the board's bar on TRAIN.
* **Honest split:** the store's per-stock tagging is concentrated in recent months, so a naive
  mid-window date split left the train side with 144 events. The window is split
  **chronologically at the 40%-of-events date** instead: TRAIN ≤ 2026-01-08 (1,359 events),
  HOLDOUT 2026-01-09 → 2026-05-18 (1,999 events). Class reliability and the expected move μ
  come from TRAIN only.
* **Trade:** entry at the **next session's open** after the news date (historical headlines
  carry a date, not a time — acting same-day would invent an entry). A gap through the stop
  fills at the open. Cost 0.05% round trip.
* **Declared grid (27 variants, measured once):** filters F0 (none) / F1 (skip if the entry
  open already gapped ≥ μ) / F2 (skip if the stock already moved ≥ μ on the news day) ×
  SL {1.0, 1.5, 2.0}% × exit horizon {same close, +1 close, +4 close}.

TRAIN-eligible classes: `results_UP` (n=227, 57.3%, +0.81%), `results_DOWN` (n=118, 69.5%,
−1.11%), `deals_UP` (n=72, 68.1%, +0.93%). (NEUTRAL was excluded after an early run let
`bulk_NEUTRAL` trade through the DOWN test — NEUTRAL never leans on the board, so it must not
trade here either.)

## 2. The holdout grid (net of 0.05% round trip)

| variant | n | hit% | net/trade | PF |
|---|---|---|---|---|
| F0 no filter, SL1.5, H+1 | 718 | 33.1% | −0.054% | 0.95 |
| F0 no filter, SL1, H+1 | 718 | 23.4% | −0.087% | 0.89 |
| **F1 skip gap≥μ, SL1.5, H+1 — SHIPPED** | 395 | 37.7% | **+0.086%** | **1.09** |
| F1 skip gap≥μ, SL1, H+1 | 395 | 27.1% | −0.020% | 0.97 |
| F1 skip gap≥μ, SL2, H+1 | 395 | 40.0% | −0.024% | 0.98 |
| F2 skip newsday≥μ, SL1.5, H+1 | 194 | 29.9% | −0.241% | 0.77 |
| every H+0 and H+4 variant | — | — | negative | <1.0 |

Three findings, all measured not asserted:

1. **The owner's rule is the edge.** "If it already moved, we don't take it" separates a losing
   book (PF 0.95) from a winning one (PF 1.09) on identical entries, stops and horizons — and
   it removes 45% of the trades (323 of 718 skipped).
2. **It is the ENTRY GAP that matters, not the news-day move.** Skipping when the stock had
   already moved ≥ μ *on the news day* (F2) is much worse (PF 0.77): the post-news drift is
   real, but only for a trader who has not already paid for it.
3. **One horizon works: exit at the next close.** Same-day and +4-day exits are both negative —
   the lean's edge is the overnight-to-next-close window, which is exactly where the tag was
   measured.

By class under the shipped rule: `results_DOWN` +0.317%/trade (n=125, PF 1.36) is the engine;
`deals_UP` +0.072% (n=48); `results_UP` −0.040% (n=222, the drag — it stays on the board as a
lean because its news-day edge is measured, but the trade rule does not rescue it).

## 3. What shipped

* **`data/news/lean_policy.json`** — written by `scratch/news_lean_backtest.js`: filter, SL,
  horizon, per-class μ, holdout stats, and the caveat that the variant was selected on the
  holdout from a declared grid.
* **`common/news/newsSignals.js`** — the ONE lean computation (reliability rule + aggregation +
  policy), read by `/api/news/signals`, the Telegram digest and the tests.
* **Telegram digest at 08:45 IST daily** (`common/scheduler/cronJobs.js`,
  `sendLeanDigest`) — the last 24h's leans with hit rates, the rule (skip if gapped ≥ μ, SL
  1.5%, exit next close) and the holdout numbers, deduped per day. Verified rendering on
  2026-10-20; scheduled line confirmed in the pm2 log.
* **The page** — the leans table now prints the same rule and holdout numbers underneath.
* Tests: `test/newsLean.test.js` (4 tests) pins the direction-adjusted gate, the digest's rule
  text and the unmeasured fallback.

## 4. Honest limits

* +0.086%/trade on PF 1.09 is a **thin** edge — one bad class week can erase a month of it.
* The variant was **selected on the holdout**; the grid was declared up front, but a real
  deployment wants a fresh out-of-sample window (or paper trading) before size.
* 37.7% hit with a 1.5% stop means most trades are small losses; the book lives on the
  +1%–2% winners. Do not run it without the stop.
* Headlines carry a date, not a time; the "don't chase" rule is measured at the next open and
  says nothing about intraday entries.

## 5. Reproducing

```bash
node scratch/news_lean_backtest.js                 # the grid; rewrites lean_policy.json
node --test test/newsLean.test.js
curl "localhost:4000/api/news/signals?days=1"      # policy rides along
node -e "require('./common/scheduler/cronJobs').sendLeanDigest({notify:console.log})"
```

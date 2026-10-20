# News accuracy — cross-verified against what the stock actually did

**Date:** 2026-10-20
**Question:** the news column's up/down arrows are not accurate — cross-verify them, and give
me "which stock will go up, which will go down" from the news.

**Outcome:** the tagger was cross-verified against realized market-adjusted returns, four real
bugs were found and fixed, and hit rates moved from **55.8%/60.7%** to **60.4%/65.8%** (UP/DOWN).
The page now carries a **STOCK NEWS LEANS** table: a per-stock ▲/▼ lean that is only shown when
its (category, direction) class measured ≥55% hit rate on ≥30 events, with the hit rate printed
beside it.

---

## 1. How "accurate" was measured

Every headline in the store that names a stock was matched to the first session at/after its
date, and the **market-adjusted event-day return** (stock close-to-close minus the equal-weighted
corpus return — the standard abnormal return, the same one `scripts/newsEventStudy.js` computes)
is the ground truth. A direction tag is "right" when the stock beat the market (UP tag) or lagged
it (DOWN tag) that day. Learning window ≤ 2026-05-29 only. Harness: `scratch/news_tag_audit.js`,
runs off the cached daily bars in seconds.

| tag | BEFORE hit% / mean AR | AFTER hit% / mean AR |
|---|---|---|
| UP | 55.8% / +0.60% | **60.4% / +0.95%** |
| DOWN | 60.7% / −0.79% | **65.8% / −1.46%** |
| MIXED | 42.4% / −0.68% (a hidden DOWN lean) | 45.3% / −0.58% |
| NEUTRAL | 51.9% (coin flip, as it must be) | 51.6% |

## 2. The bugs the cross-verification caught

1. **"stirring up trouble" tagged a Middle-East escalation UP** — the bare substring `up ` was
   in the bull list. All direction words are now whole-word regexes, and the vague ones (`up`,
   `down`, `higher`, `lower`, `strong`, `record`, `buy`, `growth`) are gone entirely.
2. **A rate CUT read bearish** — the bare word `cuts` was in the bear list. Rate decisions now
   have their own override: cut → +1 up, hike → +1 down.
3. **"Shares Fall Despite Record Orders" read MIXED** — two keywords tied while the headline
   stated the stock's own move. When the headline says how the *shares* moved, that vote now
   counts twice.
4. **"half-year" and "Halliburton" tagged HAL (Hindustan Aeronautics)** — the alias pass matched
   substrings, so every "half-year results" headline in the store leaned on a defence stock.
   Aliases are now whole words. (Caught live: the signals board was serving HAL from a UK
   advisory's half-year story.)
5. **The corpus directory had been trimmed under the tagger** — `data/ohlcv_1m` is a 20-file
   scratch dir now; a recategorize run against it silently re-tagged 15,373 headlines to 202.
   Tagging and the event study now prefer `data/ohlcv_1m_full` (restored from backup, re-tagged
   correctly; 12,448 headlines name a stock).

Pinned by [test/newsClassify.test.js](../test/newsClassify.test.js) (4 tests).

## 3. Which (category, direction) classes have a measured edge

After the fixes, the learning-window event study (4,400 events, 475 symbols) says these classes
clear the board's bar — hit rate ≥55% on ≥30 events, mean AR sign matching the tag:

| class | n | hit rate | mean AR (news day) |
|---|---|---|---|
| bulk BUY-side (`bulk_UP`) | 32 | **81.3%** | +3.23% |
| results DOWN (`results_DOWN`) | 347 | **66.6%** | −1.10% |
| deals UP (`deals_UP`) | 158 | 60.8% | +0.98% |
| CEO departure DOWN (`ceo_DOWN`) | 81 | 61.7% | −0.80% |
| results UP (`results_UP`) | 630 | 59.4% | +0.97% |

Everything else — `fed`, `war`, `oil`, `ai`, `promoter` — is **coin flip or worse for a single
stock** and never produces a lean. Macro headlines are shown on the page as MARKET BACKDROP
instead. (Notably `fed_UP` is 41.5% — a rate-cut-is-bullish headline was more often followed by a
down day; the tagger keeps the semantic reading and the board keeps it off the tape.)

## 4. What was shipped

* **`/api/news/signals?days=N`** (Server.js) — per-stock lean from the last N days (default 3),
  each carrying its class's measured hit rate and mean move, plus the market-backdrop list.
  Only the five reliable classes above may produce a lean.
* **STOCK NEWS LEANS table** on the news panel of `public/final.html` and `public/board.html` —
  Stock ▲/▼ · why (category + headline link) · hit rate (n) · mean move, and a MARKET BACKDROP
  list underneath. Refreshes with the panel's 60-second loop.
* The event study was re-run on the fixed tags, so `data/news/reaction.json` (and the WHAT
  HAPPENED AFTER panel) matches what the page shows.

## 5. The honest limit

A lean is a **probability, not a prediction**. The best class (bulk_UP) was right 81% of the time
on 32 historical events; the strongest large-sample class (results_DOWN) 67% on 347. The mean
moves are real and market-adjusted, but a 67% tag still loses a third of the time, and the
learning window ends 2026-05-29 — nothing here was tuned on the most recent month.

## 6. Reproducing

```bash
node scratch/news_tag_audit.js                       # the audit (before/after tables)
node scripts/newsHarvest.js --recategorize           # re-derive tags from stored headlines
node --max-old-space-size=6144 scripts/newsEventStudy.js --window=learning
node --test test/newsClassify.test.js
curl "localhost:4000/api/news/signals?days=3"
```

# News — the page, the store, and the measured reaction

A page that shows world and market headlines, and beside each category of
headline, **what the stock actually did next** — measured, with a control, not
asserted.

Open it at `/news` (or `/news.html`).

---

## 1. Where the news comes from

**Google News RSS**, queried per category per month. No API key, no subscription.

The date range is the point: the endpoint honours `after:YYYY-MM-DD
before:YYYY-MM-DD` inside the query, verified against the live endpoint back to
at least **January 2023**. That is what makes a multi-year study possible at all
— every other free feed on this machine returns only the last few days.

Ten categories, in the user's own words:

| id | what it catches |
|---|---|
| `promoter` | promoter holding / stake increased or pledged |
| `results` | quarterly results, profit, revenue, guidance |
| `deals` | acquisitions, mergers, joint ventures, takeovers |
| `bulk` | bulk deals, block deals, stake sales, someone divesting size |
| `oil` | crude, Brent, OPEC — refiners and importers |
| `war` | conflict, missiles, sanctions, shipping lanes |
| `fed` | US Fed, RBI, rate decisions, inflation prints |
| `ceo` | a chief executive or MD leaving or arriving |
| `ai` | companies spending more on AI, chips, data centres |
| `other` | anything that matched none of the above |

The collection is India-locale (`hl=en-IN&gl=IN`) on purpose: the price corpus is
NSE, so a world story only matters here through Indian stocks.

## 2. The files

| path | written by | what it is |
|---|---|---|
| `data/news/items.jsonl` | `scripts/newsHarvest.js` | one headline per line, deduped by (date + title) |
| `data/news/state.json` | same | which (category, term, month) chunks are already fetched — this is what makes the run resumable |
| `data/news/_bars/<SYM>.json` | `scripts/newsEventStudy.js` | daily bars squeezed from the 1-minute corpus, cached |
| `data/news/reaction.json` | same | the measured distribution |
| `common/news/newsStore.js` | — | the ONE classifier, shared by page, API and study |

## 3. Classification, and what it is not

`common/news/newsStore.js` does three keyword reads over the headline text:

* **category** — whole-word matching against each category's `match` list.
* **direction** — `UP` / `DOWN` / `NEUTRAL` / `MIXED` from bullish/bearish words.
* **symbols** — the ticker only when it appears in CAPITALS, the company name
  from the instrument master, plus a small alias table. **Only tickers present
  in `data/ohlcv_1m` can be tagged**, because only those can be tested.

Two bugs were found and fixed while building this, and both are worth knowing:

1. The first pass stamped the **search query's** category onto the item. Queries
   for "promoter holding" then claimed 1,681 of 1,710 stored items, because
   Google returns loosely related market stories for a phrase. The headline is
   now classified on its own text; the query only decides when the text is
   silent. `node scripts/newsHarvest.js --recategorize` re-derives category,
   direction and tags for everything already on disk.
2. A long `OR`-joined query was measured against the endpoint and returned **3**
   items where the same terms asked separately returned 9–14. The harvester
   therefore issues **one request per term per month** (~2,760 requests, about an
   hour) instead of one per category.

None of this is a decision. Direction is not a signal, a category is not a
filter, and nothing on this page can bypass a gate.

## 4. The event study — `scripts/newsEventStudy.js`

The question: *a headline named a stock on day D — what did that stock do next?*

1. Every file in `data/ohlcv_1m` is squeezed into daily bars once (4.2 GB of
   minutes read a single time) and cached.
2. **The market is this corpus itself**: the equal-weighted mean return of every
   symbol trading that day. News-day performance is measured *against* it, so
   "rose 3% on a day the market rose 2.8%" is not scored as a win. That is the
   standard market-adjusted abnormal return.
3. For each atomic event (one headline, one tagged stock, one date) the script
   takes the first session at or after the news date and measures cumulative
   market-adjusted return from the **previous close** out to **+20 sessions**
   (0, 1, 2, 5, 10, 20), plus the event day's open→close move and the day's
   volume versus its own 20-session average.
4. **The control**: the same measurement over *every* symbol-day in the corpus,
   no news required. It comes out at **−0.00%** over ~247,000 symbol-days, which
   is the check that the market adjustment is working. If a category's news-day
   mean is no better than that control, the news did not move the stock — the
   table says so instead of implying otherwise.

```bash
node scripts/newsEventStudy.js                 # learning window (<= 2026-05-29)
node scripts/newsEventStudy.js --window=all    # every stored event
node scripts/newsEventStudy.js --rebuild       # rebuild the daily-bar cache
```

**Frozen discipline.** The default window is the **learning window**; VALIDATION
and FINAL sessions are never read by this script. It computes a distribution and
prints it — nothing is tuned after a result.

## 5. Honest limits

* **Date, not time.** Historical items carry a date; Google normalizes old items
  to 08:00 GMT. So every reaction here is a DAILY measurement. An "intraday
  minute after the news" would be invented, not measured. (Items from the last
  couple of days do carry real times, but the study does not use them.)
* **The news may be older than the move column.** If a symbol's 1-minute history
  starts after the headline (many start mid-2024), the event is dropped, not
  approximated. The study reports how many were dropped for this reason.
* **Direction is a keyword read.** "Profit falls" and "falls on profit" both
  read DOWN; the split by direction is shown so the reader can judge it.
* **Tagging is heuristic.** A headline saying "yes bank" tags nothing unless the
  ticker is in the price corpus; a headline naming a parent may tag the listed
  entity only.
* **A headline is not a trade.** Nothing on the page sends anything, and the
  Telegram path is unaffected by this feature (GB_SCALP_TELEGRAM stays OFF).

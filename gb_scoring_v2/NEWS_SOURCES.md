# News sources — what is connected, what it costs, and what "0" means

The engine (`gb_scoring_v2/news/index.js`) reads **two layers** and classifies both with the same
deterministic keyword classifier. Nothing here can produce a trade: news is context, and the gates
still decide.

| Layer | Sources | Key needed | Notes |
| --- | --- | --- | --- |
| RSS | 20 feeds: moneycontrol ×5, Economic Times ×4, Business Standard ×3, LiveMint, CNBC-TV18, Reuters India, **NSE announcements**, **BSE announcements**, Trendlyne | no | always on, no budget, fetched in-process |
| API | **Marketaux** (primary for India), **Finnhub**, **FinNews**, **Tradient**, Alpha Vantage, NewsAPI, GNews | yes | each has its own free-tier budget, tracked in a ledger |

## Free-tier budgets are enforced, not discovered

Every keyed provider carries `minIntervalMin` + `dailyBudget`, and the ledger
(`data/news_provider_ledger.json`, reset at IST midnight) decides who is called. A cadence that would
need more calls than the budget allows is a bug the test suite refuses: see
`.freebuff/test-news.js` → "every provider must fit its cadence inside the budget it claims".

| Provider | Cadence | Budget/day | Why that number |
| --- | --- | --- | --- |
| Marketaux | 20 min | 90 | free plan ≈100 req/day; India (`countries=in`), entity-tagged (`must_have_entities=true`), ships its own sentiment |
| Finnhub | 5 min | 288 | free general firehose, `related` tickers are authoritative for resolution |
| FinNews | 15 min | 96 | free tier = 100 req/day **and 3 articles/request**, so the request is aimed at `FINNEWS_SYMBOLS` (default: RELIANCE.NS, TCS.NS, HDFCBANK.NS) |
| Tradient | 10 min | 144 | free Indian-market plan; **endpoint is not public** — see below |
| Alpha Vantage | 12 h | 20 | 25 req/day free; kept as a slow supplement |
| NewsAPI / GNews | 30 min | 48 | headline firehose, no ticker tags → resolved locally |

Vendor headers (`X-RateLimit-Remaining` / `X-RateLimit-Reset`) are respected: when the vendor says the
budget is zero, the provider is skipped until the vendor's own reset instead of being hammered into a
429 for the rest of the day.

## Turning a source on

Either `.env` (`FINNHUB_API_KEY`, `MARKETAUX_API_KEY`, `FINNEWS_API_KEY`, `ALPHAVANTAGE_API_KEY`,
`NEWSAPI_KEY`, `GNEWS_API_KEY`, optional `TRADIENT_API_KEY` + `TRADIENT_NEWS_URL`, optional
`FINNEWS_SYMBOLS`, `MARKETAUX_LIMIT`) — **or** paste it on **News → Sources & API keys**, which writes
`data/news_keys.json` (gitignored) and takes effect on the next fetch with no restart. `process.env`
wins over the store, so .env can never be shadowed by a stale paste. Keys are never echoed back:
status reports only the source (`env`/`file`) and the last four characters.

Tradient is `unverified: true` on purpose. Its docs are not published, so a hard-coded URL would
produce a 404 that looks exactly like "the feed is down". It stays off with the reason printed
(`no endpoint (TRADIENT_NEWS_URL)`) until the endpoint is pasted — with `{key}` where the token goes.

## "0" is not "no news": live window vs pool

- **Live window** (`?live=1`): last 90 minutes, directional, company-resolved. This is the intraday
  watchlist and it is *supposed* to be empty after the close.
- **Pool** (always in the payload): everything classified and still inside the 72 h keep-window, with
  the newest item's age and a direction breakdown.

The top strip used to `display:none` itself whenever the live window was empty — so after the close it
vanished, showed 0, then reappeared with 1 when the next headline landed. It now always stays visible:
live rows at full strength, and when the window is empty it shows the **pool**, dimmed, headed
`LIVE 0 (last 90 min) · N in pool · newest Xm ago · showing the POOL, not the live window`. The pool
rows are never fed to the per-symbol news map used beside the board rows — that stays live-only.

## Freshness

Indian news is fast, so the cycle is **3 minutes inside market hours (09:00–15:45 IST) and 10 minutes
outside** it, and any request that finds the stored index older than 2 minutes starts **one shared
background refresh** (`refreshIfStale`) — so the next poll carries the headline instead of the next
cycle. Concurrent polls share the in-flight fetch, so a 1-second strip cadence cannot multiply calls.

## Checks

`node .freebuff/test-news.js` (126 checks, offline) and `node .freebuff/verify-news-endpoint.js`
(16 checks, boots the real `Server.js` on a spare port **without** `initBrokers()`, so no broker
session is touched).

# strategy-core/ — shared machinery (not strategies)

## MAIN CODE

| file | what it is |
|---|---|
| `engines.js` | **THE ENGINE REGISTRY.** One list naming each engine, its module, its hold length and the candles its logic reads — because the same four facts used to be hand-written in four files, and four copies is four chances for the harness to measure a hold of 120 bars while the board follows the same signal for 90. |
| `tradePlanner.js` | owns every price level (stop, targets). **Hash-pinned by Gate F** — the path is frozen. |
| `session.js` | the session state all three engines share: today's bars, the day's extremes, the previous day, the rolling tail, the opening range, the carried VWAP/POC |
| `indicators.js`, `levels.js`, `market.js` | indicator, level and market helpers |
| `replay.js` | the replay driver |
| `audit.js` | the plan audit |
| `strategyLedger.js` | the measured ledger the board reads (net PF / net R and whether a setup cleared the speak bar) |

<!-- dir-doc dir=strategy-core files=9 strategies=0 support=1 -->

## How many strategies, and how much each gives

**In this directory: 0 strategies.** It is the shared machinery the strategies stand on. The one number that matters here is not a performance number: it is that `engines.js` is the single answer to "what engines exist and how are they configured", and every consumer (harness, board builder, `/api/terminal/strategies`, plan audit) imports it rather than re-listing.

| item | what it gives |
|---|---|
| engine registry | one list, so the harness and the live board cannot disagree about an engine's hold length or frames |
| `tradePlanner.js` | the price geometry behind every signal; hash-pinned, so its behaviour cannot drift unnoticed |

## Related

- the strategies themselves: [strategies/README.md](../strategies/README.md)
- python port of this registry: `python_app/strategy_core/engines.py` — kept identical on purpose

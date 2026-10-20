# strategies/roc/ — the ROC10 / ROC20 experimental family

## MAIN CODE

| file | what it is |
|---|---|
| `rocEngine.js` | **ROC10 / ROC20 candidate engine** (up-acceleration / down-acceleration with confirm, state-change and cooldown guards). Deliberately isolated: it touches no frozen file and writes to its own board and journal only. |
| `rocEngineV2.js`, `rocEngineV3.js` | later versions of the same engine |
| `scalpService.js` | **DISABLED BY USER DIRECTIVE** — a no-op stub (`armScalping` returns empty handlers). Five tests in `test/scalpingService.test.js` assert the board the stub no longer produces, and they fail on purpose. |
| `scalpV2Service.js` | second scalper service |
| `signalJournal.js` | the family's own journal (`data/scalping`) |
| `outcomeTracker.js` | resolves its signals to outcomes |
| `rocBacktest.js`, `rocDiagnostic.js`, `rocV3Study.js` | backtest and study tools |

<!-- dir-doc dir=strategies/roc files=0 strategies=2 experimental=1 -->

## How many strategies, and how much each gives

**In this directory: 1 research family (ROC10/ROC20) with 3 engine versions, plus its journal.**

| strategy | how much it gives | evidence |
|---|---|---|
| Intraday ROC+VWAP (`intraday_roc` row) | -0.193R per trade net, PF 0.740, 33.7% win — NO_EDGE | `data/strategy_rank_100.json`; on the 995-symbol tape it was -0.248R and retired |
| ROC10/ROC20 scalper | no live record worth quoting: the service is a stub and the board is disabled | `test/scalpingService.test.js` (failing on purpose) |

The measured row is the 1-minute port of `scripts/backtestIntradayRoc.js` — and its audit found a real bug worth remembering: the source divided the 5-bar volume mean by a session average that INCLUDED the signal bar, so a genuine burst deflated its own ratio. The denominator is now the prior completed bars only.

- measurement write-up: [docs/strategies/intraday_roc.md](../../docs/strategies/intraday_roc.md)

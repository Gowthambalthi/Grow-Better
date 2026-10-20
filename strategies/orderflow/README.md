# strategies/orderflow/ — the live order-flow engine and its instruments

## MAIN CODE

| file | what it is |
|---|---|
| `liveMinuteEngine.js` | **THE LIVE ENGINE.** Live ticks → in-memory 1-minute OHLCV/volume/delta/VWAP for ~700–1,000 symbols → institutional scan each minute → up to 6 calls a day. It writes `data/orderflow/daily_calls_<date>.json`. |
| `liveDetector.js` | runs the *frozen* OF01/OF03 detector live and journals the candidates it arms — the live half of the frozen-vs-replay comparison. |
| `live_engine.py` | Python mirror of the live institutional engine (FVG displacement, delta footprint / CVD turnaround, VWAP). |

<!-- dir-doc dir=strategies/orderflow files=15 strategies=1 live=1 -->

## How many strategies, and how much each gives

**In this directory: 1 live strategy (Order Flow Institutional Momentum) plus its capture and audit instruments.** The rule set it runs is engine 3 (`strategies/orderFlow.js`).

| strategy | how much it gives | evidence |
|---|---|---|
| Order Flow Institutional Momentum | PF 0.79, 44.2% win | `scratch/pf_board.js`, pooled over 14 call books |

## The instruments — support, not strategies

| file | what it does |
|---|---|
| `tickCapture.js` | records the raw tick tape (the input every replay tool reads) |
| `armCapture.js` | captures what the detector ARMED, with the row it returned |
| `callOutcomes.js` | resolves calls to outcomes after the fact |
| `liveEventJournal.js` | the live event journal |
| `depth5_recorder.js` | depth-5 recorder |
| `f1Live.js` | F1 live journal |
| `f1Trace.js` | F1 trace |
| `f1ReplayCheck.js` | replay checker (never writes the live namespace — asserted by `test/f1LiveGuard.test.js`) |
| `f1ParityVerify.js` | frozen-vs-live parity verifier |
| `f1CrossVerify.js` | cross verifier |
| `f1LiveScoreboard.js` | scores a session |

None of these files may claim the live `f1-live-` namespace: only the server may write it, and the guard test iterates THIS directory to enforce that.

- live engine write-up: [docs/strategies/live-of-momentum.md](../../docs/strategies/live-of-momentum.md)

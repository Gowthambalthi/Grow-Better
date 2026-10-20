# Backtest — every backtest document, in one place

Written by `freebuff/consolidate-strategy-info.js`. This is the backtest half of the strategy record: every report under `backtest/`, one section each. The backtest SCRIPTS are named with the report they produce wherever a script writes it.

**15 documents.** 3 are physically in this folder; the rest are in place and indexed here, each with the reason it did not move.

<!-- files-index kind=backtest files=15 moved=3 -->

## [Per-bar ingredients - 2026-10-08](f1/bar_trace_2026-10-08.md)

- file: `docs/strategies/backtest/f1/bar_trace_2026-10-08.md`
- moved here from `backtest/f1/bar_trace_2026-10-08.md` (self-contained: no relative links, no generator)
- Source: `backtest/f1/cache/%s.pkl`, the same bars `backtest/f1/flow_scalper.py` scores, and

## [Per-bar ingredients - 2026-10-09](f1/bar_trace_2026-10-09.md)

- file: `docs/strategies/backtest/f1/bar_trace_2026-10-09.md`
- moved here from `backtest/f1/bar_trace_2026-10-09.md` (self-contained: no relative links, no generator)
- Source: `backtest/f1/cache/%s.pkl`, the same bars `backtest/f1/flow_scalper.py` scores, and

## [Bug hunt - Yahoo as the arbiter, plus internal consistency tests](../../../backtest/f1/bug_hunt.md)

- file: `backtest/f1/bug_hunt.md`
- in place — written by `backtest/f1/bug_hunt.py`; moving the output would make the next run write a second copy at the old path
- A. Price integrity against Yahoo (all three sessions, after the volume fix)

## [Calculation sheet — how each number is computed](../../../backtest/f1/calculation_sheet_2026-10-10.md)

- file: `backtest/f1/calculation_sheet_2026-10-10.md`
- in place — named by `.freebuff/check_docs.py` (read there, not written)
- Every entry below is read from the code, not from memory, and each one names the file and line so you can

## [How every number is computed — topic by topic, for auditing](f1/CALCULATIONS.md)

- file: `docs/strategies/backtest/f1/CALCULATIONS.md`
- moved here from `backtest/f1/CALCULATIONS.md` (self-contained: no relative links, no generator)
- Written 2026-10-09 so each quantity can be checked independently: what goes in, the exact formula, the

## [Delta patterns, deeper — stability, selection bias, and a price-only control (2026-10-10)](../../../backtest/f1/delta_pattern_deep_2026-10-10.md)

- file: `backtest/f1/delta_pattern_deep_2026-10-10.md`
- in place — written by `.freebuff/check_deep_report.py`; moving the output would make the next run write a second copy at the old path
- delta_pattern_study_2026-10-10.md found **no** delta

## [Do delta patterns announce a sudden move? — learn-then-test (2026-10-10)](../../../backtest/f1/delta_pattern_study_2026-10-10.md)

- file: `backtest/f1/delta_pattern_study_2026-10-10.md`
- in place — written by `.freebuff/check_deep_report.py`; moving the output would make the next run write a second copy at the old path
- Question (operator's words):** "learn how delta is moving … if delta moved like this, suddenly it

## [Five-way cross-check on 2026-10-09 - our tape vs Groww vs TradingView vs an external chart feed](../../../backtest/f1/five_way_check_2026-10-09.md)

- file: `backtest/f1/five_way_check_2026-10-09.md`
- in place — named by `.freebuff/check_report_tables.py` (read there, not written)
- Symbols: BEL, HDFCBANK, ICICIBANK, CAMS, BSE - the set `crosscheck_sheet.py` and `ohlc_sheet.py`

## [The bar-building gate: what was replaced, what measurement withdrew, what is left](../../../backtest/f1/gate_827x_2026-10-10.md)

- file: `backtest/f1/gate_827x_2026-10-10.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Date 2026-10-10. Touches tapeflow.py (research) and

## [How each thing is identified — logic, live behaviour, and the bugs in it](../../../backtest/f1/HOW_IT_WORKS.md)

- file: `backtest/f1/HOW_IT_WORKS.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Live worked examples come from today's tape (`data/orderflow/ticks-2026-10-09.jsonl`, capture running

## [Large-flow / cluster detector — pre-registered spec (2026-10-10)](../../../backtest/f1/largeprint_detector_2026-10-10.md)

- file: `backtest/f1/largeprint_detector_2026-10-10.md`
- in place — named by `.freebuff/check_docs.py` (read there, not written)
- Status: NOT YET RUN. Every threshold below must be frozen in `research/SPEC.md` before the first

## [F1 live handoff — run the same calculations the day Angel One is reachable again](../../../backtest/f1/LIVE_HANDOFF.md)

- file: `backtest/f1/LIVE_HANDOFF.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Written 2026-10-09, after the volume field was found to be misread. Everything here is reproducible

## [What the `q` field is - and why summing it is a bug](../../../backtest/f1/qfield_audit.md)

- file: `backtest/f1/qfield_audit.md`
- in place — written by `backtest/f1/qfield_audit.py`; moving the output would make the next run write a second copy at the old path
- Per 5-minute bar, three candidate volumes against Yahoo's independent volume for the same

## [Where our tape and Yahoo disagree - and which side is at fault](../../../backtest/f1/yahoo_integrity.md)

- file: `backtest/f1/yahoo_integrity.md`
- in place — written by `backtest/f1/yahoo_integrity.py`; moving the output would make the next run write a second copy at the old path
- A. Is Yahoo internally consistent? (its 5m bar vs the roll-up of its own five 1m bars)

## [Yahoo Finance as a source - measured 2026-10-09 11:31:41 IST](../../../backtest/f1/yahoo_source.md)

- file: `backtest/f1/yahoo_source.md`
- in place — written by `backtest/f1/yahoo_bars.py`; moving the output would make the next run write a second copy at the old path
- / symbol / interval / newest bar (IST) / now (IST) / gap / vol of newest bar / 1m meta price /

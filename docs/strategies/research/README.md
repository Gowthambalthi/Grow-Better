# Deep research — every research document, in one place

Written by `freebuff/consolidate-strategy-info.js`. This is the research half of the strategy record: mechanism studies, pre-registrations, censuses and reports under `research/`, one section each.

**34 documents.** 4 are physically in this folder; the rest are in place and indexed here, each with the reason it did not move.

<!-- files-index kind=research files=34 moved=4 -->

## [DATA / CALCULATION INTEGRITY AUDIT 1](../../../research/audit1/AUDIT1_REPORT.md)

- file: `research/audit1/AUDIT1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Independent audit of the SC Batch 1 data pipeline and backtest calculations

## [DELTA SWEEP — PRE-REGISTRATION (FROZEN BEFORE THE RUN)](../../../research/catalog/DELTA_PREREGISTRATION.md)

- file: `research/catalog/DELTA_PREREGISTRATION.md`
- in place — named by `research/catalog/delta_engine.py` (read there, not written)
- Purpose.** Test the **15 most-used intraday mechanisms that have never been tested** (see

## [DELTA SWEEP — REPORT](../../../research/catalog/DELTA_REPORT.md)

- file: `research/catalog/DELTA_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- VERDICT: DELTA FAIL — no cell survives the family-wide max-T. Shortlist empty.**

## [DELTA SHADOW SPEC — NO SURVIVORS (EMPTY)](../../../research/catalog/DELTA_SHADOW_SPEC.md)

- file: `research/catalog/DELTA_SHADOW_SPEC.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Status: nothing frozen for shadow collection.**

## [EXISTING SWEEP AUDIT (PHASE 0)](../../../research/catalog/EXISTING_SWEEP_AUDIT.md)

- file: `research/catalog/EXISTING_SWEEP_AUDIT.md`
- in place — written by `research/catalog/audit_existing_sweep.py`; moving the output would make the next run write a second copy at the old path
- READ-ONLY audit of the world-strategy catalogue that already exists. No strategy was run, retested or re-ranked by this step.

## [WORLD STRATEGY CATALOGUE (PHASE 1)](../../../research/catalog/WORLD_STRATEGY_CATALOG.md)

- file: `research/catalog/WORLD_STRATEGY_CATALOG.md`
- in place — written by `research/catalog/build_catalog.py`; moving the output would make the next run write a second copy at the old path
- Everything the program has already tested, plus the **delta** — the most-used mechanisms that have never been tested. Phase 2 may only test the delta.

## [EX1 — Volume-Backed Extension → Exhaustion → Confirmed SHORT — RESULT](../../../research/ex1/EX1_REPORT.md)

- file: `research/ex1/EX1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Verdict: `FAIL — CLOSE EX1`.** Frozen grid of 36 trials on the development history; negative

## [EX1 — VOLUME-BACKED EXTENSION → EXHAUSTION → CONFIRMED SHORT (FROZEN SPEC)](../../../research/ex1/SPEC.md)

- file: `research/ex1/SPEC.md`
- in place — written by `.freebuff/f1_report.py`; moving the output would make the next run write a second copy at the old path
- New mechanism. Normal NSE cash equities only. Sealp research, not live.** Does not reuse OR1 logic.

## [FAMILY BATCH 1 — families 1, 2, 3, 11](../../../research/fam_batch1/FAM_BATCH1_REPORT.md)

- file: `research/fam_batch1/FAM_BATCH1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Opening/gap · Levels · VWAP · Time-of-day / India-specific

## [FVG DEEP RESEARCH — IDENTIFICATION, ENTRY, EXIT, NO-TRADE RULES, MEASURED RESULTS](../../../research/fvg/FVG_DEEP_RESEARCH.md)

- file: `research/fvg/FVG_DEEP_RESEARCH.md`
- in place — read by `test/depthOrientation.test.js`, so its path is pinned
- Date: 2026-10-12 · Compiled by Freebuff (5 parallel research passes + direct searches)

## [HVE-1 — High-Volatility Price/Volume Expansion Continuation](../../../research/hve1/HVE1_REPORT.md)

- file: `research/hve1/HVE1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Single mechanism · single bounded backtest · development segment only

## [LL-1 — LARGE-DATA INVENTORY & 1m BACKFILL REPORT](ll1/DATA_INVENTORY.md)

- file: `docs/strategies/research/ll1/DATA_INVENTORY.md`
- moved here from `research/ll1/DATA_INVENTORY.md` (self-contained: no relative links, no generator)
- Task reference: §28 steps 1–5 (inventory all 1m data, backfill a large broad learning

## [LOCATION CENSUS 1 — descriptive only](loc_census1/LOCATION_CENSUS1_REPORT.md)

- file: `docs/strategies/research/loc_census1/LOCATION_CENSUS1_REPORT.md`
- moved here from `research/loc_census1/LOCATION_CENSUS1_REPORT.md` (self-contained: no relative links, no generator)
- Which price locations have a large, one-sided reaction (12 dev sessions)

## [LRD-1 — LIQUIDITY-REGIME DIRECTIONAL RESPONSE](../../../research/lrd1/LRD1_REPORT.md)

- file: `research/lrd1/LRD1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- One pre-registered mechanism · development segment only

## [New Research Cycle — Mechanism Discovery (pre-implementation)](../../../research/mechanism-discovery/MECHANISM_DISCOVERY.md)

- file: `research/mechanism-discovery/MECHANISM_DISCOVERY.md`
- in place — named by `research/mechanism-discovery/run_i1.py` (read there, not written)
- Scope:** NORMAL NSE STOCKS ONLY. No futures, no options, no index products, no production

## [New Research Cycle — One-Shot Historical Test Report](../../../research/mechanism-discovery/TEST_REPORT.md)

- file: `research/mechanism-discovery/TEST_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Scope:** NORMAL NSE STOCKS ONLY. No futures, no options, no production changes, no live trading.

## [LH-1 — LONGER-HORIZON DIRECTIONAL RESPONSE](next/LH1_PREREGISTRATION.md)

- file: `docs/strategies/research/next/LH1_PREREGISTRATION.md`
- moved here from `research/next/LH1_PREREGISTRATION.md` (self-contained: no relative links, no generator)
- Paste-ready pre-registration (one mechanism, one cell, post-today data only)

## [OF05 — Locked Holdout Manifest](../../../research/of05/holdout/MANIFEST.md)

- file: `research/of05/holdout/MANIFEST.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Locked before any modeling.** The holdout is the chronological **last 20% of intraday sessions**:

## [OF05 — Pre-flight](../../../research/of05/PREFLIGHT.md)

- file: `research/of05/PREFLIGHT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Frozen before any data is loaded. Answers section 1 items 1–3 of the spec.

## [OF05 — Final Report](../../../research/of05/REPORT.md)

- file: `research/of05/REPORT.md`
- in place — written by `research/sc_grid1/build_report.py`; moving the output would make the next run write a second copy at the old path
- Frozen spec: SPEC.md (`44397a50…f10e7`). All parameters, costs, horizons and gates were

## [OF05 — Autonomous ML/DL Edge Search (FINAL SPEC — FROZEN)](../../../research/of05/SPEC.md)

- file: `research/of05/SPEC.md`
- in place — written by `.freebuff/f1_report.py`; moving the output would make the next run write a second copy at the old path
- Status: FROZEN.** Machine-readable frozen parameters: spec.json.

## [OF05b — Autonomous ML/DL Edge Search (dense-panel split) — FINAL REPORT](../../../research/of05b/REPORT.md)

- file: `research/of05b/REPORT.md`
- in place — written by `research/sc_grid1/build_report.py`; moving the output would make the next run write a second copy at the old path
- Verdict: `NO_EDGE_FOUND`. The holdout was never opened. No finalist was selected.**

## [OF05b — Autonomous ML/DL Edge Search (DENSE-PANEL SPLIT) — FROZEN](../../../research/of05b/SPEC.md)

- file: `research/of05b/SPEC.md`
- in place — written by `.freebuff/f1_report.py`; moving the output would make the next run write a second copy at the old path
- Supersedes `of05-1.0`. Version `of05b-1.0`.**

## [ORDER-FLOW DATA AUDIT](../../../research/ORDER_FLOW_DATA_AUDIT.md)

- file: `research/ORDER_FLOW_DATA_AUDIT.md`
- in place — named by `research/framework/inventory.py` (read there, not written)
- Date:** 2026-10-05 · **Status:** DATA AUDIT ONLY — no strategy, no signal, no backtest.

## [OR1 — FULL RESULT TABLE AND THE LOGIC USED](../../../research/pipeline/OR1_FULL_TABLE.md)

- file: `research/pipeline/OR1_FULL_TABLE.md`
- in place — named by `research/pipeline/build_full_table.py` (read there, not written)
- Generated 2026-10-05T16:26:39 · OR1 frozen sha256 `d3941c1798407a35…` · cost **7 bp** round trip

## [SC Batch 1 — 20 Fixed Scalping Mechanisms (SC01–SC20)](sc_batch1/SC_BATCH1_REPORT.md)

- file: `docs/strategies/research/sc_batch1/SC_BATCH1_REPORT.md`
- moved here from `research/sc_batch1/SC_BATCH1_REPORT.md` (self-contained: no relative links, no generator)
- Status: CLOSED on the development segment — ALL 20 PLANS FAIL. Stage-2 shortlist: EMPTY.**

## [SC BATCH 1 — 20 FIXED SCALPING MECHANISMS (FROZEN)](../../../research/sc_batch1/SC_BATCH1_SPEC.md)

- file: `research/sc_batch1/SC_BATCH1_SPEC.md`
- in place — named by `research/sc_batch1/sc_engine.py` (read there, not written)
- Normal NSE cash equities only. No futures/options/ETFs/SME/T2T. No production, OR1, earlier engines

## [SCALPING OPPORTUNITY CENSUS 1](../../../research/sc_census1/SC_CENSUS1_REPORT.md)

- file: `research/sc_census1/SC_CENSUS1_REPORT.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Descriptive movement / cost-wall study — NORMAL NSE CASH EQUITIES ONLY

## [SC GRID 1 — 100 PRE-REGISTERED CELLS](../../../research/sc_grid1/SC_GRID1_REPORT.md)

- file: `research/sc_grid1/SC_GRID1_REPORT.md`
- in place — written by `research/sc_grid1/build_report.py`; moving the output would make the next run write a second copy at the old path
- Directional opportunity discovery · development segment only

## [FAM5 — SHADOW VALIDATION SPEC (FROZEN)](../../../research/shadow/FAM5_SHADOW_SPEC.md)

- file: `research/shadow/FAM5_SHADOW_SPEC.md`
- in place — its own text links to the artifacts beside it, so it stays with its data
- Cells:** `GAP_fade` · `PDL_fail` · `LATE_break` · `VWAP_snapback` · `LUNCH_break`

## [OF-1 HISTORICAL CALIBRATION — DEVELOPMENT / CALIBRATION ONLY](../../../research/shadow/OF1_CALIBRATION.md)

- file: `research/shadow/OF1_CALIBRATION.md`
- in place — named by `research/shadow/of1_calibration.py` (read there, not written)
- This is NOT evidence.** These four tapes are calibration data under the standing discipline. Nothing here counts toward the 40-session shadow checkpoint, and OF-1 must NOT be tuned from thes

## [OF1_SHADOW_SPEC — Shock-Flow Continuation (pre-registration)](../../../research/shadow/OF1_SHADOW_SPEC.md)

- file: `research/shadow/OF1_SHADOW_SPEC.md`
- in place — named by `research/pipeline/notify.js` (read there, not written)
- Written:** 2026-10-05 · **Status:** PRE-REGISTERED BEFORE ANY RUN — no instance of this

## [OR1 — SHADOW VALIDATION SPEC (FROZEN)](../../../research/shadow/OR1_SHADOW_SPEC.md)

- file: `research/shadow/OR1_SHADOW_SPEC.md`
- in place — named by `research/pipeline/export_frontend.py` (read there, not written)
- Mechanism:** OR1 — **O**pening-**R**ange imbalance → continuation (renamed from the earlier

## [Quantitative Trading System Specification & Research Protocol (SPEC.md)](../../../research/SPEC.md)

- file: `research/SPEC.md`
- in place — written by `.freebuff/f1_report.py`; moving the output would make the next run write a second copy at the old path
- Core Mandate**: This document defines the frozen rules, hypotheses, cost models, data boundaries, and validation acceptance criteria for finding a true edge on NSE equities. No rules or para

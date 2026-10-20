# EVERY FILE — where the strategy record lives, all of it

Written by `freebuff/consolidate-strategy-info.js`. One page that says where every kind of strategy file is, so nothing has to be hunted for.

## In this folder

| what | where |
|---|---|
| one page per measured strategy (35) | [`docs/strategies/<id>.md`](README.md) — index in the README |
| the live engines | [live-of-momentum.md](live-of-momentum.md) · [live-sweep-fvg.md](live-sweep-fvg.md) · [live-tier-nine.md](live-tier-nine.md) |
| deep research, every document | [research/README.md](research/README.md) (34 documents) |
| backtest, every document | [backtest/README.md](backtest/README.md) (15 documents) |
| strategy pages from docs/ | [pages/README.md](pages/README.md) (20 documents) |

## The code, where it runs (and is pinned)

| what | where | README |
|---|---|---|
| the three research engines | `strategies/liquiditySweep.js`, `strategies/fvg/index.js`, `strategies/orderFlow.js` | [strategies/README.md](../../strategies/README.md) |
| the live order-flow engine + instruments | `strategies/orderflow/` | [strategies/orderflow/README.md](../../strategies/orderflow/README.md) |
| sweep + FVG live + python mirror | `strategies/fvg/` | [strategies/fvg/README.md](../../strategies/fvg/README.md) |
| the ROC experimental family | `strategies/roc/` | [strategies/roc/README.md](../../strategies/roc/README.md) |
| frozen snapshot (byte-compared) | `strategies/frozen/` | [strategies/frozen/README.md](../../strategies/frozen/README.md) |
| shared machinery + engine registry | `strategy-core/` | [strategy-core/README.md](../../strategy-core/README.md) |
| python mirrors | `python_app/strategy_core/` | [python_app/strategy_core/README.md](../../python_app/strategy_core/README.md) |

## The measurement artifacts (read by the docs, never edited)

| artifact | what it holds |
|---|---|
| `data/strategy_rank_100.json` | every measured row: this is the source of every number in this folder |
| `data/strategy_rank_spread.json` | the same rows under the spread-stressed fill assumption |
| `data/github_strategies.json` | the three default rows on the harness tape |
| `data/trend_day_stress.json`, `data/trend_day_stress_45.json` | the trend_day variant stress runs, 995 and 45 symbols |
| `data/live_strategy_board.json` | the live tier board (the nine strategies and their status) |
| `data/orderflow/daily_calls_<date>.json` | the live call books — the only live record there is |
| `data/live_strategy_bench.json` | the CHASE / FADE / YOUNG bench log |

## The measurement scripts

| script | what it answers |
|---|---|
| `freebuff/strategy-docs.js` | rebuilds this folder from the artifacts |
| `freebuff/consolidate-strategy-info.js` | rebuilds the research/backtest/pages indexes |
| `scratch/verify_strategy_docs.js` | re-checks every number and path in this folder against the artifacts |
| `scratch/pf_board.js` | the two live engines, from their own call books |
| `freebuff/strategy-rank-report.js` | the full ranking report, with the interval columns the index drops |
| `freebuff/strategy-accounting.js` | one accounting over the registry artifacts (needs the harness tree from git) |
| `scratch/verify_strategies_table.js` | re-checks the win-rate/PF table in docs/STRATEGIES.md |

## Reports that live outside this folder, and are listed here on purpose

- `reports/strategy_verdicts.md` — the verdict table over the strategy set
- `reports/backtest_three_tier_portfolio_raw.txt` — the raw three-tier portfolio backtest output
- `.freebuff/STRATEGY-TUNING-REPORT.md` — the strategy tuning report
- `reports/live_calls_2026-10-07.{md,csv,html,json}` — one day of the live call book, exported

# Backtest report — 25 Sep 2026 (Part 1 of the approved plan)

**Verdict under the pre-registered kill criterion: FAIL — the gate is NOT rehosted, and the old
engine is not deleted on this evidence.** The rules that produced that verdict were hashed in
`gb_scoring_v2/config/index.js` (`preRegistration`, locked 2026-09-25) before the first number was
computed, and the report prints them before it prints a result.

## What was tested

| | |
|---|---|
| Data | `data/ohlcv_1m/` — 995 filtered symbols **+ NIFTY** (market adjustment), 7,589 one-minute bars each, **21 sessions** (2026-08-27 → 2026-09-25). The plan asked for 8–10; the vendor's per-request cap gave 21. |
| New engine | the Raschke framework: 15m context → 5m structure (ADX/20 EMA) → 1m execution; three setups — Impulse→Pullback→Re-entry, the Anti, the congestion breakout; structural risk before entry. `gb_scoring_v2/raschke/`. |
| Old engine | `common/market/liveCallEngine.js` in its **working-tree** form — `computeRoc` + `rocSignal`, its real decision function, frozen by `.freebuff/freeze-old-engine.js` (sha256 `b7cf7f463a50a1a0…`, edits proven reversible to the byte). |
| Fills | entry at the **next** bar's open; **stop first** whenever one bar touches both stop and target; the plan's risk distance preserved across the fill; no trade survives its session. |
| Costs | 0.10% round trip (STT + exchange + brokerage + slippage), charged on every trade and reported **in R**. |
| Risk | identical structural-swing stop and 2R target for both engines, so the comparison measures **entry selection**, not risk placement. |

## 1. The setups, alone (74,665 signals, full universe, cost 0.10%)

| setup | trades | win | **gross** | cost | **net** | stop-before-target | R CI (sessions) | positive sessions |
|---|---|---|---|---|---|---|---|---|
| ANTI | 45,660 | 35.1% | **−0.004R** | 0.260R | −0.264R | 58.0% | [−0.300, −0.213] | 1/21 |
| PULLBACK-REENTRY | 26,986 | 34.7% | **−0.028R** | 0.252R | −0.280R | 54.9% | [−0.325, −0.224] | 1/21 |
| CONGESTION-BREAKOUT | 2,019 | 33.6% | **−0.019R** | 0.329R | −0.348R | 63.2% | [−0.400, −0.293] | 0/21 |

**The gross column is the result.** Before any cost, none of the three setups has an edge worth the
name: −0.004R, −0.028R, −0.019R, with a 2R target and a ~35% hit rate that breaks even on paper.
Costs then do the rest, because at a ~0.35% structural stop a 0.10% round trip **is 0.25–0.33 units
of risk**. Signed, market-adjusted forward returns agree from a different direction: +5m −0.026%,
−0.022%, −0.070%; +15m and +30m the same sign and size. So this is not an artefact of the stop
geometry, the exit rule, or the cost level — the direction simply has no predictive content at these
horizons on this data.

**Expansion tags (range ≥1.2×, volume ≥0.9× of the 20-bar average)** separate the trades in the
expected direction but not by enough to matter: ANTI −0.234R with tags vs −0.283R without;
PULLBACK −0.251R vs −0.309R. A weak, consistent tilt — not a fix, and not certified.

**A small-sample finding that did NOT survive.** On a 25-symbol pilot, trades with a stop wider than
1% were positive gross *and* net in every bucket, which looked like a rule. On the full universe the
bucket's gross is −0.013R (PULLBACK) and 0.000R (ANTI): the pilot was noise. The bucket table stays
in the report as a **retraction**, because that is what honesty about a search costs.

## 2. Head-to-head against the old engine (identical bars, identical risk rule)

6.66 million bars compared, 0 old-engine errors, both books filled by the same simulator.

| | trades | mean R | win | stop-before-target | signed +5m (mkt-adj) | R CI | positive sessions |
|---|---|---|---|---|---|---|---|
| NEW (Raschke framework) | 249,939 | **−0.325** | 34.1% | **59.4%** | −0.0277% | [−0.360, −0.279] | 1/21 |
| OLD (liveCallEngine) | 142,137 | **−0.279** | 33.9% | **49.7%** | −0.0264% | [−0.314, −0.229] | 1/21 |

Same-side overlap episodes (16,495) — the "identical episodes" the rule names: new −0.0325% vs old
−0.0325% at four decimals; mean R −0.287 vs −0.265.

**The new framework is not better on this data. It is slightly worse on both money and stop rate.**
The old engine takes 43% fewer entries on the same bars, which is why it stops out less often.

## 3. The pre-registered kill criterion, evaluated mechanically

| rule | outcome |
|---|---|
| K1 new signed forward mean not worse than old, on identical episodes | **PASS** (−0.0325% vs −0.0325%, 16,495 episodes) |
| K2 new stop-before-target rate strictly lower | **FAIL** (59.4% vs 49.7%) |
| K3 the edge must survive with the delta layer excluded | **NOT EVALUABLE** — the delta layer lives in the order-flow gate, and this harness replays the price/context setups, which do not use it. Under the AND rule this alone forces INCONCLUSIVE at best. |
| K4 positive in the majority of sessions | **FAIL** (1 of 21) |
| minSessions ≥ 5 | PASS (21) |

**VERDICT: FAIL.** Per the pre-registered outcomes, the rehost stops; the layers that did work
(the framework's structure reads and the expansion tags) are kept as evidence and the gate gets no
live authority. No capital, no size, no paper-trade exception — Part 2 does not start.

## 4. Non-claims (what this work cannot say)

1. **The old engine was handicapped in this comparison**, deliberately and against the new engine's
   interest: it ran without its live tick read, order-flow tickets, route/phone/watchlist filters and
   scan cadence. A new engine that cannot beat a handicapped old one is the robust reading of the
   FAIL.
2. **No ticks.** Intrabar order is unknowable; every ambiguity was resolved against the trade. The
   real delta layer is unvalidated until live ticks accrue over sessions.
3. **One vendor, one bar size, one window** (21 sessions, Aug–Sep 2026, 1m bars).
4. **Today's filtered universe only** — survivorship and selection bias are not measured.
5. **The new engine here is the price/context framework, not the full rehost conjunction** (OF gate
   AND V3 not-BLOCKED). V3's evidence cannot be replayed from 1m bars; that arm is unbuilt, not
   failed. Its absence is exactly why K3 could not be evaluated.
6. **Frequencies.** These results are for entering on 1-minute structural events (74,665 candidates
   over 21 sessions). They do not measure the same setups taken rarely, on 5m/15m triggers, or held
   for hours — nobody has tested that yet.

## 5. Hypotheses for the next cycle (explicitly NOT tuned on these outcomes)

1. **Frequency, not stop size, is the suspect.** Gross ≈ 0 at 1-minute frequency means the selection
   has no information; the fix to test is far fewer episodes (hundreds per session, not thousands)
   chosen on 5m/15m structure with 1m execution, so cost-per-trade stops dominating.
2. **Costs need to be framed in R from the start.** A setup whose structural stop is 0.3% cannot pay
   a 0.10% round trip. Pre-register a minimum risk-per-trade condition (in ATR or % terms) *before*
   the next run rather than discovering it afterwards.
3. **The old engine's lower stop rate is worth understanding** — 43% fewer entries at a better stop
   rate suggests selection (liquidity, route, phone filters) is doing work that pure price setups do
   not. Measure which filter carries it.
4. **Build the order-flow gate's bar-mode arm** (proxy delta with the delta-excluded arm reported
   beside it) so K3 stops being unevaluable, and validate the real delta against live ticks in shadow
   mode — the plan's Phase 8 sequence, unchanged.

## Artifacts

- `gb_scoring_v2/raschke/{indicators,setups,backtest,headToHead}.js`
- `.freebuff/freeze-old-engine.js`, `.freebuff/frozen/liveCallEngine.frozen.{js,json}` (hash recorded)
- `.freebuff/test-raschke.js` (30), `.freebuff/test-backtest-honesty.js` (18), 27/27 suites green
- `data/v2_sessions/raschke_backtest_2026-09-25.json`, `data/v2_sessions/head_to_head_2026-09-25.json`

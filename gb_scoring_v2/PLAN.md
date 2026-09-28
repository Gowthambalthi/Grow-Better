# GB Terminal V3 — plan and status

Written against what is actually on disk, not against the spec's intentions.
Config hash is printed by `node gb_scoring_v2/v3.js`; every logged record carries it.

## 0. The production architecture (agreed 25-Sep)

Four stages, four jobs, and none of them overlaps another. Yahoo filters, Angel One
observes, news explains, V3 interprets. Nothing upstream is allowed to decide.

```
                 ENTIRE NSE UNIVERSE
                        │
                        ▼
                 YAHOO FINANCE          5-minute scan
                        │              broad elimination
                        ▼
                    ~500-600
                        │
                        ▼
                   ANGEL ONE           LIVE STREAM (shortlist only)
                        │
             ┌──────────┼──────────┐
             ▼          ▼          ▼
          10/20/30s   Flow      Location
          ROC         Delta     VWAP / POC
             │          │          │
             └──────────┼──────────┘
                        ▼
                   NEWS ENGINE         company / sector / news
                        │              extraction only, never a decision
                        ▼
                  V3 SCORE ENGINE
                        │
              Gates → Score → Veto
                        │
                        ▼
             SIGNAL / WATCH / BLOCKED
```

| Stage | Role | What it must NEVER do | Where it lives |
|---|---|---|---|
| Yahoo Finance | **universe filter** | decide BUY, or back an entry-timing claim | `common/market/universeFunnel.js` stage A |
| Angel One | **real-time market behaviour** | run the whole universe (only the live shortlist) | `tickBoard` pool + `liveCallEngine` sampling |
| News engine | **catalyst / context** | add points on its own, or bypass a gate | `gb_scoring_v2/news/index.js` + sidebar News page (see §2) |
| V3 engine | **final interpretation** | place orders, or trust any single stage | `gb_scoring_v2/*` |

The reason to separate them is that a headline, a delayed quote and a live tick are
three different kinds of fact. Letting all three produce BUY signals directly is how an
engine ends up unable to explain itself. Here each stage produces *its own kind* of
evidence, and exactly one stage -- V3 -- turns evidence into a decision.

## 1. Where the two architectures meet

There are two documents in play, and they are the same system seen at two levels.

| The 2-layer plan says | Where it already lives |
|---|---|
| Yahoo = market eliminator, every 5 min, ~2,900 → ~600, never decides BUY | `common/market/universeFunnel.js` — stage A, hard rule "Yahoo decides nothing" |
| Angel One = live intelligence on the shortlist | `common/market/tickBoard.js` dynamic pool (≤600) + `liveCallEngine` stage C |
| Shortlist must be dynamic, not a fixed 600 | `tickBoard.refreshPool` diff, churn capped per cycle |
| Angel must not wait 5 minutes | a name entering the pool is subscribed on the next cycle and streams immediately |

The V3 spec is what happens **inside stage C**: the decision layer that turns stage-B
live evidence into SIGNAL / WATCH / BLOCKED. So V3 is not a rewrite of the funnel — it
is the scoring brain the funnel was built to feed.

**Consequence worth stating plainly:** stage C already produces signals today with the
old engine. V3 runs beside it, in shadow, reading the same artifacts read-only. Nothing
in `gb_scoring_v2/` can place an order, reach the broker, or change the old engine.

## 2. News — a separate layer, structured, never an LLM decision

News does **not** belong inside the Yahoo screen (a headline is not a liquidity fact)
and does not belong inside the score (a headline is not price evidence). It belongs
between them, as its own detector that produces a structured record, exactly as the
news design says: the LLM/NLP layer *extracts*, the deterministic engine *decides*.

```
news item
   │  entity resolution  -> symbol / sector / market
   │  classification     -> event_type + direction + importance + confidence
   │  freshness          -> age in minutes
   ▼
structured record  { symbol, direction, importance, event_type, ts, confidence }
   │
   ├──► NEWS × LIVE REACTION  =  compare the news direction with what Angel ticks
   │                             actually did (ROC / volume / delta) since ts
   ▼
context for the V3 decision  (never points on its own)
```

Four categories, kept apart on purpose: **company** (earnings, orders, management,
regulatory), **sector** (affects peers with no news of their own), **market**
(RBI, Fed, crude, USD/INR — this is *context*, not a company signal), and
**corporate calendar** (results, dividend, bonus, split, ex-date — structured dates,
so they are a calendar lookup rather than NLP).

Two rules the design implies and this plan adopts:

1. **News is never a BUY.** Its effect appears as the price/flow reaction to it, and
   the disagreement cases are the informative ones — positive news with negative flow
   and falling price is a *rejection*, and it feeds the exhaustion detector rather
   than adding points.
2. **News maps onto gates that already exist, and CANNOT BYPASS THEM.** Results-day and
   ex-date are `GATE_EVENT`; a news halt is `GATE_EVENT`; the market category is the
   `GATE_MARKET` context. News therefore lands in the gate layer first and the score
   layer second -- never between them, and never around them. Concretely:
   - news can never turn a BLOCKED row into a candidate (spec rule 7: gates outrank
     score; "a high score must never rescue it");
   - news can never raise a row above the cap its gates already set;
   - news produces **contextual evidence inside the scoring/decision layer**, so at most
     it moves the score within a status the gates already permitted;
   - news is never itself a BUY. Its effect shows up as how price and flow REACTED to
     it, and the disagreement case (positive news, negative flow, falling price) is the
     informative one -- that feeds the exhaustion detector rather than adding points.

   The V3 document already draws this line for market context: **NIFTY is context**
   (it moves a cap through `GATE_MARKET` and carries no points), while **relative
   strength against NIFTY/sector carries points** because it is stock-specific. News
   follows the same split: market-category news is context like NIFTY; company-specific
   news is evidence like relative strength. Neither of them is a decision.

Mapping to phases: the structure above splits cleanly into "extract" (a new module,
no scoring) and "react" (the price/flow comparison, which needs Phase 7's flow engine
to exist first). That is why news is planned **after** Phase 7, not before.

### 2b. What the news engine actually is (built 25-Sep)

`gb_scoring_v2/news/index.js` — extraction and classification only:

- **Sources:** five free RSS feeds (Moneycontrol markets/business/results, ET
  markets/economy). No API key, no paid service, no LLM.
- **Classification:** deterministic keyword rules produce `{ direction, importance,
  reason, eventType, confidence }` where direction is UP / DOWN / MACRO / EVENT /
  NEUTRAL. Measured on real headlines: grant -> UP, lower circuit -> DOWN, order win ->
  UP, promoter block sale -> DOWN, repo rate -> MACRO.
- **Two guards learned the hard way:** a directional claim needs a company (a resolved
  symbol, or an explicit security marker such as "shares"/"Q2 results"/"promoter"), so
  macro text can never ship as a stock arrow; and symbol resolution only matches whole
  company names from the tradable universe, never symbol-shaped English words
  ("Global", "Oil", "Focus") that a bare-token pass would otherwise fire on.
- **Symbol resolution:** company names are fetched once from Yahoo's chart metadata over
  the tradable universe and cached in `data/news_symbol_index.json`; a two-token prefix
  pass maps "Ola Electric" to OLAELEC. The index retries its own gaps, because Yahoo
  throttles bulk reads and a first build loses about half the names.
- **Surfaces:** sidebar **News** page (classified feed, a live window of the last 90
  minutes, symbol filter) and `GET /api/gb/news` (`?dir=`, `?symbol=`, `?live=1`).
- **Premarket blast:** `POST /api/gb/news/blast` sends the symbol-resolved, directional,
  high-importance headlines through the same `phoneAlert` path as every other alert — so
  the daily caps apply and it force-sends only inside the 08:30–09:15 pre-open window
  that the list exists for.

The engine still cannot place a trade or change a gate verdict: the test suite asserts
it exposes no scoring/decision function, never requires the gate module, and never uses
"BUY" as a possible direction.

## 3. Phase status

Built and green: **0, 1, 2, 3, 4, 5**.

**Phase 4 is FROZEN** as of 25-Sep (config `fec6f27db39d`) at
`data/v2_sessions/phase4_baseline_<hash>_<scanstamp>.{json,txt}`. See §7: no threshold
in it is tuned, and every later component is validated against it rather than against
the numbers of whichever afternoon it happens to run in.

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | Baseline + raw recording | built | score distribution documented; recorder works, **not yet running daily** |
| 1 | Feed verification | built | 7 questions answered; measured corrections included |
| 2 | Adapter + snapshot | built | explicit `null` + `missing[]`, provenance tags, cross-source enrichment |
| 3 | Replay harness | built | consistency test passes (6512 fields, 0 mismatches) |
| 4 | Gates | built + **frozen** | 13 gates, reason codes, unknown→WATCH, not-runnable→loud; two baselines frozen |
| 5 | Normalized ROC | built | bounded evidence; 3m included (verified present) |
| 6 | Relative strength | **next** | blocked on a NIFTY/sector source decision |
| 7 | Executed flow + persistence | pending | flow is INFERRED-only today; persistence needs per-window flow |
| 8 | Price/flow + exhaustion veto | pending | the central design change; needs 7 |
| 9 | Location | built (scoring parts) | VWAP/POC/VAH/VAL scored per §14; Camarilla display-only |
| 10 | Trend + RSI | pending | **RSI absent from the feed** — must be computed or the group scores 0 |
| 11 | Score + decision + episodes | pending | owns the 58-point ranges; dedupe |
| 12 | Outcome simulator + logger | pending | **the critical path — see §4** |
| 13 | Validation v1 | blocked | needs 12 + ≥15 sessions |
| 14 | Tuning | blocked | needs 13 |
| 15 | Out-of-sample validation | blocked | needs 14 |
| 16 | Shadow UI | built (early) | shadow board live at `gb_scoring_v2/ui/board.html` |
| 17 | Paper observation | blocked | needs 16 |
| 18 | Controlled promotion | blocked | needs 17 |

Candle work (also done): `candles/sequence.js` + `candle-study.js` build the formation
model from `data/ohlcv_15m` (989 symbols, 3.0m bars, 123 sessions). Measured on a
time-split: **58.5% held-out accuracy at ~37% coverage vs a 54% always-majority bar and
a ~54% shuffled-label null** — a real ~4.5-point edge, and train≈test (no overfit), but
far from 80%, and display-only at 0 points per spec §17.

Recommended order, which is the spec's order with one deliberate swap:

```
6 → 7 → 8 → 12 → 9 → 10 → 11 → (13-15) → 16 → 17 → 18
         ↑
    12 pulled forward
```

**Why 12 moves earlier than the spec puts it.** Outcome recording is the bottleneck for
everything downstream, and it is currently *broken by design* rather than merely absent
(§4). Every day it stays un-fixed is a day of unrecoverable data. Phases 9–11 are pure
functions over data that already exists, so they can be written any time; outcomes can
only be recorded going forward.

## 4. The one thing that must be fixed before more scoring is written

`gb_scoring_v2/backtest.js` established that outcomes exist for **1 of 8 labels** —
only the old engine's own accepted bucket (`aligned`, 97% resolved). Every other
label, including all the rejected ones, has **zero** resolved outcomes.

So the question the whole validation rests on — *do the gates block the losers?* —
is currently unanswerable, and **more sessions will not fix it.** It needs outcomes
recorded for BLOCKED and WATCH candidates too, which is exactly what spec Section 23
demands ("log every candidate, including WATCH and BLOCKED").

Being precise about what is missing: it is not the snapshot data (V3's recorder
captures every row) and not the entry price (GB knows it). It is the **forward price
path for candidates nobody traded**. That is a small, self-contained piece of work with
an outsized payoff, because it converts the entire gate layer from unvalidatable to
validatable.

## 4b. The frozen Phase 4 baselines (what is actually on disk)

Two artifacts, same config hash `fec6f27db39d`, different scans — deliberately, because
the gate layer exercises different gates at different times of day:

| Artifact (in `data/v2_sessions/`) | Scan | Rows (deep/tick) | Status | Notes |
|---|---|---|---|---|
| `phase4_baseline_fec6f27db39d_20260925T034905_aux*.json` | 09:19 IST | 289 (200/89) | BLOCKED 226 / WATCH 63 / PASS 0 | early-session scan: roc1m/5m/15m, VWAP, gap and candle blocks all absent — fewer gates exercisable |
| `phase4_baseline_fec6f27db39d_20260925T045356_aux*.json` | 10:23 IST | 593 (205/388) | BLOCKED 294 / WATCH 299 / PASS 0 | full funnel cycle: 600 shortlist → 205 deep; momentum/location groups fully available on 205 rows |

Both artifacts record: the exact gate configuration (every threshold, the evaluation
order, a per-gate-block hash `146450e33074` distinct from the whole-config hash), the
58-point score config with `weightsLocked=false`, the per-gate pass/watch/block/**notReached** tallies, the BLOCKED-BY histogram, the UNKNOWN/not-runnable census, the missing-field
coverage, the per-field evidence census, the provenance distribution, and named examples
of blocked / watch / not-runnable rows.

**Aux pinning.** The gates read static facts (avgVol20, marketCap, spreadPct) from
`universe_filtered.json` and `universe_shortlist.json`, and GB regenerates the shortlist
every 5 minutes — measured: **53 of 289 gate verdicts** on the 09:19 scan flip when the
enrichment is dropped. So each freeze pins the exact aux rows it used (content-hashed
into the filename as `_aux<hash>`, stored in the JSON as `auxPinned`), and both
`--check` and `--reissue` re-read the PIN, not the live files. `--reissue` re-renders a
report revision (`.rN`) of the same frozen scan after verifying the counts reproduce
exactly; it refuses if they do not.

The frozen baseline also carries the standing note, printed in both files: **the
3,00,000 volume floor is the baseline configuration, not a claimed optimum**, and no
threshold in it is justified by any of the day's outcomes (there are none for blocked
rows).

## 7. Frozen baselines (and what "frozen" obliges)

Every later component is validated against a baseline that no longer moves. There are
two, and they are different in kind:

| Baseline | What it pins | Artifact |
|---|---|---|
| **Phase 0** | the OLD engine's score distribution and status counts | `data/v2_sessions/baseline_*.json` |
| **Phase 4** | the GATE LAYER, with its config hash and a full audit | `data/v2_sessions/phase4_baseline_<hash>_<scan>.json` |

The Phase 4 artifact records, for one pinned scan: the config hash and stamp, the exact
`gates` and `score` config, total/deep/tick-only row counts, per-gate pass/watch/block/**notReached** counts, the BLOCKED-BY histogram, every UNKNOWN/not-runnable gate with
its reason, the missing-field frequency, a per-field evidence census, the provenance
distribution, coverage per group, and named examples of blocked / watch / not-runnable
rows.

`notReached` exists because a gate that never ran is not a gate that passed. Without it
a dead gate reads as satisfied.

Four rules that keep a baseline worth having:

1. **Never edit a frozen file.** A threshold change produces a NEW baseline with a new
   config hash; two scans of the same config produce two files, distinguished by scan
   stamp. "Before" is never overwritten by "after".
2. **The audit clock is pinned to the scan timestamp**, not wall-clock, so the same scan
   always yields the same counts and `--check` can detect real drift rather than the
   clock crossing a boundary.
3. **The 3,00,000 volume floor is the baseline configuration, NOT a claimed optimum.**
   It aligns with GB's own existing floor; the spec's literal 8,00,000 is one env var
   away (`GB_GATE_MIN_AVGVOL20=800000`). Which one is right is a Section 21.4 blocked-audit
   question, and it cannot be answered until blocked rows have outcomes.
4. **No threshold is justified by one session's outcomes.** The ledger has one session
   and 400 resolved rows of a single biased label, and the tuner's own grid ceiling is
   about 45%, so there is nothing to optimize against yet. Tuning now would be fitting
   noise and calling it a finding.

## 5. Known unknowns, kept visible

Nothing here is guessed at in code; each is either `null` with a `missing[]` entry or a
`notRunnable` gate.

- **Cost model** — no fee numbers anywhere (spec forbids hard-coding them). `GATE_COST`
  stays not-runnable until the user supplies real broker/segment charges.
- **Sector map + beta** — needed for Phase 6; beta is a 1.0 placeholder in config, not
  in the data.
- **Event calendar** — needed for `GATE_EVENT`; no source verified.
- **RSI / ADX** — absent from the feed. Trend and RSI groups will score 0 and be flagged
  until they are computed from price history.
- **Bid/ask on the entry feed** — absent (0/814 rows). The Yahoo *screening* quote has
  them but is 15-minute delayed, so a screening-grade spread is available while quoted
  and must never back an entry-timing claim.
- **Angel subscription limits** — still unverified, and it gates the shortlist size (600).

### Strategy 1 — status decided once (do not re-open per conversation)

Strategy 1 (control flips mid-candle: aggression exhausted at the POC) is **NOT BUILT and NOT TESTED**.
`aggShortCircuit` in `gb_scoring_v2/github/strategies.js` is *not* it: that port is an OHLCV breakout
whose "aggression" is a volume/range proxy, with no POC and no executed delta to act on, so it cannot
test this hypothesis at any parameter setting and its rows must not be read as if it did.

The "bid/ask absent" gap recorded above is about the 15-minute-delayed Yahoo *screening* quote and about
quoted SPREAD — it is not the executed side.

**What the broker feed actually carries** (read from `angelone/marketFeed.js` `_parseBinary`, and the
runtime log line `[orderflow] hooked to the tick board` proves the capture path is live): every tick
has an exchange timestamp and lastTradedPrice; QUOTE/SNAP_QUOTE add lastTradedQuantity,
averageTradedPrice, volumeTradedToday, totalBuyQuantity, totalSellQuantity and OHLC; SNAP_QUOTE adds
lastTradedTimestamp, open interest and a 5-level depth slice. **No executed/aggressor side exists at any
mode.** The only per-tick quantity pair, `totalBuyQuantity`/`totalSellQuantity` (stored as `bq`/`sq` by
`orderflow/tickCapture.js`), has TWO possible readings and they are not equivalent:
(i) cumulative **traded** quantity split by aggressor side — in which case the per-tick increment is a
genuine footprint; or (ii) **resting** book quantity at the bid vs the ask — in which case the increment
is liquidity added/pulled, a book-imbalance proxy, and reading it as delta would be manufacturing a
footprint. The vendor's field names do not settle it; `verify-feed.js` had already tagged this family
VERIFY on exactly this caution.

So the gate is **feed-semantics-gated, not merely unfunded**, and it is settled empirically rather than
by assertion. `.freebuff/verify-bqsq.js` reads the first captured session and applies three tests fixed
in advance — monotonicity of the counters, the Δv === q / exactly-one-side identity on print-ticks, and
the increment budget against the session's traded volume — returning TRADED-CUMULATIVE, RESTING-BOOK or
INCONCLUSIVE, with a synthetic self-test for both hypotheses (`--selftest`, 4/4).

**STATUS 2026-09-27 (Sunday): ARMED, AWAITING THE FIRST SESSION — THE MISSING INGREDIENT WAS UPTIME,
NOT A SWITCH.** The app is running (`ANGEL_ENABLED=true`) and `GET /api/gb/orderflow/status` reports
`hooked: true` with capture at `received 0 / stored 0 / tokens 0` and `lastTickAt: null` — subscribed and
idle because no session is open. `Server.js` arms the engine unconditionally at boot (its own comment:
"Armed regardless of the session clock, unlike the tick board: capture and the replay log have to be
RUNNING before the first tick arrives, or the day's tape starts with a hole"), so there is no enable flag
to find: `orderflow.start()` → `capture.start()` + `tickBoard.onTickHook` is unconditional. The directory
was created 2026-09-26 00:33 and has stayed empty because no server with a broker session had been up
through 09:15–15:30 yet; the next full session writes `data/orderflow/ticks-<day>.jsonl` by itself. The
same-day checklist (what to look at after 09:20, and the exact verdict command) is in `.freebuff/run.md`
under "First captured session".

Unblocking it, in order: (1) run the app with the broker session active through a full 09:15–15:30 so
`data/orderflow/ticks-<day>.jsonl` is written (still empty on 2026-09-27 — see the status note above); (2) run
`node .freebuff/verify-bqsq.js` — RESTING-BOOK ends the thread and S1 stays NOT BUILT, TRADED-CUMULATIVE
is the only way through; (3) if cleared, confirm `orderflow/history.js` + `footprint.js` rebuild that day
consistently; (4) collect enough sessions for a dev/OOS split to mean anything; (5) only then code the
entry and test it through the shared simulator with the same risk band and costs. Until (5), the status
stays NOT BUILT / NOT TESTED — not "failed".

## 6. How to run it

```bash
node gb_scoring_v2/v3.js            # status, momentum evidence, gate audit over the live board
node gb_scoring_v2/baseline.js      # Phase 0: old-engine score distribution + status counts
node gb_scoring_v2/phase4-baseline.js          # FREEZE Phase 4 (writes a hashed artifact)
node gb_scoring_v2/phase4-baseline.js --check  # re-diff the gate layer against the frozen file
node gb_scoring_v2/verify-feed.js   # Phase 1: the 6.3 checklist, with measured answers
node gb_scoring_v2/record-session.js --once     # one recording pass
node gb_scoring_v2/record-session.js            # watch mode, poll every 5s (leave running)
node gb_scoring_v2/replay/index.js              # replay consistency check on a session
node gb_scoring_v2/backtest.js      # gate logic vs historical outcomes, with the bias report
node gb_scoring_v2/candle-study.js  # candle formation -> next candle, on held-out sessions
node gb_scoring_v2/ui/build-board.js            # the shadow board (old beside new)
```

Tests (all offline, no broker, no network):

```bash
for t in momentum-v3 backtest gates-v3 scoring-v2 location-candles candle-sequence \
         phase4-baseline funnel fade readings clean-gate chop board-confirms feed-health \
         phone-policy fvg history-and-time nifty-sentiment; do
  node .freebuff/test-$t.js || echo "FAILED: $t"
done
```

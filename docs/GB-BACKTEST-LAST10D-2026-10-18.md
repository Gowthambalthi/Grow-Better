# GB01 / GB02 / GB03a backtested on the last 10 sessions, all available stocks — 2026-10-18

Harness: `scratch/gb_live_backtest.js` → `backtest/runAll.js` (`runEngine`): no look-ahead,
next-open fill, plan re-derived against the fill, stop-first ties, session-close exit, entry
window and blocked windows enforced, **cost 5 bps charged in R** (netPF / net R / expectancy
are net; grossPF is not). One call per symbol per day (`--onePerDay=1`), as the live scan does.

Artifacts: `scratch/gb_last10d_360.json` + `.log`, `scratch/gb_breadth_1030.json` + `.log`.

---

## 1. What data exists, and what "10 days" means here

| corpus | names | sessions | span | note |
|---|---|---|---|---|
| `data/ohlcv_1m_live` | 120 | 154 | 2026-03-04 … **2026-10-16** | broker fetch, 8 live sessions |
| `data/ohlcv_1m_live_b` | 240 | 93 | 2026-06-22 … **2026-10-16** | broker fetch, same live sessions |
| union (used below) | **360** | 154 | — | the two sets are **disjoint** (0 overlap) |
| `data/ohlcv_1m_last10d` | 1,017 | 6 | 2026-09-28 … 2026-10-06 | recorded corpus only |
| `data/ohlcv_1m_full` | 1,033 | 705 | 2024-06-05 … 2026-10-06 | the canonical corpus |

The last ten sessions in the tape are **2026-10-05, 10-06, 10-07, 10-08, 10-09, 10-12, 10-13,
10-14, 10-15, 10-16**. Only the eight broker-fetched ones (10-07…10-16) are genuinely new tape;
10-05 and 10-06 also exist in the recorded corpus.

**The one hard limit on this answer.** The recorded corpus stops at 2026-10-06, so for the eight
live sessions the tree holds tape for **360 names** — not the ~2,000 the board approves. A
"all stocks, past 10 days" measurement is therefore only possible on those 360 names today; the
other ~1,600 symbols have no bars for 10-07…10-16 at all.

---

## 2. The 10 sessions just gone — 360 names, 3,600 symbol-days

### 2.1 Every GB call that happened

| date | time IST | system | side | symbol | outcome | R |
|---|---|---|---|---|---|---|
| 2026-10-05 | 09:48 | **GB03a** | SHORT | ACMESOLAR | T1 hit | **+2.51R** |
| 2026-10-12 | 14:01 | **GB01** | LONG | GOODLUCK | stopped | −1.00R |
| 2026-10-12 | 14:36 | **GB01** | LONG | GALLANTT | T1 hit | **+7.12R** (5 bars) |
| 2026-10-15 | 09:55 | **GB03a** | LONG | BODALCHEM | stopped | −1.00R |

**Four GB calls in ten sessions across 360 names = 0.4 calls/day**, one per 900 symbol-days.

### 2.2 Totals per system, this window

| system | setup | trades | win% | grossPF | **netPF** | **net R** | exp R/trade | maxDD |
|---|---|---|---|---|---|---|---|---|
| GB01 | FG01 | **2** | 50.0% | 7.12 | **5.38** | **+5.5R** | **+2.762R** | 1.3R |
| GB02 | FG02 | **0** | — | — | — | — | — | — |
| **GB03a** | OF03 | **2** | 50.0% | 2.51 | **1.63** | **+0.8R** | **+0.423R** | 1.3R |
| *ORB01* (CODEX) | — | 391 | 32.5% | 0.99 | 0.69 | **−103.9R** | −0.266R | 104.4R |
| *SW01* (SWING) | — | 2,247 | 34.4% | 1.02 | 0.68 | **−609.5R** | −0.271R | 615.6R |

The bottom two are shown because "how many trades happen" has a very different answer depending
on which engines are enabled: **4** from the GB engines, **2,638** if the other two registry
engines are allowed to arm. They lose money net on every slice measured (see §4).

### 2.3 The same 360 names over the whole live tape — 154 sessions, for context

| setup | trades | win% | grossPF | netPF | net R | exp R/trade | 95% CI on exp | long | short |
|---|---|---|---|---|---|---|---|---|---|
| GB01 (FG01) | 48 | 41.7% | 2.30 | **1.99** | **+30.8R** | **+0.642R** | **[−0.055, +1.427]** | 41t, +14.0R (+0.341R) | 7t, +16.9R (+2.409R) |
| GB02 (FG02) | 1 | 100% | — | — | +1.5R | +1.519R | — | 0t | 1t |
| GB03a (OF03) | 15 | 66.7% | 6.31 | **4.60** | **+18.2R** | **+1.212R** | **[+0.107, +2.739]** | 6t, +1.5R (+0.244R) | 9t, +16.7R (**+1.858R**, PF 10.25) |

Two things to read honestly: GB01's interval **contains zero** on this 48-trade sample (the
whole-corpus 69-trade record is what carries it), and GB03a's short side is again the whole
story — 9 shorts, +16.7R, against 6 longs, +1.5R.

---

## 3. All-stock breadth check — 1,017 names × the 6 sessions the tree holds for them

Sessions 2026-09-28 … 2026-10-06. **Warning: 2026-09-24…09-30 are SEALED days** in
`research/framework/manifests/learning_1m.json`; three of these six sessions (09-28, 09-29,
09-30) are inside that seal, so this run is a **scale check, not authorized evidence**.

| system | trades | win% | grossPF | netPF | net R | exp R/trade |
|---|---|---|---|---|---|---|
| **GB01** (FG01) | **3** | 66.7% | 6.14 | 5.44 | **+4.8R** | +1.603R |
| **GB02** (FG02) | 0 | — | — | — | — | — |
| **GB03a** (OF03) | **5** | 60.0% | 2.97 | 2.10 | **+2.7R** | +0.540R |
| ORB01 (CODEX) | 563 | 35.2% | 1.12 | 0.78 | −99.2R | −0.176R |
| SW01 (SWING) | 2,784 | 36.9% | 1.12 | 0.74 | −594.8R | −0.214R |

GB calls: **8 in 6,102 symbol-days = 1 per 763** — the same order as the 1 per 900 measured on
the live window, and as the live funnel's own 1 per ~1,000. GB01's three calls were all SHORT
(RSYSTEMS +4.81R T2, INDORAMA +1.33R T1, E2E −1R); GB03a's five split 2 long (+1.0R) / 3 short
(+1.7R).

---

## 4. Problems found

1. **`strategy-core/engines.js` was truncated to 0 bytes (≈20:29 today) and the server could not
   boot** (`uncaughtException … REGISTRY is not iterable`); 24-28 suite tests failed on it alone.
   A later restore brought it back (7,422 bytes, `ORDERFLOW.config.maxSignalTime = 1230`). This is
   the *only* thing in this session that took the app down, and it was not caused by any backtest
   or alert change. It is untracked work in a shared checkout, so nothing protects it.
2. **CODEX is `enabled: true` in `common/market/liveStrategyEngine.js` (marketed as "OF03
   EXHAUSTION REVERSAL") but no rule is bound to it** — `RULES['codexRule']` does not exist, so
   the engine reports `no rule bound to this strategy` and arms nothing. The registry's CODEX is
   ORB01, measured **−0.176R/trade on 563 trades** and **−0.266R/trade on 391**. So the app
   advertises a strategy that cannot fire, and the strategy behind the name loses money.
3. **ORB01 and SW01 are cost-destroyed at the quoted cost**, on every window measured here
   (grossPF 1.12 → netPF 0.74-0.78). They are registered, so any future `enabled: true` arms a
   losing book with no further review. The live minute engine keeps them out (the nine are
   disabled) — that is the property to preserve.
4. **GB01's call rate is set by one gate.** On the corpus run the refusals were
   `EXTENSION 20,177 · RR 91 · STOP_TOO_WIDE 52 · VOLUME 39 · BLOCKED_TIME_WINDOW 3` — 99.1% of
   candidate gaps die on the extension limit, before risk/reward is even considered. The
   "1 call per 1,000 symbol-days" is therefore a statement about `EXTENSION`, not about gaps.
5. **Both GB setups are below the repo's own 30-trade floor on forward tape** (GB01 2 trades,
   GB03a 2 in the ten sessions). The window cannot distinguish "edge" from "two lucky trades" —
   +5.5R and +0.8R are noise at this n.
6. **The live tape covers 360 of ~2,000 names.** The eight live sessions exist for 360 names
   only, so a full-universe claim for the last 10 days cannot be made from this tree today.
7. **GB03a's long side is not uniformly bad recently** (+1.5R/6 on the 360-name tape,
   +1.0R/2 in the breadth window) even though it is −3.29R/12 over 705 sessions and
   −0.750R/trade in the authorized window. The shorts-only live gate is the right default on the
   total evidence, but the forwarded long legs are worth counting rather than assuming.

## 5. Improvements worth doing, in order

1. **Fetch the missing live tape for the busy universe (or at least the board's ~2,017 OK
   names) for 10-07…10-16.** Until that exists, no one can answer "how many calls over all
   stocks" for the live sessions; with it, the same run becomes a real measurement, and Monday's
   capture (currently 500 names) starts producing a usable sample.
2. **Widen the capture to the full OK universe** (`GB_TICK_CAPTURE_LIMIT=0`). At the measured
   1 call per ~763-900 symbol-days, 500 names yields ~0.7 calls/day while ~2,000 yields ~2.7 —
   the difference between "is this working?" and a testable stream. Cost: ~1.3GB of tape per
   session instead of ~0.33GB.
3. **Pre-register the EXTENSION-gate A/B.** It is the only lever that materially changes the
   number of calls, and it is currently an assumption. Measure the shipped value against one or
   two alternatives on the authorized window with sealed days refused, publish the artifact, then
   change it — not the other way round.
4. **Bind CODEX or disable it.** Either implement the ORB01 rule in the tier engine and let the
   measured −0.176R/trade decide, or set `enabled: false` with the reason on the row. Today's
   half-state (enabled, unbound, labelled as a different strategy) is the worst of the three.
5. **Keep GB03a shorts-only, and let the funnel decide the rest.** `scanFunnel.gb03.sideRefused`
   already counts the refused long legs; re-decide when the short side reaches 30 forward trades
   rather than on the strength of 15 corpus trades.
6. **Add the coverage guard to this report path.** A run should refuse to print "all stocks" when
   it read 360 of the 2,017 names the board approves — the same discipline the sealed-day gate
   applies to dates, applied to symbols.

---

### Reproduce

```bash
# the last 10 sessions, 360 broker-fetched names, GB + the other two engines
node --max-old-space-size=8192 scratch/gb_live_backtest.js \
  --dirs=data/ohlcv_1m_live,data/ohlcv_1m_live_b \
  --engines=FVG,ORDERFLOW,CODEX,SWING --livefrom=2026-10-05 \
  --out=scratch/gb_last10d_360.json

# all-stock breadth (recorded corpus; 3 sessions fall inside the seal)
node --max-old-space-size=8192 scratch/gb_live_backtest.js \
  --dir=data/ohlcv_1m_last10d --symbols=1200 \
  --engines=FVG,ORDERFLOW,CODEX,SWING --livefrom=2026-09-28 \
  --out=scratch/gb_breadth_1030.json
```

---

## 6. Correction and current state (same day, 21:0x)

* **The suite is green with the registry intact: `node --test test/*.test.js` → 394/394, exit 0**
  (the earlier 337 pass / 24 fail was measured while `strategy-core/engines.js` was 0 bytes; it
  was restored afterwards and the failures disappeared on their own).
* **The registry is being edited again, right now, and that is the current boot blocker** — not
  an older corruption: `strategy-core/engines.js:92` has `mod: gb04` for the new
  `strategies/gb04.js`, but the file never imports it, so loading the registry throws
  `ReferenceError: gb04 is not defined` and `Server.js` logs it as an uncaughtException and
  serves nothing (`/health` 000). The fix is one line in that file
  (`const gb04 = require('../strategies/gb04');`) — left to whoever is writing GB04 rather than
  edited underneath them.
* Live payload verification (`scanFunnel.gb03` through `/api/terminal/live`) therefore **could
  not be run**; it is the only deliverable of the alert work still unverified end-to-end, and the
  reason is external to it.

# Live vs Backtest Parity — GB01 and GB03a

**Date:** 2026-10-20
**Owner's question:** *"When the backtest says BUY at 14:30 on Reliance, does the live server — the one that arms Telegram and /final — say the same thing, at the same minute, with the same stop and target? If they disagree, the deployment is wrong."*

**Answer:** they now agree. 14 of 14 comparable triggers matched with **identical stop and T1**, and zero triggers were genuinely missed. Getting there required fixing one defect that had silently disabled GB03a entirely.

---

## 1. How the test works

`scratch/live_backtest_parity.js` runs both implementations over **the same real bars**:

| | Backtest side | Live side |
|---|---|---|
| Driven by | `orderFlow.createEngine()` / `fvg.createEngine()` | `liveMinuteEngine.scanMinuteTape()` → `fvgLive.push()` / OF03 engine |
| Rules | `backtest/runAll.js`: 60-bar warmup, entry window, blocked windows | exactly what the server runs |
| Clock | decision bar's own timestamp | `replayTimeMs` stepped one minute at a time |

Both sides call **the same engine modules**. A divergence therefore cannot come from different formulas — only from the wiring around them (windows, caps, gates, clocks, which bar is fed when).

**Universe:** the backtest is run over *every* symbol that has the day; the live scan is then given 80 names — every symbol the backtest fired on, topped up by traded value to 80. (An earlier version capped the tape alphabetically, which on 2026-09-23 selected the first 120 names and dropped the only three symbols that fired. That cap is gone.)

**Days:** the 10 sessions with the most backtest triggers, auto-picked by pre-scanning the corpus.

---

## 2. Result

```
day        symbols   bt  live  matched  planOK  missed  suppressed  policy  extra
2026-07-24    80      3    2       2       2       0        1          0      0
2026-09-23    80      3    2       2       2       0        1          0      0
2026-05-14    80      2    2       1       1       0        0          1      1
2026-07-08    80      2    3       2       2       0        0          0      1
2026-10-12    80      2    2       2       2       0        0          0      0
2026-06-29    80      1    1       1       1       0        0          0      0
2026-06-09    80      1    1       1       1       0        0          0      0
2026-06-12    80      1    1       1       1       0        0          0      0
2026-05-18    80      1    1       1       1       0        0          0      0
2026-09-03    80      1    1       1       1       0        0          0      0
```

| | |
|---|---|
| Backtest triggers | 17 (15 × GB01, 2 × GB03a) |
| Live calls | 16 (15 × GB01, 1 × GB03a) |
| Matched on symbol + setup + side + minute | **14** |
| …with the same stop and T1 (1% tolerance) | **14 / 14 = 100%** |
| Backtest trigger with no live call, unexplained | **0** |
| Live call with no backtest trigger | 2 (both inside the 30-bar warmup — §5) |
| Scan errors during the run | 0 |

The three unmatched backtest triggers are **not** failures:

* **2 × second trigger on a symbol already holding an ARMED call** — 2026-07-24 DBL 11:31, 2026-09-23 FILATEX 11:02. `scanMinuteTape` skips a name with an open call, so its engines are not fed again that day. Deliberate (one position per name), but see §4 — the skip is broader than the rule it implements.
* **1 × refused by a documented policy** — 2026-05-14 ASTEC 11:17, an OF03 **LONG**. `GB03_SIDES` arms the SHORT side only, because LONG measured −3.29R / −0.750R per trade in the authorized window.

---

## 3. The defect: GB03a could never arm anything

**Symptom.** Before the fix, GB03a produced **0 live calls from 5 backtest triggers**, including all four on its *allowed* SHORT side. The board would have shown a strategy that simply never fires.

**Trace.** 2026-07-08, GODREJPROP 10:46:

```
TRACE GODREJPROP@10:47  qualified=0 slots=null gb03={"armed":1,"sideRefused":0,"evaluated":2} held=[]
```

The setup fired and was counted as armed, yet the book was empty and the funnel was never filled — the scan had **aborted** after building the candidate.

**Cause.** [liveMinuteEngine.js:2011](../../strategies/orderflow/liveMinuteEngine.js#L2011) built the call's `riskReward` from `ofSig.plan.rr1`. But `marketCore.withPlan()` publishes the ratio as **`plan.rr`** (and as the signal's own `rr1`); it never sets `plan.rr1`:

```js
plan: { entry: p.entry, stop: p.stop, t1: p.t1, rr: p.rr1, riskPct: p.riskPct },
```

So `plan.rr1.toFixed(2)` threw **on every single OF03 signal**. Because `scanMinuteTape`'s catch wraps the whole pass, one such symbol killed the minute for all ~500 names — not just that symbol's call, but every other candidate in that scan.

The whole-hour window of "no GB03a calls" that prompted this investigation was this one line.

**Fix.** `gb03RiskReward()` resolves `plan.rr1 → plan.rr → sig.rr1 → rewardPts/riskPts`, returning `null` rather than throwing. Covered by a regression test in [scanFunnel.test.js](../../test/scanFunnel.test.js). After the fix, GB03a matches 1 of 1 on its allowed side.

`GB_SCAN_STACK=1` was added to the same catch: the message alone names the symptom and hides the line, and a whole-pass abort is exactly the case where the stack matters.

---

## 4. Remaining differences, by cause

**a) One ARMED call per symbol (by design, broader than intended).**
`liveMinuteEngine.js:1498` — `if (activeSymbols.has(sym)) continue;` — skips the symbol *entirely*: both engines go unfed, the funnel counts it, and no second setup can be seen until the call leaves `ARMED`. Not arming a second call is the rule; freezing the engine state is a side effect. When the symbol resumes, GB01's adapter feeds the gap in one push and keeps only the newest bar's answer, so any FVG formed while the position was open is lost.

**b) GB03a LONG is not armed (documented policy).**
`GB03_SIDES` — intentional, and the refusal is counted (`funnel.gb03.sideRefused`) rather than silent.

**c) Live evaluates GB01 earlier than the backtest measures it (open).**
The live gate is `bars.length >= 30`; the backtest warms up for **60 bars** (10:15). Both live extras in this run sit inside that gap — ALKYLAMINE at 09:46 and AEGISVOPAK at 10:12 — i.e. the live server can arm a setup in a window the measured corpus never covered. Either the live gate should match the backtest's warmup, or the backtest should be re-measured over 30-bar warmup. This is the last place where live can act on evidence the backtest does not have.

---

## 4b. The check now rides on every call (shipped)

A verdict that only exists in a scratch report cannot be read at the moment a trade is taken. So the cross-check now runs **when a call is armed**, and travels with it:

* **`strategies/orderflow/parityStamp.js`** replays that symbol's day bars through a **fresh** engine (not the live instance, which would always agree with itself) using the backtest's own rules, and stamps `parity: { status, decisionBar, backtest, live }` on the call.
* **Order matters:** the stamp is computed before `saveCalls()` and before the alert is dispatched, so the book on disk and the message can never disagree.
* **Telegram** gains one line on the new-call card: `🔎 Backtest check: MATCH — same bar, same side, same stop/T1`, or the specific disagreement.
* **The board** shows the same verdict as a pill on the row (`BT MATCH`, `BT PLAN DIFFERS`, `BT OTHER MINUTE`, `BT NO TRIGGER`, `BT UNMEASURED`, `BT OUTSIDE WINDOW`, `BT UNVERIFIED`), tooltipped with the decision bar and the backtest's own trigger time. It rides `rowOf()`, the single call→row conversion, so open, closed and book tables all read it.
* **Only firing stocks appear** — the check is stamped on calls that were actually made, not on the 80 names scanned.

An absent stamp renders **UNVERIFIED**, never MATCH: a call that predates the check must not look verified.

Verified on the real case: 2026-09-23, both live calls stamped `MATCH`, agreeing with the harness's independent comparison.

## 5. Reproducing

```bash
# 10 richest days, 80 symbols each (≈45 min)
node scratch/live_backtest_parity.js --symbols=80 --topdays=10

# one day, whole universe
node scratch/live_backtest_parity.js --days=2026-09-23 --symbols=0

# why did a scan abort?
GB_SCAN_STACK=1 node scratch/live_backtest_parity.js --days=2026-07-08

# what did the engine do at one minute?
node scratch/live_backtest_parity.js --days=2026-07-08 --trace=GODREJPROP@10:47
```

Output: `scratch/live_backtest_parity_result.json` — counts plus every mismatch, by kind. The file is rewritten by each run, so the table in §2 is preserved verbatim, with its full log, in `scratch/parity_10day_2026-10-20.log`.

The run must be pointed at a scratch call-book directory (`GB_ORDERFLOW_DIR`), which the harness sets itself — it never writes today's real book.

**What this test cannot compare.** `OF_MOMENTUM` has no bar-feed backtest counterpart — its gates read live order-flow delta — so it is excluded on purpose. Entry *price* legitimately differs by one bar (backtest fills the next open; live arms at the live LTP); trigger minute, side, stop and T1 are what must agree, and they do.

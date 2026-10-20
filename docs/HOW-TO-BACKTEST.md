# How to backtest a strategy here

One harness, five rules, one win definition. If a number was not produced this way,
it is not comparable to anything else on this page — and in this repo it has usually
been produced by a script that counted every positive close as a win, which is how a
losing strategy reports a 70% win rate.

---

## 1. The command

```bash
# a REGISTERED engine (shipped: FVG, ORDERFLOW)
node backtest/runAll.js --symbols=100 --onePerDay=1 --engine=ORDERFLOW

# a CANDIDATE FILE that is not shipped — same rules, its own artifact
node backtest/runAll.js --symbols=100 --onePerDay=1 --module=<path/to/candidate.js> --key=<KEY>

# a window, a different corpus, every cost level
node backtest/runAll.js --symbols=100 --onePerDay=1 --days=60
node backtest/runAll.js --symbols=200 --onePerDay=1 --corpus=data/ohlcv_1m
node backtest/runAll.js --symbols=100 --costs=0,0.02,0.05,0.10
```

An unregistered module is wrapped in the same shape a registry entry has, measured
under every rule below, and written to `scratch/module_backtest_<KEY>.json`. It is
**not** added to `strategy-core/engines.js` by the run, and it can never overwrite
`data/terminal/backtest_results.json`, the artifact the board and these docs quote.

### A renamed copy is refused, and the run exits 2

`--module=` measures a strategy we do **not** run. Point it at a copy of one we do run
and it refuses, because a renamed copy is not a second strategy — it just gets its own
artifact and its own row for the same rule (that is how `strategies/codex.js` was
reported as progress):

```
$ node backtest/runAll.js --module=<copy-of-orderflow.js> --key=NEW
--module=<copy-of-orderflow.js> is NOT a new strategy: it is 97.0% identical to the
registered engine ORDERFLOW (strategies/orderFlow.js).
  Measure the engine that ships:  node backtest/runAll.js --engine=ORDERFLOW
$ echo $?
2
```

The check is `strategy-core/engineIdentity.js`: comments and whitespace are stripped,
the sources are compared as sets of 8-character shingles, and a Jaccard similarity of
**0.90 or more** with a registered engine is a copy. Renaming the file, the ids or the
header does not get around it. What it does NOT catch — deliberately — is an **older
version** of the same engine (the quarantined 2026-10-15 OF03 scores 0.57 against
today's), because that is a legitimate candidate and a different rule set.

## 2. The five rules (`backtest/runAll.js`, `backtest/follow.js`)

1. **No lookahead.** Each engine is driven by its incremental `createEngine()` and
   asked only about the bar it has just closed. Nothing may read a later bar — which
   is exactly what `scratch/test_older_gates.js` does when it computes the day's
   high/low over all 375 bars and then evaluates a 10:00 entry against it.
2. **The fill is the NEXT OPEN.** The signal freezes at the close of bar *i*; the
   entry is the open of bar *i+1*. Entry at the signal bar's own close is a price
   the strategy had not finished seeing.
3. **The plan is re-derived against the fill.** A gap can open past the stop; a fill
   that invalidates its own setup is rejected as `FILL_INVERTED`, and a stop is
   always exactly −1.00R.
4. **One tie policy: stop first.** If one bar holds both the stop and a target, the
   stop is taken. A harness that takes the target there is measuring luck.
5. **The hold ends at its own session close.** The corpus is one continuous array
   across sessions, so without this a 14:55 signal rides the overnight gap.

Plus the entry window (09:20–15:00 on the decision bar, minus the two measured
blocked windows) and **cost charged in R** on both legs, so a tight stop pays
proportionally more.

## 3. The win definition — the one that matters

```
win  = the TARGET was actually hit
loss = the STOP was actually hit
everything else = an exit, reported separately (T1/T2/stop/expired/sessionEnd/otherExits)
```

`net > 0`, `netBps >= 0`, `netInr > 0` and "verdict string contains WON" are **not**
wins. Each of them counts an end-of-day flatten, a break-even scratch and a
stop that closed slightly positive as winners, and that is the entire reason a
losing rule can advertise a 70% win rate. The headline rate is over **decided**
trials (target or stop) and is `null` when nothing decided.

Read in this order, always:

| read this | before this | because |
|---|---|---|
| trade count | win rate, PF, expectancy | 25 trades is not a sample |
| expectancy / PF **net of cost** | win rate | a high win rate with PF < 1 loses money |
| the outcome mix (T1/T2/stop/expired/sessionEnd) | the total | it says *how* the rule makes and loses |
| max drawdown in R | the total R | a rule that pays 13R through a 4R hole is not a rule |
| LONG and SHORT separately | the pooled row | two halves can average into a story neither one tells |

## 4. What "measured" then means

A rule may not speak (put a direction on the board) until it clears **netPF ≥ 1.5
AND ≥ 30 resolved trades**, and it must survive walk-forward. That gate lives in one
place: `measuredRules()` in `strategy-core/engines.js`, read by the board builder and
by `/api/terminal/strategies`.

## 5. Recording a result

1. Keep the artifact (`data/terminal/backtest_results.json` for a registered run,
   `scratch/module_backtest_<KEY>.json` for a candidate).
2. Quote the corpus with it: symbols, bars, sessions, cost, and the window.
3. If the engine file changed, it is a new version: bump the frozen copy
   (`strategies/frozen/`), the hash in `docs/ORDERFLOW-PHASE2.md`, and the
   `FROZEN` map in `backtest/phase5Preflight.js` — `test/researchGuard.test.js`
   fails otherwise, and that is the point.
4. A strategy measured on its own corpus (a 10-session geometry search, say) is not
   evidence for the live engine: the live path runs
   `strategies/orderflow/liveMinuteEngine.js` and `strategies/fvg/sweepFvgLive.js`,
   which are different files with their own gates.

## 6. Known traps in this repo

- `scratch/test_older_gates.js` — **has a lookahead** (full-day `hi`/`lo` used for the
  Fib gate). It still prints "64.1% win / +16.4 bps". The causal companion
  `scratch/test_older_gates_causal.js` prints 42.6% / −8.2 bps on the same sessions.
- Any harness whose win test is `net > 0`: `scratch/backtest_codex_strategy.js`,
  `scratch/backtest_codex_timeframes.js`, `scratch/fast_timeframe_backtest.js`.
  Their own output is proof: 56.5% "win" rate with PF **0.71** and −4.4 bps/trade.
- A geometry searched over the same 10 sessions it is reported on (the `PROFILES`
  block in `strategies/fvg/sweepFvgLive.js`): 65.0% / 69.2% / 71.1% win rates where
  ~89% of the money comes from one day and one stop in 40 trades.
- **A renamed copy presented as a new strategy.** `strategies/codex.js` (orderFlow.js
  with `OF03` renamed to `CODEX`, 97.0% identical) and `strategies/swing.js` (the same
  file verbatim, 100.0%) were removed to `data/quarantine_2026-10-17/` — see the README
  there. `test/strategyIdentity.test.js` now fails if such a file reappears in
  `strategies/`, if two registered engines are copies of each other, or if the
  similarity check itself stops discriminating. Their old harnesses
  (`scratch/backtest_codex_*.js`, `scratch/fast_timeframe_backtest.js`) were repointed
  at the quarantined path and carry a banner: their `net > 0` win rule is not a win
  rate, and their numbers must not be quoted.

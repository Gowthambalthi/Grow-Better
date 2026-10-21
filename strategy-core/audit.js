/**
 * strategy-core/audit.js — the plan, with nothing hidden.
 *
 * WHY THIS EXISTS: a plan is a claim about arithmetic. "Entry 253.00, stop
 * 251.97, T1 256.40, R:R 3.3" is easy to publish and impossible to check. This
 * module turns one signal into the full working:
 *
 *   INPUTS      every number the engine read, with where it came from
 *   GATES       every gate, its threshold, the value measured against it, verdict
 *   ARITHMETIC  the stop and the targets recomputed STEP BY STEP — buffer, raw
 *               distance, floor, cap, risk, R:R — with the actual numbers
 *   CROSS-CHECK the recomputation is compared against what the planner actually
 *               returned. If they disagree the audit says MISMATCH and names the
 *               field. A calculation that is wrong here is therefore WRONG
 *               LOUDLY rather than being a quieter second opinion.
 *   CODE        the source of the functions that produced the numbers, printed
 *               from the LIVE function objects (`fn.toString()`), so what is
 *               shown is what ran. A copy kept in a document drifts; a printed
 *               function cannot.
 *
 * The audit deliberately does NOT re-derive the engine's decision. It explains
 * the decision the engine made and proves the planner's arithmetic.
 */
'use strict';

const planner = require('./tradePlanner');
const fill = require('../backtest/follow');
// The engine list and each engine's file come from the ONE registry, so the
// audit cannot describe a different set of engines than the harness runs.
const { ENGINES: REGISTRY } = require('./engines');

const ENGINES = {};
for (const e of REGISTRY) ENGINES[e.key] = { mod: e.mod, file: e.file, setups: e.setups, maxHoldBars: e.maxHoldBars };

/**
 * LS01's volume floor is written inline in the engine rather than in DEFAULTS,
 * so it is restated here WITH that fact attached. The audit has to know the
 * number; it must not pretend the engine is configurable where it is not.
 * This is the ONE fact the audit holds about an engine that the engine module
 * does not export, so it is named as such rather than passed off as config.
 */
const VOLUME_FLOOR = Object.assign(
  Object.fromEntries(REGISTRY.map((e) => [e.key, { value: null, source: e.file + ' DEFAULTS.minVolRatio' }])),
  { LIQUIDITY: { value: 1.2, source: 'hard-coded in strategies/liquiditySweep.js (volRatio < 1.2)' } }
);

// ---------------------------------------------------------------------------
// CODE — printed from the live functions
// ---------------------------------------------------------------------------

function fn(name, f, file) {
  return { name, file, code: String(f).replace(/\r\n/g, '\n').trim() };
}

/**
 * Every function that can put a number on a plan, printed from the loaded
 * module. Grouped so the page can show the LOGIC for one engine without
 * dragging the other two along.
 */
/**
 * Which of an engine's own functions the page prints. This is the audit's EDIT
 * of the engine, not a second definition of it: every entry is looked up on the
 * live module, and a name the module does not export is dropped rather than
 * printed as missing.
 */
const FUNCTIONS_SHOWN = {
  LIQUIDITY: ['eligibleLevels', 'scanForSetup', 'targetsFor', 'pivotAt'],
  FVG: ['detectGap', 'retest', 'advance'],
  ORDERFLOW: ['absorption', 'breakout', 'exhaustion', 'locations'],
};

function codebook() {
  return {
    shared: [
      fn('tradePlanner.plan', planner.plan, 'strategy-core/tradePlanner.js'),
      fn('tradePlanner.pickStop', planner.pickStop, 'strategy-core/tradePlanner.js'),
      fn('tradePlanner.pickTargets', planner.pickTargets, 'strategy-core/tradePlanner.js'),
      fn('tradePlanner.extensionCheck', planner.extensionCheck, 'strategy-core/tradePlanner.js'),
    ],
    fill: [
      fn('follow', fill.follow, 'backtest/follow.js'),
      fn('invalidationOf', fill.invalidationOf, 'backtest/follow.js'),
      fn('inEntryWindow', fill.inEntryWindow, 'backtest/follow.js'),
      fn('minuteOfDay', fill.minuteOfDay, 'backtest/follow.js'),
    ],
    engines: Object.fromEntries(REGISTRY.map((e) => [e.key,
      (FUNCTIONS_SHOWN[e.key] || [])
        .filter((name) => typeof e.mod[name] === 'function')
        .map((name) => fn(name, e.mod[name], e.file)),
    ])),
    configs: Object.assign(
      { planner: planner.DEFAULTS },
      Object.fromEntries(REGISTRY.map((e) => [e.key, e.mod.DEFAULTS]))
    ),
  };
}

/** The frames each setup's logic reads — for the page's timeframe table. */
function timeframes() {
  return REGISTRY.map((e) => ({
    engine: e.key,
    name: e.mod.name,
    maxHoldBars: e.maxHoldBars,
    setups: e.setups.map((s) => ({
      setup: s.setup, label: s.label, frameMinutes: s.frameMinutes, frames: s.frames, needs: s.needs,
    })),
  }));
}

// ---------------------------------------------------------------------------
// ARITHMETIC — asked of the planner, then cross-checked against the engine
// ---------------------------------------------------------------------------
//
// THE AUDIT NO LONGER COMPUTES THE PLAN. It used to: `stopSteps()` and
// `targetSteps()` here re-derived the stop and the targets from the raw
// material, and `gateRows()` re-stated the six extension comparisons — three
// functions in this file that had to stay in step with `pickStop()`, `pick
// Targets()` and `extensionCheck()` in tradePlanner.js. Two implementations of
// one calculation is a bug waiting for a threshold to be tuned in one place; the
// audit was in fact already cross-checking its copy against the planner rather
// than against the ENGINE, which meant it could only ever catch the planner
// disagreeing with itself.
//
// The planner now returns its own working (`steps`, `considered`, `rows`), the
// audit prints that, and the cross-check compares the ENGINE's published numbers
// against the planner's recomputation — which is the check that can actually
// fail.

function inputs(signal) {
  const m = signal.market || {};
  const sd = signal.setupData || {};
  const rows = [
    { name: 'signal time', value: signal.signalTime, text: true },
    { name: 'bar index in the replayed series', value: signal.barIndex, text: true },
    { name: 'ltp / entry close', value: m.ltp },
    { name: 'ATR (14 bars)', value: m.atr },
    { name: 'ATR% of price', value: m.atrPct, suffix: '%' },
    { name: 'VWAP', value: m.vwap },
    { name: 'distance from VWAP', value: m.vwapDistPct, suffix: '%' },
    { name: 'POC (volume-at-price)', value: m.poc },
    { name: 'distance from POC', value: m.pocDistPct, suffix: '%' },
    { name: 'volume ratio vs 20-bar average', value: m.volumeRatio, suffix: '×' },
    { name: 'ROC 1m', value: m.roc1m, suffix: '%' },
    { name: 'ROC 3m', value: m.roc3m, suffix: '%' },
    { name: 'ROC 5m', value: m.roc5m, suffix: '%' },
    { name: 'day high', value: m.dayHigh },
    { name: 'day low', value: m.dayLow },
    { name: 'position in the day range', value: m.rangePosPct, suffix: '%' },
    { name: 'previous day high', value: m.prevDayHigh },
    { name: 'previous day low', value: m.prevDayLow },
  ];
  for (const [k, v] of Object.entries(sd)) {
    if (typeof v === 'object' && v !== null) continue;
    rows.push({ name: 'setup · ' + k, value: v, text: typeof v === 'string' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// THE AUDIT
// ---------------------------------------------------------------------------

/**
 * `planAudit(call, opts)` — call is one row from the board snapshot's `calls`
 * (or any signal object with side / entry / market / setupData / engine).
 */
function planAudit(call) {
  const engineKey = call.engine || 'LIQUIDITY';
  const meta = ENGINES[engineKey];
  const cfg = Object.assign({}, meta ? meta.mod.DEFAULTS : {}, {});
  const pCfg = Object.assign({}, planner.DEFAULTS, cfg.planner || {});

  const side = call.side === 'SHORT' ? 'SHORT' : 'LONG';
  const entry = call.entry != null ? call.entry : (call.market && call.market.ltp);
  const market = call.market || {};

  const out = {
    setupId: call.setupId || null,
    symbol: call.symbol,
    engine: engineKey,
    setup: call.setup,
    side,
    ok: !!call.ok,
    gate: call.gate || null,
    entry,
    inputs: inputs(call),
    extensionGate: (() => {
      // The gate's own rows, from the gate itself.
      const check = planner.extensionCheck(side, Object.assign({ cfg: pCfg }, market));
      return {
        thresholds: {
          maxMove3mPct: pCfg.maxMove3mPct, maxMove5mPct: pCfg.maxMove5mPct,
          maxVwapDistPct: pCfg.maxVwapDistPct, maxRangePosPct: pCfg.maxRangePosPct,
          minAtrPct: pCfg.minAtrPct, maxAtrPct: pCfg.maxAtrPct,
          requireMeasured: !!pCfg.requireMeasured, measuredFields: pCfg.measuredFields || [],
        },
        rows: check.rows,
        gate: check.gate || 'EXTENSION',
        verdict: check.ok ? 'pass' : 'FAIL',
      };
    })(),
    volumeGate: null,
    stop: null,
    targets: null,
    crossCheck: [],
    verdict: null,
    code: {
      plan: { name: 'tradePlanner.plan', file: 'strategy-core/tradePlanner.js' },
      engine: meta ? meta.file : null,
    },
  };

  // ---- volume gate, per engine ----
  const floor = VOLUME_FLOOR[engineKey] || { value: null, source: 'n/a' };
  const vFloor = floor.value != null ? floor.value : cfg.minVolRatio;
  out.volumeGate = {
    threshold: vFloor == null ? null : vFloor + '×',
    source: floor.source,
    measured: market.volumeRatio == null ? null : market.volumeRatio,
    verdict: market.volumeRatio == null ? 'unmeasured'
      : (vFloor == null || market.volumeRatio >= vFloor ? 'pass' : 'FAIL'),
  };

  const invalidation = fill.invalidationOf(call);
  out.invalidation = invalidation;

  if (entry == null || invalidation == null) {
    out.verdict = { ok: false, because: 'the plan has no entry or no invalidation to compute from' };
    return out;
  }

  // ---- ARITHMETIC: the planner's own working, printed ----
  const st = planner.pickStop(side, entry, invalidation, pCfg);
  st.riskPct = (st.risk / entry) * 100;
  out.stop = st;   // carries `rejected` when the structural stop is wider than maxStopPct

  const tg = planner.pickTargets(side, entry, call.targetCandidates || [], pCfg);
  out.targets = tg;

  const rr1 = tg.t1 == null ? null : Math.abs(tg.t1 - entry) / st.risk;
  const rr2 = tg.t2 == null ? null : Math.abs(tg.t2 - entry) / st.risk;
  out.rewardRisk = {
    rr1: rr1, rr2: rr2, minRR1: pCfg.minRR1,
    verdict: rr1 == null ? 'no target' : (rr1 >= pCfg.minRR1 ? 'pass' : 'FAIL'),
    why: rr1 == null ? 'no opposing structure to aim at'
      : (rr1 >= pCfg.minRR1 ? '' : 'nearest target pays only ' + rr1.toFixed(2) + 'R, need ' + pCfg.minRR1 + 'R'),
    steps: [
      { label: 'risk (from the stop working above)', value: st.risk },
      { label: 'R:R to T1 = |T1 − entry| ÷ risk', value: rr1 },
      { label: 'R:R to T2 = |T2 − entry| ÷ risk', value: rr2 },
    ],
  };

  // THE CROSS-CHECK: the ENGINE's published plan against a fresh planner pass.
  // This is the check worth having — the numbers the engine put on the board
  // came from ITS call to the planner at signal time, and the board's snapshot
  // carries only the raw material. If a threshold has been changed since, or the
  // call was assembled from the wrong fields, the two disagree HERE instead of
  // being reprinted as if they matched.
  const built = planner.plan({
    side, entry, invalidation,
    targets: call.targetCandidates || [],
    market, config: cfg.planner || {},
  });
  // NOTE: the null case is the trap. Both-null MEANS they agree (a plan with no
  // second structure has no T2 on either side), and the first version of this
  // line said the opposite — `(a === b)` is TRUE when both are null, so it
  // reported every plan without a T2 as a MISMATCH. Eight of them, all LS01.
  // The audit caught a bug in the audit; that is the point of cross-checking
  // rather than printing. One-null-versus-a-number is a real disagreement.
  const diff = (a, b) => (a == null || b == null)
    ? !(a == null && b == null)          // both null = agree; one null = disagree
    : Math.abs(a - b) > 1e-9;
  // A REFUSAL IS NOT A MISMATCH. When the planner refuses on the re-derivation
  // it has produced no plan, so there is nothing to compare. That AGREES with an
  // engine that refused; it is only a disagreement when the engine ACCEPTED and
  // the same arithmetic now refuses — the case where a threshold moved under a
  // published plan. Reporting both as "MISMATCH" is how a working refusal got
  // shown as an error.
  let reDerivedRefusal = null;
  if (!built.ok) {
    reDerivedRefusal = (built.reject || []).join('; ') + ' (gate ' + built.gate + ')';
    out.crossCheck.push({
      field: 'the plan itself', verdict: call.ok ? 'MISMATCH' : 'both-refused',
      published: call.ok ? 'the engine accepted this plan' : 'the engine refused it',
      recomputed: 'refused: ' + reDerivedRefusal,
      detail: reDerivedRefusal,
    });
  } else {
    const p = built.plan;
    // `published` is what the engine actually put on the call; `recomputed` is
    // the planner's answer now. A published null on a refused gate is not a
    // mismatch, it is the absence of a plan, so those pairs are skipped.
    const pairs = [
      ['stop', call.stop, p.stop],
      ['T1', call.t1, p.t1],
      ['T2', call.t2, p.t2],
      ['R:R to T1', call.rr1, p.rr1],
      ['risk %', call.riskPct, p.riskPct],
    ];
    for (const [field, published, recomputed] of pairs) {
      if (published == null) continue;
      out.crossCheck.push({
        field, published, recomputed,
        verdict: diff(published, recomputed) ? 'MISMATCH' : 'agrees',
      });
    }
  }

  // ---- VERDICT: why this plan did or did not become a call ----
  // EVERY FAILED GATE, NOT JUST THE FIRST. The planner short-circuits — the
  // engine stops at the first refusal it meets, which is correct for deciding a
  // trade but wrong for explaining one: a setup that fails BOTH the ATR floor and
  // the R:R gate was shown as an ATR refusal only, and the reader could not tell
  // whether fixing ATR would have saved it. The audit evaluates each gate on its
  // own working (which it has already computed above) and lists ALL of them, so
  // a two-gate refusal reads as two gates.
  const failed = out.extensionGate.rows.filter((r) => r.verdict === 'FAIL').map((r) => r.name);
  const mismatched = out.crossCheck.filter((c) => c.verdict === 'MISMATCH').map((c) => c.field);
  const failedGates = [];
  for (const r of out.extensionGate.rows) {
    if (r.verdict !== 'FAIL') continue;
    const isMissing = String(r.why || '').indexOf('DATA_MISSING') >= 0;
    failedGates.push({ gate: isMissing ? 'DATA_MISSING' : 'EXTENSION', check: r.name, detail: r.why || '' });
  }
  if (out.volumeGate && out.volumeGate.verdict === 'FAIL') {
    failedGates.push({ gate: 'VOLUME', check: 'volume ratio', detail: 'below the engine floor of ' + out.volumeGate.threshold });
  }
  if (out.stop && out.stop.rejected) {
    failedGates.push({ gate: out.stop.rejected, check: 'structural stop', detail: out.stop.basis });
  }
  if (!out.targets || out.targets.t1 == null) {
    failedGates.push({ gate: 'TARGET', check: 'opposing structure on the right side of entry', detail: 'no target could be drawn' });
  }
  if (out.rewardRisk && out.rewardRisk.verdict === 'FAIL') {
    failedGates.push({ gate: 'RR', check: 'R:R to T1', detail: out.rewardRisk.why });
  }
  out.failedGates = failedGates;
  out.verdict = {
    ok: !!call.ok && failedGates.length === 0 && mismatched.length === 0,
    engineAccepted: !!call.ok,
    reDerivedRefusal,
    stoppedBy: failed.length ? failed : (call.ok ? [] : [call.gate || 'engine rules']),
    failedGates,
    mismatches: mismatched,
    statement: mismatched.length
      ? 'ARITHMETIC MISMATCH — the plan published by the engine does not survive the same arithmetic now: '
        + mismatched.join(', ') + '. Do not trade this plan until that is resolved.'
      : (!call.ok && reDerivedRefusal
        ? 'Engine and recomputation AGREE that this plan should not be taken (refused: ' + reDerivedRefusal
          + '). The working above is still complete, so the refusal can be checked rather than trusted.'
        : (call.ok
          ? 'The engine accepted it, every gate passes on the recomputation, and the recomputed stop, targets and R:R match what the engine published.'
          : 'The engine refused it at gate ' + (call.gate || 'unknown') + '. The working above is still complete, so the refusal can be checked rather than trusted.')),
    // THE ONE-LINE ANSWER: every gate that is failing on the working above, in
    // the order the planner would have met them. Empty means the plan is clean.
    summary: failedGates.length
      ? 'REJECT — ' + failedGates.length + ' gate(s) failing: ' + failedGates.map((f) => f.gate + (f.check ? ' (' + f.check + ')' : '')).join(', ')
      : 'no gate is failing on the recomputation',
  };
  return out;
}

/**
 * HOW THE BACKTEST WAS RUN — printed, not described. The five rules and the
 * entry window are the prose headline; `code` is the live `follow()` and
 * `inEntryWindow()` beside them, so the rules and the implementation can be read
 * against each other.
 */
function backtestMethod(results, codebookObj) {
  const cb = codebookObj || codebook();
  const at = (key, cost) => {
    const e = results && results.engines ? results.engines[key] : null;
    return e && e.byCost ? e.byCost[cost] : null;
  };
  return {
    generatedAt: results ? results.generatedAt : null,
    corpus: results ? results.corpus : null,
    costs: results ? results.costs : null,
    onePerDay: results ? results.onePerDay : null,
    rules: [
      { n: 1, title: 'No look-ahead', body: 'Each engine is driven by its incremental createEngine() and asked only about the bar it has just closed. It cannot read forward, because it is handed an index, not an array it could run off the end of.' },
      { n: 2, title: 'The fill is the next open', body: 'The signal freezes at the close of bar i. The entry is bars[i+1].OPEN — the next price that could actually have been traded. Using bar i\'s own close would use a price the strategy had not finished seeing.' },
      { n: 3, title: 'The plan is re-derived against the fill', body: 'A gap can open past the stop the engine computed from the previous close. The plan is rebuilt from the ACTUAL fill, a fill that inverts its own setup is REJECTED as FILL_INVERTED, and a STOP is ALWAYS exactly −1.00R — never inferred from the sign of an arithmetic result.' },
      { n: 4, title: 'One tie policy, stated', body: 'If one bar\'s range holds both the stop and a target, the STOP filled first. Pessimistic, and applied to all three engines alike.' },
      { n: 5, title: 'The hold is intraday', body: 'The corpus is ONE CONTINUOUS ARRAY across sessions. Without this rule a 14:55 signal walks through the overnight gap into the next day\'s bars and books that gap as if the position had been held overnight. The hold therefore ends at the close of the ENTRY BAR\'S OWN session and is marked flat there (exitReason SESSION_END), whatever maxHoldBars says.' },
    ],
    // THE ENTRY WINDOW is printed as the live predicate plus the bounds it reads,
    // so the page shows the comparison rather than a sentence describing one.
    entryWindow: {
      label: fill.ENTRY_WINDOW_LABEL,
      fromMinute: fill.ENTRY_WINDOW.fromMinute,
      toMinute: fill.ENTRY_WINDOW.toMinute,
      checkedOn: 'decision bar',
      body: 'An engine may only ENTER on a decision bar stamped inside ' + fill.ENTRY_WINDOW_LABEL +
        '. A bar at or before 09:20 is the opening range still forming; a bar after 15:00 has no session left to resolve in. Bars in 15:00-15:30 may still RESOLVE a hold entered inside the window, and a hold that is still open at the session close is marked flat (SESSION_END).' +
        // The BLOCKED WINDOWS are part of this rule, not a separate one — a bar
        // inside them is inside the window and is still refused. Named from the
        // shared constants, so this sentence cannot drift from the predicate
        // printed right below it (the body used to describe only the window).
        (fill.BLOCKED_WINDOWS && fill.BLOCKED_WINDOWS.length
          ? ' INSIDE the window, ' + fill.BLOCKED_WINDOWS_LABEL + ' are additionally BLOCKED: the recorded corpus is net-negative there in both one-per-day modes and both split halves at the 0.05% cost (' +
            'scratch/time_buckets_2026-10-16.md). Every other minute of the window is open.'
          : ''),
      blockedWindows: fill.BLOCKED_WINDOWS,
      blockedLabel: fill.BLOCKED_WINDOWS_LABEL,
      code: fn('inEntryWindow', fill.inEntryWindow, 'backtest/follow.js').code,
    },
    costs: results ? results.costs : null,
    measured: REGISTRY.map((e) => ({
      engine: e.key,
      at05: at(e.key, '0.05'),
      at00: at(e.key, '0.00'),
      at10: at(e.key, '0.10'),
    })),
    code: cb.fill,
  };
}

module.exports = { codebook, planAudit, backtestMethod, timeframes, ENGINES };

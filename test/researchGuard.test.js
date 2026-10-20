'use strict';

/**
 * The two invariants of the frozen ORDERFLOW research state
 * (docs/ORDERFLOW-PHASE2.md), asserted so they cannot erode silently:
 *
 *  1. The sub-minute tape layer is MEASUREMENT ONLY. It measures whether a
 *     trigger looks precise; it must never reach the detector, the planner or the
 *     board. The four-session test did not even replicate session-to-session, so
 *     letting it influence a BUY/SHORT would be fitting a decision to a sample
 *     that failed its own consistency check.
 *
 *  2. The speaking gate needs BOTH conditions. The 22-trade PF 1.509 result
 *     cleared 1.5 and would have spoken if the trade-count floor were not
 *     enforced — the floor is the only thing that kept it silent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Every file that can turn code into a signal or a plan.
const DECISION_PATHS = [
  'strategies/orderFlow.js',
  'strategies/codex.js',
  'strategies/swing.js',
  'strategy-core/tradePlanner.js',
  'strategy-core/market.js',
  'strategy-core/engines.js',
  'strategy-core/audit.js',
  'backtest/follow.js',
  'scripts/buildBoard.js',
].filter((p) => fs.existsSync(path.join(ROOT, p)));

// Tokens belonging to the micro layer (backtest/eventMicro.js), its records,
// and the Phase 4 trigger-P&L harness (backtest/phase4TriggerPnl.js). All of it
// is research measurement; none of it may be required by a decision path.
const MICRO_TOKENS = [
  'eventMicro', 'of_event_records', 'of_event_micro', 'phase4TriggerPnl',
  'effortFlag', 'changeFlag', 'deltaAccel', 'deltaRatio',
  'reversed30', 'reversed60', 'responseTravel',
];

test('the sub-minute tape layer never reaches a decision path', () => {
  for (const file of DECISION_PATHS) {
    const src = read(file);
    for (const tok of MICRO_TOKENS) {
      assert.ok(!src.includes(tok),
        `${file} references "${tok}" — micro data is research measurement only and must not read a decision`);
    }
  }
});

test('the frozen research version is pinned in the Phase 2 doc and copied verbatim', () => {
  const doc = read('docs/ORDERFLOW-PHASE2.md');
  const frozen = read('strategies/frozen/orderFlow.of03v1.js');
  const live = read('strategies/orderFlow.js');
  assert.equal(frozen, live,
    'the frozen copy must match the engine it describes — bump the hash in the doc if the engine changes');
  const m = /`strategies\/orderFlow\.js` \| `([0-9a-f]{16})`/.exec(doc);
  assert.ok(m, 'the doc must record a sha256 prefix for the engine');
  const { createHash } = require('crypto');
  const actual = createHash('sha256').update(live).digest('hex').slice(0, 16);
  assert.equal(m[1], actual,
    'the recorded hash must match the file — the whole point is that "what did we measure" is answerable');
});

test('a rule needs BOTH netPF >= 1.5 and a real sample before it may speak', () => {
  // THE RULE MOVED, THE INVARIANT DID NOT. The arithmetic now lives in the engine
  // registry (measuredRules) because the SERVER also serves it: the board snapshot
  // is only written when a scan runs, so after a retighten-and-re-measure the
  // page kept publishing the old configuration's netPF from a stale file. One
  // implementation, both readers — and the guard follows it rather than pinning
  // a line number in a script that no longer owns the decision.
  const registry = read('strategy-core/engines.js');
  assert.match(registry, /const MIN_TRADES_FOR_SAMPLE = 30/, 'the trade-count floor must exist');
  assert.match(registry, /const MIN_NET_PF = 1\.5/, 'the profit-factor floor must exist');
  assert.match(registry, /speak:\s*netPF != null && netPF >= MIN_NET_PF && trades >= MIN_TRADES_FOR_SAMPLE/,
    'clearing 1.5 alone must not put a direction on the board');
  assert.match(read('scripts/buildBoard.js'), /measuredRules\(backtest\)/,
    'the board must take its rule from the ONE implementation, not its own copy');
});

test('tick capture is explicit opt-in — an ordinary restart never records', () => {
  const env = require('../config/env');
  const saved = process.env.GB_TICK_CAPTURE;
  try {
    delete process.env.GB_TICK_CAPTURE;
    assert.equal(env.research.tickCapture(), false, 'unset must mean off');
    process.env.GB_TICK_CAPTURE = '0';
    assert.equal(env.research.tickCapture(), false, '0 means off');
    process.env.GB_TICK_CAPTURE = 'yes';
    assert.equal(env.research.tickCapture(), false, 'anything but 1 means off');
    process.env.GB_TICK_CAPTURE = '1';
    assert.equal(env.research.tickCapture(), true, 'only the literal 1 arms it');
  } finally {
    if (saved === undefined) delete process.env.GB_TICK_CAPTURE;
    else process.env.GB_TICK_CAPTURE = saved;
  }
});

test('OF01 and OF02 are REMOVED from the engine and the registry, not merely disabled', () => {
  // THIS REPLACES the older "OF02 stays disabled" guard, and it is a TIGHTENING,
  // not a relaxation. OF02 used to be kept-but-disabled because its measured
  // netPF was the reason it could not speak; on 2026-10-15 both it and OF01 were
  // removed outright (numbers in strategies/orderFlow.js's header), so the
  // invariant flipped: they must not exist at all. The guard stays in the file
  // because a re-introduced OF02 is exactly the change this test exists to
  // catch, and an absent assertion would have caught nothing.
  const of = require('../strategies/orderFlow');
  assert.equal(of.DEFAULTS.enableOF02, undefined, 'OF02 was removed — no enable flag may remain');
  assert.equal(of.families.find((f) => f.setup === 'OF02'), undefined, 'OF02 must not be registered');
  assert.equal(of.families.find((f) => f.setup === 'OF01'), undefined, 'OF01 must not be registered');
  assert.deepEqual(of.families.map((f) => f.setup), ['OF03'], 'OF03 is the only setup left in this engine');
  // The registry is asserted at source level: its catalogue() output shape has
  // changed more than once, and the invariant is "the removed setups are absent",
  // not how that object happens to nest.
  const registry = read('strategy-core/engines.js');
  assert.ok(!/setup: 'OF01'/.test(registry), 'OF01 must not be registered in the engine registry');
  assert.ok(!/setup: 'OF02'/.test(registry), 'OF02 must not be registered in the engine registry');
  assert.match(registry, /setup: 'OF03'/, 'OF03 must remain registered');
});

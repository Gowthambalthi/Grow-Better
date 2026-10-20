'use strict';

/**
 * The invariants of the LIVE F1 evaluator (SPEC 8.27), asserted so they cannot erode silently.
 *
 * F1 is the first research mechanism wired into the running server, so its blast radius is larger
 * than the offline harness it came from. Three things must stay true:
 *
 *  1. IT IS OPT-IN, AND ONLY FOR THE LITERAL '1'. A research evaluator that switches itself on
 *     during an ordinary restart is not passive — it would begin journalling signals nobody asked
 *     for, and widen the capture subscription to the 8.27 universe, on that boot. Unset, '0',
 *     'true', 'yes' all mean OFF. This mirrors test/researchGuard.test.js for tick capture.
 *
 *  2. IT CANNOT REACH A DECISION. orderflow/f1Live.js journals and scores; it must never be
 *     required by a strategy, a planner gate or a board builder, and it must not import the broker
 *     or any order endpoint. If F1 ever becomes a trading path that is a separate, explicit
 *     decision — not a quiet require().
 *
 *  3. A REPLAYED SESSION CANNOT MASQUERADE AS A CAPTURED ONE. The live path writes
 *     data/orderflow/f1-live-<day>.jsonl and any number read off those files is understood to be
 *     LIVE. A backtest that wrote into the same namespace would make that inference false, so the
 *     replay tools are asserted to use their own directory and their own filename.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Token checks must look at CODE, not prose. f1Live.js explains in its header that it "touches no
// broker order endpoint", and that sentence must not be what fails the firewall assertion.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// Every file that can turn code into a signal or a plan.
const DECISION_PATHS = [
  'strategies/orderFlow.js',
  'strategy-core/tradePlanner.js',
  'strategy-core/market.js',
  'strategy-core/engines.js',
  'strategy-core/audit.js',
  'backtest/follow.js',
  'scripts/buildBoard.js',
].filter((p) => fs.existsSync(path.join(ROOT, p)));

test('F1 live is OFF unless GB_F1_LIVE is the literal "1"', () => {
  const saved = process.env.GB_F1_LIVE;
  const fresh = () => {
    delete require.cache[require.resolve('../config/env')];
    return require('../config/env').research.f1Live();
  };
  try {
    delete process.env.GB_F1_LIVE;
    assert.equal(fresh(), false, 'unset must mean off');
    for (const v of ['0', 'true', 'TRUE', 'yes', 'on', '']) {
      process.env.GB_F1_LIVE = v;
      assert.equal(fresh(), v === '1', `GB_F1_LIVE=${JSON.stringify(v)} must be off`);
    }
    process.env.GB_F1_LIVE = '1';
    assert.equal(fresh(), true, 'only the literal 1 arms it');
  } finally {
    if (saved === undefined) delete process.env.GB_F1_LIVE;
    else process.env.GB_F1_LIVE = saved;
    delete require.cache[require.resolve('../config/env')];
  }
});

test('the live F1 evaluator never reaches a decision path', () => {
  for (const file of DECISION_PATHS) {
    const src = read(file);
    for (const tok of ['f1Live', 'f1-live', 'flow_scalper', 'F1_']) {
      assert.ok(!src.includes(tok),
        `${file} references "${tok}" — the live F1 evaluator is research measurement only and must not read a decision`);
    }
  }
});

test('the live F1 evaluator cannot place an order', () => {
  const code = stripComments(read('strategies/orderflow/f1Live.js'));
  for (const tok of ['placeOrder', 'place_order', 'modifyOrder', 'cancelOrder',
    'https://', 'angelone/auth', 'orderService', 'smartapi', 'SmartApi', 'axios']) {
    assert.ok(!code.includes(tok),
      `strategies/orderflow/f1Live.js references "${tok}" — it must stay read-only (it journals and scores only)`);
  }
  // It also must not require anything broker-shaped. This is the assertion that actually bites:
  // an execution path starts with an import.
  const requires = [...code.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  for (const r of requires) {
    assert.ok(!/angelone|broker|order|aws|http/i.test(r),
      `strategies/orderflow/f1Live.js requires "${r}" — a broker import would make it an execution path`);
  }
});

test('the per-pattern table is attributed the research way, not by raw pattern set', () => {
  const code = stripComments(read('strategies/orderflow/f1Live.js'));
  // The two pattern sets are different sets. flow_scalper records `sorted(pats & BULLISH)` /
  // `& BEARISH` - only the patterns that can justify the trade's direction. Reporting the RAW set
  // instead produced byPattern rows for `doji` / `inside_bar` / `outside_bar` that research never
  // has, and double-counted every trade across context patterns. Signals and P&L agreed to the
  // digit while the two tables described different things, so this is asserted structurally.
  assert.ok(code.includes('patternsArming:'),
    'a signal must carry the directional subset research records');
  assert.ok(/for \(const p of sig\.patternsArming\)/.test(code),
    'performance() must build byPattern from patternsArming, not the raw pattern set');
  assert.ok(!/for \(const p of sig\.patterns\)/.test(code),
    'the raw pattern set must not drive byPattern - it contains NEUTRAL patterns research excludes');
  // And the neutral names must not be in either arming family.
  const neutral = ['doji', 'inside_bar', 'outside_bar'];
  for (const n of neutral) {
    assert.ok(!new RegExp("BULLISH = new Set\\(\\[[^\\]]*'" + n + "'").test(code),
      `"${n}" is NEUTRAL and must not be in the BULLISH arming family`);
    assert.ok(!new RegExp("BEARISH = new Set\\(\\[[^\\]]*'" + n + "'").test(code),
      `"${n}" is NEUTRAL and must not be in the BEARISH arming family`);
  }
});

test('the server feeds its live strategy through the row hook, never the raw socket event', () => {
  const code = stripComments(read('Server.js'));

  // REWRITTEN 2026-10-12. This used to require `onRow: f1 ? f1.safeTick : undefined` because F1 was the
  // live evaluator. F1's live wiring was then deliberately canceled - sweep+FVG is the only engine, and
  // Server.js says so at startup ("All other logics canceled") - so requiring f1 to appear here would
  // assert an architecture that no longer exists. If F1 live is ever switched back on, its row hook
  // belongs back in this assertion.
  assert.ok(/onRow:/.test(code),
    'Server.js must hand its live consumer to arm() as `onRow`: the socket payload has no `s`/`p`/`q`');

  // The hazard that survives the rewiring: attaching an EVALUATOR to the raw socket payload. Comments
  // must not count - Server.js explains this hazard in prose, and the explanation must not be what
  // fails the assertion.
  assert.ok(!code.includes('safeTick'),
    "Server.js must not attach the f1 evaluator to the raw socket event — that is a silent no-op");
  // TWO forms, because the first version of this check only caught a CALL and therefore passed the far
  // more likely shape - handing over the method as a reference, `angel.on('tick', f1.safeTick)`, with no
  // parentheses anywhere. A checker that cannot fail is not a checker, so both are asserted and both
  // were fed their own counter-example before being trusted.
  const passesEvaluatorReference = /angel\.on\(\s*['"]tick['"]\s*,\s*[^,)]*\b\w+\.(onTick|safeTick)\b/;
  const passesEvaluatorCall = /\.on\(\s*['"]tick['"]\s*,[\s\S]{0,240}?\.(onTick|safeTick)\s*\(/.test(code);
  assert.ok(!passesEvaluatorReference.test(code),
    "a raw-socket `tick` handler must not be handed an evaluator (its payload has no s/p/q)");
  assert.ok(!passesEvaluatorCall,
    'a raw-socket `tick` handler must not call into a strategy evaluator');

  assert.ok(read('strategies/orderflow/armCapture.js').includes('onRow'),
    'armCapture must accept onRow so a consumer gets the ROW record() returned');
  assert.ok(read('strategies/orderflow/tickCapture.js').includes('row.s = meta.get(token)'),
    'the returned row must carry `s`, or a live consumer resolves no symbol and drops every tick');
});

test('a replayed session cannot masquerade as a captured one', () => {
  // The rule, asserted on CODE rather than prose. f1LiveScoreboard.js documents this very rule in a
  // comment that names f1-live-, and the comment must not be what fails the assertion - the same trap
  // the raw-socket test above already guards against.
  const REPLAY_TOOLS = ['strategies/orderflow/f1LiveScoreboard.js', 'strategies/orderflow/f1ReplayCheck.js',
    'strategies/orderflow/f1ParityVerify.js', 'strategies/orderflow/f1Trace.js'];
  for (const file of REPLAY_TOOLS) {
    const code = stripComments(read(file));
    assert.ok(!code.includes('f1-live-'),
      `${file} writes into the live f1-live namespace — a replayed session would then look captured`);
  }

  // Nothing inside orderflow/ may claim the live namespace either: the path is the CALLER's decision,
  // which is what keeps a replay tool from ever passing it one by default.
  for (const entry of fs.readdirSync(path.join(ROOT, 'strategies/orderflow'))) {
    if (!entry.endsWith('.js')) continue;
    const code = stripComments(read('strategies/orderflow/' + entry));
    assert.ok(!code.includes('f1-live-'),
      `orderflow/${entry} claims the live f1-live namespace — only the server may write it`);
  }

  // And a journal-writing tool must name its journal for what it is.
  for (const file of ['strategies/orderflow/f1LiveScoreboard.js', 'strategies/orderflow/f1Trace.js']) {
    const code = stripComments(read(file));
    assert.ok(/f1-(replay|signals|trace)-/.test(code),
      `${file} must name its journal for what it is (f1-replay- / f1-signals- / f1-trace-), not f1-live-`);
  }
});

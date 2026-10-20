'use strict';

/**
 * GB04 — PREVIOUS-DAY HIGH/LOW AS SUPPORT AND RESISTANCE.
 *
 * The engine used to fire 1,835 signals and lose money on both sides. Three causes, all silent:
 *
 *   1. THE STOP WAS THE BAR'S WICK (`invalidation = bar.low`). A reclaim bar has a long wick
 *      through the level by construction, so risk was set by the spike, not by the idea.
 *   2. THE TARGET WAS THE NEAREST STRUCTURE, so half the signals (901 of 1,835) died at the
 *      fill as REFILL_RR.
 *   3. Both sides were carried together, hiding that the support bounce was PF 0.60 while the
 *      resistance rejection was 1.27.
 *
 * Each is pinned below, because every one of them reads as "the strategy just doesn't fire much".
 */

const test = require('node:test');
const assert = require('node:assert');

const gb04 = require('../strategies/gb04');

/** Day 1 ranges 99–101; day 2 dips under 99 and closes back above it. */
function twoDays() {
  const out = [];
  for (let i = 0; i < 60; i++) {
    const c = 100 + Math.sin(i / 6) * 0.5;
    out.push(['2026-09-01 09:' + String(i).padStart(2, '0'), c, 101, 99, c, 10000]);
  }
  for (let i = 0; i < 30; i++) {
    const c = 99.9 + i * 0.01;
    out.push(['2026-09-02 09:' + String(i).padStart(2, '0'), c - 0.03, c + 0.15, 98.8, c, 15000]);
  }
  return out;
}

function walk(cfg) {
  const eng = gb04.createEngine(cfg || {});
  const bars = twoDays();
  const ok = [], refused = [];
  for (let i = 0; i < bars.length; i++) {
    const s = eng.onBar(bars, i);
    if (!s) continue;
    (s.ok ? ok : refused).push(s);
  }
  return { ok, refused, eng };
}

test('a reclaim of the previous day low produces a plannable LONG', () => {
  const { ok } = walk();
  assert.ok(ok.length >= 1, 'the reclaim must produce at least one accepted plan');
  assert.ok(ok.every((s) => s.setup === 'RL' && s.side === 'LONG'));
});

test('the stop sits at the LEVEL plus a buffer, not at the bar wick', () => {
  const { ok } = walk();
  for (const s of ok) {
    const { level, atr, bufferAtr } = s.setupData;
    const expected = level - atr * bufferAtr;
    // The ENGINE's invalidation is the level minus the buffer. The planner then places the stop
    // just beyond that invalidation (its own stopBufferPct), so the plan's stop is at or below it
    // — never at the 98.8 wick, which is what the old `invalidation = bar.low` produced.
    assert.ok(Math.abs(s.invalidationForFill - expected) < 1e-6,
      'invalidation ' + s.invalidationForFill.toFixed(3) + ' should be the level minus the buffer ' +
      expected.toFixed(3));
    assert.ok(s.plan.stop <= s.invalidationForFill + 1e-9,
      'the plan stop must not be pulled back inside its own invalidation');
  }
});

test('targetCandidates are NUMBERS and the target clears the R multiple', () => {
  const { ok } = walk();
  for (const s of ok) {
    assert.ok(Array.isArray(s.targetCandidates) && s.targetCandidates.length >= 1);
    for (const c of s.targetCandidates) assert.equal(typeof c, 'number', 'follow() re-plans from this');
    const risk = Math.abs(s.entry - s.plan.stop);
    const reward = Math.abs(s.plan.t1 - s.entry);
    assert.ok(reward / risk >= 1.2, 'RR ' + (reward / risk).toFixed(2) + ' is under the planner floor');
  }
});

test('sides can be switched off independently', () => {
  const long = walk({ sides: 'long' });
  assert.ok(long.ok.length >= 1, 'long side still fires');
  assert.ok(long.ok.every((s) => s.side === 'LONG'));

  const short = walk({ sides: 'short' });
  assert.equal(short.ok.length, 0, 'a long reclaim must not be taken when only shorts are allowed');
});

test('a refusal is reported with its gate, not dropped', () => {
  // A stop 5 ATR beyond the level cannot fit inside the planner's 1.5% ceiling, so every signal
  // must come back REFUSED by name. A far TARGET does not work for this: pickTargets() accepts
  // any target that pays the RR floor, so a large targetR still yields an acceptable plan.
  const { refused } = walk({ stopBufferAtr: 5 });
  assert.ok(refused.length >= 1, 'the engine must surface refusals instead of dropping them');
  assert.ok(refused.every((s) => s.ok === false && typeof s.gate === 'string'));
  assert.ok(refused.some((s) => s.gate === 'STOP_TOO_WIDE'),
    'the gate must name the reason, got ' + JSON.stringify([...new Set(refused.map((s) => s.gate))]));
});

test('the engine never throws before it has a previous day', () => {
  const eng = gb04.createEngine({});
  const one = [['2026-09-01 09:15', 100, 100.2, 99.8, 100, 1000]];
  assert.doesNotThrow(() => eng.onBar(one, 0));
});

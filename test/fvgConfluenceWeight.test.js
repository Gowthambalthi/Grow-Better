'use strict';

/**
 * THE FVG COUNTS AS ONE OF TWO POINTS A TRADE NEEDS — SHOULD IT?
 *
 * exchange.md Round 24 isolated the gap with everything else held constant:
 *
 *   PAST 5, 50/1.5R:  FVG_CE -5.1  | FVG_OTHER -9.5 | NO_FVG -2.5 bps
 *   PAST 5, 60/2R:    FVG_CE -4.2  | FVG_OTHER -0.1 | NO_FVG +3.8 bps
 *   FVG_CE minus NO_FVG: -2.6 bps [-66.9 .. +61.1] at 1.5R, -8.0 [-83.7 .. +70.1] at 2R
 *
 * Every interval straddles zero and 3 of 4 panels run AGAINST the gap, so a live
 * FVG is not a discriminator on our own tape. It is nonetheless worth a full
 * confluence point, which means this pair is a qualified trade under today's rules:
 *
 *   LIVE GAP + VOLUME SURGE, no sweep, flat delta  ->  confluence 2  ->  ENTERS
 *
 * Neither of those two points has been measured to carry edge, and the largest
 * positive cohort in the whole project (NO_FVG, +3.8 bps, n=123) has no gap at all.
 *
 * These tests do NOT change what the engine trades. They pin three things:
 *   1. the shipped default is 1 (the gap still counts) — flipping it is a deliberate
 *      act, taken only after the Round 24 (C) forward test, not a silent drift;
 *   2. the weight is per-instance, so a study can demote the gap at runtime;
 *   3. demotion is MONOTONE — it can only remove points, never add them, and it never
 *      moves the threshold (>= 2, or >= 3 when Nifty is bearish).
 *
 * The scan calls the SAME `confluenceCount` this file exercises (exposed on the
 * exported instance for exactly that reason), so a passing test cannot describe
 * arithmetic the engine does not apply.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads: its constructor reads today's call files.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fvg-conf-'));
process.env.GB_ORDERFLOW_DIR = TMP;
delete process.env.GB_FVG_CONFLUENCE_WEIGHT; // test the shipped default

const engine = require('../orderflow/liveMinuteEngine');

/** Convenience: a confluence count with every input at its neutral (absent) value. */
function count(dir, over, weight) {
  return engine.confluenceCount(dir,
    Object.assign({ hasFvg: false, swept: false, volSurge: 1, deltaRatio: 0 }, over),
    weight);
}

test('the SHIPPED default still counts the FVG (weight 1, behaviour unchanged)', () => {
  assert.equal(engine.fvgConfluenceWeightDefault, 1,
    'demoting the gap must be an explicit act, not a silent change to what trades');
  assert.equal(engine.fvgConfluenceWeight, 1);
});

test('under the shipped default, gap + volume surge alone reaches the threshold', () => {
  // This is the case Round 24 objects to: two unmeasured points open a trade.
  assert.equal(count(+1, { hasFvg: true, volSurge: 1.4 }, 1), 2,
    'gap + volume surge is a 2-point long today');
});

test('demoting the gap drops that same setup below the threshold', () => {
  assert.equal(count(+1, { hasFvg: true, volSurge: 1.4 }, 0), 1,
    'with the gap demoted, gap + volume surge must NOT qualify');
});

test('demotion removes ONLY the gap — every other point still counts', () => {
  // sweep + volume surge = 2 real points, still a qualified long without any gap.
  assert.equal(count(+1, { swept: true, volSurge: 1.4 }, 0), 2);
  // strong delta + sweep = 2 real points.
  assert.equal(count(+1, { swept: true, deltaRatio: 0.20 }, 0), 2);
  assert.equal(count(-1, { swept: true, deltaRatio: -0.20 }, 0), 2);
  // and a lone gap is one point at either weight — never enough on its own.
  assert.equal(count(+1, { hasFvg: true }, 0), 0);
  assert.equal(count(+1, { hasFvg: true }, 1), 1);
});

test('the delta point follows the direction, at the live +/-15% boundaries', () => {
  assert.equal(count(+1, { deltaRatio: 0.16 }, 1), 1, 'a long needs delta > +0.15');
  assert.equal(count(+1, { deltaRatio: 0.15 }, 1), 0, 'exactly +0.15 does not count');
  assert.equal(count(-1, { deltaRatio: -0.16 }, 1), 1, 'a short needs delta < -0.15');
  assert.equal(count(-1, { deltaRatio: -0.15 }, 1), 0);
  assert.equal(count(-1, { deltaRatio: 0.16 }, 1), 0, 'a positive delta is no short point');
});

test('demotion can only make the Nifty-bearish gate (>= 3) stricter', () => {
  // gap + sweep + volume surge = 3, and the stricter bearish gate is met today.
  assert.equal(count(+1, { hasFvg: true, swept: true, volSurge: 1.4 }, 1), 3);
  // demoted, the same setup carries 2 real points and must fail the >= 3 gate.
  assert.equal(count(+1, { hasFvg: true, swept: true, volSurge: 1.4 }, 0), 2);
  // sweep + volume surge + strong delta still clears it with no gap at all.
  assert.equal(count(+1, { swept: true, volSurge: 1.4, deltaRatio: 0.20 }, 0), 3);
});

test('at weight 1 the new arithmetic is EXACTLY the expression it replaced', () => {
  // The confluence count used to be written out inline in both scan branches. It is now a
  // single function, so the honest question is whether that refactor changed what the engine
  // trades. It must not: this evaluates the ORIGINAL expression verbatim and requires the
  // new one to agree on all 16 input combinations for each direction.
  const original = (dir, hasFvg, swept, volSurge, deltaRatio) =>
    (hasFvg ? 1 : 0) + (swept ? 1 : 0) + (volSurge > 1.3 ? 1 : 0) +
    (dir > 0 ? (deltaRatio > 0.15 ? 1 : 0) : (deltaRatio < -0.15 ? 1 : 0));

  const volSurges = [1.0, 1.31];
  const deltas = [0, 0.16, -0.16];
  let checked = 0;
  for (const dir of [+1, -1]) {
    for (const hasFvg of [false, true]) {
      for (const swept of [false, true]) {
        for (const volSurge of volSurges) {
          for (const deltaRatio of deltas) {
            const args = [{ hasFvg, swept, volSurge, deltaRatio }, 1];
            assert.equal(
              engine.confluenceCount(dir, ...args),
              original(dir, hasFvg, swept, volSurge, deltaRatio),
              `dir=${dir} hf=${hasFvg} sw=${swept} vs=${volSurge} d=${deltaRatio}`);
            checked++;
          }
        }
      }
    }
  }
  assert.equal(checked, 48, 'every combination must actually be evaluated');
});

test('the weight is per-instance, so a study can demote the gap at runtime', () => {
  const before = engine.fvgConfluenceWeight;
  engine.fvgConfluenceWeight = 0;
  assert.equal(engine.fvgConfluenceWeight, 0,
    'a study must be able to arm the demotion without re-requiring the module');
  engine.fvgConfluenceWeight = before; // restore: the module is a shared singleton
  assert.equal(engine.fvgConfluenceWeight, 1);
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

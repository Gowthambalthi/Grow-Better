'use strict';

/**
 * THE REGISTRY MUST DESCRIBE THE ENGINE, NOT ITSELF.
 *
 * Three separate drifts happened in this file's neighbourhood, and each one
 * looked correct on the page while the code did something else:
 *
 *   1. GB01's label said "14:00 IST entry cutoff" while `fvg.DEFAULTS`
 *      refuses at 14:45. A person reading the board would size the session
 *      around a cutoff the engine does not have.
 *   2. GB03a's label said "09:25–11:00 … with trend alignment": a lower bound
 *      the engine has never had, and a filter that cannot exist (its longs sit
 *      on the far side of every EMA by construction).
 *   3. The registry pinned `maxSignalTime: 1100` while the engine's DEFAULTS and
 *      its docs said 12:30 — and the pin was justified by a "57.9% win rate,
 *      netPF 2.19" that came from the impossible filter in (2).
 *
 * These assertions compare the LABEL and the CONFIG against the module that
 * actually runs, so a future edit that changes one and not the other fails here
 * instead of on the page.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ENGINES } = require('../strategy-core/engines');
const fvg = require('../strategies/fvg');
const orderFlow = require('../strategies/orderFlow');

const ROOT = path.join(__dirname, '..');
const registrySrc = fs.readFileSync(path.join(ROOT, 'strategy-core/engines.js'), 'utf8');

const byKey = (k) => ENGINES.find((e) => e.key === k);
/** Effective config for an engine: its own DEFAULTS, overridden by the registry pin. */
const effective = (e) => Object.assign({}, e.mod.DEFAULTS, e.config || {});

const hhmm = (minutesOfDay) => String(Math.floor(minutesOfDay / 60)).padStart(2, '0') + ':' +
  String(minutesOfDay % 60).padStart(2, '0');
const hhmmClock = (n) => String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');

test('every registry config key names a real engine setting', () => {
  // A pin the engine does not read is dead code wearing a measurement's clothes:
  // it looks like a decision and changes nothing.
  for (const e of ENGINES) {
    for (const key of Object.keys(e.config || {})) {
      assert.ok(key in e.mod.DEFAULTS,
        `${e.key} pins "${key}", which is not in ${e.file}'s DEFAULTS — the pin is inert`);
    }
  }
});

test('GB01 states the cutoff the FVG engine enforces', () => {
  const fg = byKey('FVG');
  const cutoff = effective(fg).maxEntryMinute;
  assert.equal(cutoff, 14 * 60 + 45, 'the FVG entry cutoff moved — re-measure and update the doc');
  const fam = fg.setups.find((s) => s.setup === 'FG01');
  assert.ok(fam.needs.includes(hhmm(cutoff)),
    `GB01's description must print the real cutoff ${hhmm(cutoff)}; it says: ${fam.needs}`);
  assert.ok(!/14:00 IST entry cutoff/.test(fam.needs), 'the 14:00 label is the drift this test exists to catch');
});

test('GB03a states the cutoff the order-flow engine enforces, and claims no trend filter', () => {
  const of = byKey('ORDERFLOW');
  const cutoff = effective(of).maxSignalTime;
  assert.equal(cutoff, orderFlow.DEFAULTS.maxSignalTime,
    'the registry pin must match the engine DEFAULTS — live reads the pin while the docs read DEFAULTS');
  const fam = of.setups.find((s) => s.setup === 'OF03');
  assert.ok(fam.label.includes(hhmmClock(cutoff)),
    `GB03a's label must print the real cutoff ${hhmmClock(cutoff)}; it says: ${fam.label}`);
  assert.ok(!/trend alignment/i.test(fam.needs + fam.label),
    'OF03 has no trend gate — the measurement proved its longs cannot pass one');
  assert.ok(!/09:25/.test(fam.label + fam.needs),
    'the engine has no 09:25 lower bound; the harness window opens at 09:20');
});

test('the fabricated OF03 claim is not PINNED anywhere in the registry', () => {
  // A comment may (and should) explain why a number was wrong — quoting it is how a
  // reader learns what happened. What must not exist is the pin that stated it as
  // the reason for a value, which is the exact text this test looks for.
  assert.ok(!/maxSignalTime:\s*1100\s*,/.test(registrySrc), 'the 11:00 pin is gone — it measured 6.7R worse');
  assert.ok(!/\(57\.9% win rate, netPF 2\.19\)/.test(registrySrc),
    'the fabricated justification must not be attached to a setting');
});

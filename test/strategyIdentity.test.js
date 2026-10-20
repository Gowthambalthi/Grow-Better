'use strict';

/**
 * NO STRATEGY MAY BE A RENAMED COPY OF ONE WE ALREADY RUN.
 *
 * The incident this pins: on 2026-10-17 `strategies/codex.js` and
 * `strategies/swing.js` appeared and were reported as new strategies. `swing.js` was
 * byte-identical to `strategies/orderFlow.js` apart from its header; `codex.js` was
 * the same file with `setup: 'OF03'` renamed to `'CODEX'`. Both then produced their
 * own backtest artifacts (25 trades each) that read as two independent measurements
 * of two ideas, when there is one engine and two names. They were quarantined to
 * `data/quarantine_2026-10-17/` and this file exists so the next one cannot ship
 * quietly.
 *
 * THE TEST IS ON CONTENT, NOT FILENAMES (see strategy-core/engineIdentity.js), and it
 * checks three things:
 *
 *   1. no two REGISTERED engines are copies of each other — the registry is the list
 *      the board, the server and the docs read, so a duplicate here is published;
 *   2. no unregistered `strategies/*.js` file is a copy of a registered engine — a
 *      stray file that is not in the registry still gets run by hand-rolled harnesses
 *      and screenshotted as an "official report";
 *   3. the check itself discriminates: a deliberate rename must trip it, and two
 *      genuinely different engines must not. Without (3) a broken normaliser would
 *      turn this file into a green light that guards nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ENGINES } = require('../strategy-core/engines');
const { similarity, duplicateOf, DUPLICATE_THRESHOLD } = require('../strategy-core/engineIdentity');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pct = (r) => (r * 100).toFixed(1) + '%';

test('the similarity check itself discriminates — a rename trips it, a different engine does not', () => {
  const of = read('strategies/orderFlow.js');
  // A RENAME, generated in memory: every setup id becomes a new one. This is what
  // codex.js was, so the guard must catch it even when no such file is on disk.
  const renamed = of.replace(/'OF03'/g, "'CODEX'").replace(/OF03/g, 'CODEX');
  assert.ok(similarity(of, renamed) >= DUPLICATE_THRESHOLD,
    'a file that differs only by renamed ids must be caught: scored ' + pct(similarity(of, renamed)));
  // AND THE OTHER DIRECTION. Two engines with different rules must sit far below the
  // threshold, or this guard is a tripwire that fires on everything.
  const fvg = read('strategies/fvg/index.js');
  assert.ok(similarity(of, fvg) < DUPLICATE_THRESHOLD - 0.2,
    'a genuinely different engine must not be flagged: scored ' + pct(similarity(of, fvg)));
});

test('no two REGISTERED engines are renamed copies of each other', () => {
  const offenders = [];
  for (const e of ENGINES) {
    const src = e.file && fs.existsSync(path.join(ROOT, e.file)) ? read(e.file) : null;
    if (!src) continue;
    const hit = duplicateOf(src, ENGINES, e.key);
    if (hit) offenders.push(e.key + ' (' + e.file + ') is ' + pct(hit.ratio) +
      ' identical to ' + hit.key + ' (' + hit.file + ')');
  }
  assert.deepEqual(offenders, [],
    'the registry publishes every engine it lists, so a duplicate here is a duplicate on the board:\n  ' +
    offenders.join('\n  '));
});

test('no unregistered strategies/*.js file is a renamed copy of a registered engine', () => {
  const dir = path.join(ROOT, 'strategies');
  const registeredFiles = new Set(ENGINES.map((e) => (e.file || '').replace(/\\/g, '/')));
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;                    // top level only: sub-folders are engines' homes
    const rel = 'strategies/' + name;
    if (registeredFiles.has(rel)) continue;                 // it IS a registered engine
    const hit = duplicateOf(read(rel), ENGINES);
    if (hit) offenders.push(rel + ' is ' + pct(hit.ratio) + ' identical to ' + hit.key +
      ' (' + hit.file + ')');
  }
  assert.deepEqual(offenders, [],
    'a strategy file must be a NEW strategy or be quarantined — a renamed copy is not a second ' +
    'measurement of a second idea:\n  ' + offenders.join('\n  ') +
    '\n  If it is a copy, move it to data/quarantine_<date>/ and record why there.');
});

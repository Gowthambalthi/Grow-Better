'use strict';

/**
 * THE EXCHANGE PANEL MUST SHOW WHAT WAS WRITTEN, NOT A PARAPHRASE.
 *
 * exchange.md is the two-AI research memory. The dashboard now renders the latest
 * round of each side, so two failure modes matter and both are silent:
 *   - showing a STALE round, because Freebuff's later rounds are appended after the
 *     changelog rather than inside the FREEBUFF section (a section-based reader gets
 *     this wrong, which is why attribution is by heading);
 *   - showing NOTHING and looking like "no research happened" when the file merely
 *     moved or was renamed.
 * Both are pinned below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { exchangeDigest } = require('../common/market/exchangeDigest');

function sandbox(markdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exchange-'));
  if (markdown != null) fs.writeFileSync(path.join(dir, 'exchange.md'), markdown, 'utf8');
  return dir;
}

const SAMPLE = [
  '# TRADING AI EXCHANGE',
  '',
  '==================================================',
  'FREEBUFF — LATEST UPDATE',
  '==================================================',
  '',
  'Round: Initial',
  '',
  '### Round 2: Freebuff — early finding',
  'EARLY-BODY-LINE',
  '',
  '==================================================',
  'ANTIGRAVITY — LATEST UPDATE',
  '==================================================',
  '',
  'Round: 1',
  '',
  '### Round 2: Antigravity Response — the MFE discovery',
  'ANTIGRAVITY-BODY-LINE',
  '',
  '--------------------------------------------------',
  'NEXT-ROUND-TEXT-AFTER-THE-RULE',
  '',
  '### Round 6: Freebuff — owner-directed variant study',
  'LATEST-FREEBUFF-BODY-LINE',
  '',
  '==================================================',
  'NEXT ACTION',
  '==================================================',
  '',
  'AI that should act next:',
  '**Antigravity**',
  '',
  'Task: run the variant comparison.',
  '',
  '==================================================',
  'CHANGELOG',
  '',
].join('\n');

test('the latest round of EACH side is returned, even when it sits after the changelog', () => {
  const d = exchangeDigest(sandbox(SAMPLE));
  assert.equal(d.ok, true);
  assert.equal(d.freebuff.title, 'Round 6: Freebuff — owner-directed variant study',
    'the newest Freebuff round must win, wherever it is in the file');
  assert.match(d.freebuff.body, /LATEST-FREEBUFF-BODY-LINE/);
  assert.ok(!/EARLY-BODY-LINE/.test(d.freebuff.body), 'and the old one must not be shown');
  assert.equal(d.antigravity.title, 'Round 2: Antigravity Response — the MFE discovery');
  assert.match(d.antigravity.body, /ANTIGRAVITY-BODY-LINE/);
});

test('a round body stops at the next heading or rule rather than swallowing the file', () => {
  const d = exchangeDigest(sandbox(SAMPLE));
  assert.ok(!/NEXT-ROUND-TEXT-AFTER-THE-RULE/.test(d.antigravity.body),
    'the body must stop at the ------ rule that separates rounds: ' + d.antigravity.body);
});

test('the NEXT ACTION block is returned verbatim, with its rule lines stripped', () => {
  const d = exchangeDigest(sandbox(SAMPLE));
  assert.match(d.nextAction, /Antigravity/);
  assert.match(d.nextAction, /run the variant comparison/);
  assert.ok(!/^=+$/m.test(d.nextAction), 'the ==== rules are formatting, not content');
  assert.ok(!/CHANGELOG/.test(d.nextAction), 'and the block ends at the next section');
});

test('round history is counted per side so the page can show how far the loop has run', () => {
  const d = exchangeDigest(sandbox(SAMPLE));
  assert.equal(d.freebuff.roundCount, 2);
  assert.equal(d.antigravity.roundCount, 1);
  assert.deepEqual(d.rounds.map((r) => r.who), ['freebuff', 'antigravity', 'freebuff']);
});

test('a missing exchange file degrades to ok:false instead of throwing', () => {
  const dir = sandbox(null);            // directory exists, file does not
  const d = exchangeDigest(dir);
  assert.equal(d.ok, false);
  assert.match(d.error, /not readable/);
  assert.equal(d.freebuff, undefined, 'no side is invented when there is no file');
});

test('the real exchange.md yields a usable digest', () => {
  const root = path.join(__dirname, '..');
  const d = exchangeDigest(root);
  assert.equal(d.ok, true, 'the project exchange.md must be readable from the repo root');
  assert.ok(d.lines > 100, 'the real file is long: ' + d.lines);
  assert.ok(d.freebuff && d.freebuff.body.length > 100, 'Freebuff round body is returned');
  assert.ok(d.antigravity && d.antigravity.body.length > 100, 'Antigravity round body is returned');
  assert.ok(d.nextAction.length > 50, 'the next action is returned');
  assert.ok(/freebuff/i.test(d.freebuff.title), 'attributed to Freebuff: ' + d.freebuff.title);
  assert.ok(/antigravity/i.test(d.antigravity.title), 'attributed to Antigravity: ' + d.antigravity.title);
});

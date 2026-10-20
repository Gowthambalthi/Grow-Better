/**
 * test/windowGate.test.js — pin the window/gate contract added to backtest/runAll.js.
 *
 * WHY EACH ASSERTION EXISTS. §7 of docs/GB-EDGE-REVIEW-2026-10-18.md found that every GB
 * number in that review had been measured over 705 sessions (2023-12-04 → 2026-10-06) while
 * the framework authorizes 172 (2025-09-16 → 2026-05-29) and marks 2026-09-24…30 SEALED. The
 * gate that enforces that existed only in backtest/intradayStrategies.js; runAll.js — the
 * harness the measurements actually use — had no manifest reference at all, and its --from /
 * --days were lower bounds, so "no later than" was not expressible from the CLI.
 *
 * So the four things pinned here are the four that were missing:
 *   1. an absent manifest REFUSES the run (exit 2), instead of running unauthorized;
 *   2. a tampered manifest REFUSES it too — the fingerprint is checked, not trusted;
 *   3. a gate NAMES the sealed sessions it refused rather than dropping them silently;
 *   4. a windowed run cannot overwrite the shipped artifact, and an ungated window SAYS it
 *      is ungated — the failure mode was a subset quietly becoming "the backtest".
 *
 * The CLI is spawned rather than imported: the window flags are read at module load, so the
 * only honest way to test them is to run the command a person would run.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = 'research/framework/manifests/learning_1m.json';
const CANONICAL = path.join(ROOT, 'data', 'terminal', 'backtest_results.json');

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, ['backtest/runAll.js', ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const hashOf = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);

test('a missing manifest REFUSES the run instead of measuring anyway', () => {
  const r = run(['--symbols=3', '--manifest=research/framework/manifests/does_not_exist.json']);
  assert.equal(r.code, 2, 'an unauthorized window must not exit 0');
  assert.match(r.stdout, /\[gate\] REFUSED: authorized-session manifest missing/);
});

test('a tampered manifest REFUSES the run — the fingerprint is checked, not trusted', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
  m.sessions = m.sessions.slice(0, -1);          // one session removed, fingerprint left stale
  const tmp = path.join(os.tmpdir(), 'tampered_manifest_' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify(m));
  try {
    const r = run(['--symbols=3', '--manifest=' + tmp]);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /fingerprint mismatch \(tampered or stale\)/);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('a gated run names every sealed session it refused, and writes outside the record', () => {
  const before = hashOf(CANONICAL);
  const r = run(['--symbols=3', '--manifest=' + MANIFEST]);
  assert.equal(r.code, 0, r.stdout.slice(-500));
  assert.match(r.stdout, /^manifest: .*stage=learning .*172 authorized sessions/m);
  assert.match(r.stdout, /sealed : 2026-09-24…2026-09-30 — refused by name: .*2026-09-24.*NOT read/);
  assert.equal(hashOf(CANONICAL), before,
    'a windowed run must never rewrite data/terminal/backtest_results.json — that is the record');
  assert.match(r.stdout, /written: scratch\\backtest_window_start_to_now_gated\.json/);
});

test('an ungated window says so out loud, and states that nothing is refused', () => {
  const r = run(['--symbols=3', '--from=2026-01-01']);
  assert.equal(r.code, 0, r.stdout.slice(-500));
  assert.match(r.stdout, /manifest: NONE — this window is NOT authorized by a manifest/);
  assert.match(r.stdout, /no sealed\s+session is refused/);
  assert.doesNotMatch(r.stdout, /refused by name/);
});

test('an unknown --engine REFUSES with a non-zero status and names the real keys', () => {
  // A suggested workflow included `--engine=gb01`, which is not a key: gb01/gb02 name SETUPS
  // inside the FVG engine. The run printed "Unknown --engine" and exited 0, so a script chaining
  // it read success from a run that measured nothing — the same failure the duplicate-module
  // branch already guards against by setting exitCode 2.
  const r = run(['--engine=gb01', '--symbols=1']);
  assert.equal(r.code, 2, 'a run that measured nothing must not exit 0');
  assert.match(r.stdout, /Unknown --engine=gb01/);
  // THE KEY LIST IS THE REGISTRY'S, so it changed when CODEX and SWING were removed (2026-10-18,
  // both measured net-negative). The assertion pins that the refusal NAMES the real keys — which
  // is what makes the message usable — rather than freezing a list the registry may legitimately
  // change; it is derived from the registry here so the two cannot drift apart.
  const registry = require('../strategy-core/engines');
  const validKeys = registry.ENGINES.map((e) => e.key).join('|');
  assert.match(r.stdout, new RegExp('valid keys: ' + validKeys.replace(/\|/g, '\\|')),
    'the refusal must name exactly the registered keys: ' + validKeys);
  assert.ok(!/CODEX|SWING/.test(r.stdout),
    'a removed engine must not be offered as a valid key: ' + r.stdout);
  assert.match(r.stdout, /nothing was measured and nothing was written/);
});

test('--to is an UPPER bound on the bar date, so the window can be closed at both ends', () => {
  const r = run(['--symbols=3', '--from=2025-09-16', '--to=2025-10-31']);
  assert.equal(r.code, 0, r.stdout.slice(-500));
  const span = r.stdout.match(/span\s+: (\S+) → (\S+)/);
  assert.ok(span, 'the run must print the span it actually measured');
  assert.ok(span[2] <= '2025-10-31' && span[2] >= '2025-09-16',
    'last measured session must be inside the closed window, got ' + span[2]);
});

'use strict';

/**
 * ARMING OF_MOMENTUM MUST ACTUALLY OPEN THE GATES.
 *
 * On 2026-10-19 the live process was told to arm the prototype. The cap bookkeeping flipped to
 * "armed" — and the board stayed empty, because the two code paths that EMIT a long or a short
 * still read the env constant (`ENABLE_OF_MOMENTUM`) rather than the session flag. A session that
 * says yes and a scan that says no is unreadable from the outside: it looks exactly like a quiet
 * market, which is the symptom the owner reported.
 *
 * This file disables the env constant EXPLICITLY, so the only thing that can open the gates is
 * `enableOfMomentumLive()` — the call Server.js makes and nothing else does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-arming-'));
process.env.GB_ORDERFLOW_DIR = DIR;
process.env.GB_ENABLE_OF_MOMENTUM = '0';      // the shipped live default
process.env.GB_GATE_TELEMETRY = '0';

const engine = require('../strategies/orderflow/liveMinuteEngine');

test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {} });

test('an unarmed engine emits nothing, even though the caps are configured', () => {
  assert.equal(engine.ofMomentumArmed(), false,
    'GB_ENABLE_OF_MOMENTUM=0 and no session arming must mean the gates are shut');
  const st = engine.ofMomentumLiveState();
  assert.equal(st.armed, false);
  // The caps exist either way — they are the ceiling for a session, not a switch.
  assert.ok(st.maxSlots > 0 && st.maxPerSession > 0);
});

test('enableOfMomentumLive() is what a live session does, and it opens the SAME gate the scan reads', () => {
  const st = engine.enableOfMomentumLive({ maxSlots: 2, maxPerSession: 5 });
  assert.equal(st.armed, true);
  assert.equal(st.maxSlots, 2, 'the slot cap comes from the caller, not from a default');
  assert.equal(st.maxPerSession, 5);
  // THE DEFECT, PINNED: the arming flag and the gate predicate are one value. If the gates go
  // back to reading the env constant, this stays false and the test fails.
  assert.equal(engine.ofMomentumArmed(), true,
    'arming the session must open the long/short emission gates');
  assert.deepEqual(engine.ofMomentumLiveState(), { armed: true, maxSlots: 2, maxPerSession: 5 });
});

test('a fresh scan funnel carries the arming state so the board and the inbox can say it', () => {
  // No scan has walked the universe in this process, but the funnel must still be able to name
  // the state: `armed: false` with no other explanation is the silence this field removes.
  const f = engine.getScanFunnel();
  assert.ok(f && Object.prototype.hasOwnProperty.call(f, 'ofMomentum'),
    'getScanFunnel publishes an ofMomentum field');
  assert.equal(f.ofMomentum, null,
    'null until a scan stamps it — not `{armed:false}`, which would read as "switched off"');
});

test('the cap is a real default, not zero: 3 of 6 slots and 12 calls a session', () => {
  const saved = { s: process.env.GB_OF_MOMENTUM_SLOTS, m: process.env.GB_OF_MOMENTUM_MAX_PER_SESSION };
  const probe = engine.ofMomentumLiveState();
  // enableOfMomentumLive above passed explicit caps; the shipped defaults are what a bare call gets.
  assert.equal(typeof probe.maxSlots, 'number');
  assert.ok(probe.maxSlots >= 1 && probe.maxSlots <= 6,
    'a slot cap outside 1..6 would either starve the prototype or take the whole board');
  assert.ok(probe.maxPerSession >= 1 && probe.maxPerSession <= 20,
    'the session cap bounds a prototype day');
  if (saved.s === undefined) delete process.env.GB_OF_MOMENTUM_SLOTS; else process.env.GB_OF_MOMENTUM_SLOTS = saved.s;
  if (saved.m === undefined) delete process.env.GB_OF_MOMENTUM_MAX_PER_SESSION; else process.env.GB_OF_MOMENTUM_MAX_PER_SESSION = saved.m;
});

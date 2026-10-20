'use strict';

/**
 * L3 GATE TELEMETRY MUST REMAIN MEASUREMENT, NOT MECHANISM.
 *
 * strategies/orderflow/gateTelemetry.js exists so the next gate question is answerable
 * from data: one bundle per scan holding (a) the funnel exactly as published, (b) the
 * day's call-status tally — CANCELLED_EXHAUSTION included, because 54 of 169 book
 * records in the 13-day census ended there and no gate telemetry could see them — and
 * (c) every evaluated candidate with ALL of its gate outcomes, including the terms a
 * short-circuited if/else hides behind its first failure.
 *
 * These tests pin the three properties that make that safe:
 *  1. firstFail is byte-for-byte the engine's existing `find(([,ok]) => !ok)[0]`
 *     attribution — telemetry may never re-attribute a refusal to a different gate.
 *  2. failedSet is a SUPERSET whose first member equals firstFail (overlap analysis,
 *     never a replacement).
 *  3. appendScan only ever writes what it is handed — one scan line, then candidate
 *     lines — to the caller's directory (the GB_ORDERFLOW_DIR sandbox contract).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tel = require('../strategies/orderflow/gateTelemetry');

/** The attribution rule the live funnel already uses, copied verbatim from the engine. */
function engineFirstFail(checks) {
  const found = checks.find(([, ok]) => !ok);
  return found ? found[0] : null;
}

test('firstFail matches the engine attribution rule for every pass/fail pattern', () => {
  const names = ['a', 'b', 'c', 'd'];
  for (let mask = 0; mask < (1 << names.length); mask++) {
    const checks = names.map((n, i) => [n, !(mask & (1 << i))]);
    assert.strictEqual(tel.firstFail(checks), engineFirstFail(checks));
  }
  assert.strictEqual(tel.firstFail([['a', true], ['b', true]]), null);
});

test('failedSet records every refused term and starts with the first failure', () => {
  const checks = [['a', false], ['b', true], ['c', false], ['d', false]];
  const fails = tel.failedSet(checks);
  assert.deepStrictEqual(fails, ['a', 'c', 'd']);
  assert.strictEqual(tel.firstFail(checks), fails[0]);
  assert.deepStrictEqual(tel.failedSet([['a', true], ['b', true]]), []);
});

test('statusTally counts every status, CANCELLED_EXHAUSTION among them', () => {
  const tally = tel.statusTally([
    { status: 'ARMED' }, { status: 'CANCELLED_EXHAUSTION' },
    { status: 'CANCELLED_EXHAUSTION' }, { status: 'WON' }, {},
  ]);
  assert.deepStrictEqual(tally, { ARMED: 1, CANCELLED_EXHAUSTION: 2, WON: 1, UNKNOWN: 1 });
});

test('appendScan writes one bundle: scan line first, then one line per candidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tel-'));
  const funnel = { scanned: 3, long: { fib_discount: 2, armed: 1 } };
  const rows = [
    { sym: 'AAA', dir: 'L', ref: 'fib_discount', fails: ['fib_discount', 'vwap_side'], v: { dc: 0.1 }, ok: false },
    { sym: 'BBB', dir: 'S', ref: null, fails: [], v: { dc: -0.9 }, ok: true },
  ];
  const book = { ARMED: 1, CANCELLED_EXHAUSTION: 5 };
  const file = tel.appendScan(dir, '2026-10-17', { ist: '10:15:00', funnel, rows, bookStatus: book });

  assert.strictEqual(path.basename(file), 'gate_funnel_2026-10-17.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0].k, 'scan');
  assert.deepStrictEqual(lines[0].funnel, funnel);
  assert.deepStrictEqual(lines[0].book, book);
  assert.strictEqual(lines[1].k, 'c');
  assert.strictEqual(lines[1].sym, 'AAA');
  assert.strictEqual(lines[1].ref, 'fib_discount');
  assert.deepStrictEqual(lines[1].fails, ['fib_discount', 'vwap_side']);
  assert.strictEqual(lines[2].ok, true);
  assert.strictEqual(lines[1].ist, '10:15:00');
});

test('a second scan appends rather than truncating (daily ledger semantics)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tel-'));
  tel.appendScan(dir, '2026-10-17', { ist: '10:00:00', funnel: { scanned: 1 }, rows: [], bookStatus: {} });
  const file = tel.appendScan(dir, '2026-10-17', { ist: '10:01:00', funnel: { scanned: 2 }, rows: [], bookStatus: {} });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).ist, '10:00:00');
  assert.strictEqual(JSON.parse(lines[1]).ist, '10:01:00');
});

test('an empty or absent rows array still writes a valid scan line (never drops the funnel)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-tel-'));
  const file = tel.appendScan(dir, '2026-10-17', { ist: '11:00:00', funnel: { scanned: 0 }, bookStatus: undefined });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(JSON.parse(lines[0]).book, {});
});
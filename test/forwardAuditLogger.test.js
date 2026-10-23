'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const logger = require('../strategy-core/forwardAuditLogger');

test('forwardAuditLogger: config hash is deterministic 16-char hex', () => {
  assert.equal(typeof logger.CONFIG_HASH, 'string');
  assert.equal(logger.CONFIG_HASH.length, 16);
  assert.match(logger.CONFIG_HASH, /^[0-9a-f]{16}$/);
});

test('forwardAuditLogger: logs valid candidate row with required schema', () => {
  const row = logger.logCandidate({
    session_date: '2026-10-23',
    symbol: 'RELIANCE',
    fvg_id: 'FVG-RELIANCE-2026-10-23-5m-2745.50',
    gate_failed: 'PASS',
    atr_pct: 0.68,
    wick_ratio: 0.42,
    rr: 1.45,
  });

  assert.equal(row.type, 'CANDIDATE');
  assert.equal(row.symbol, 'RELIANCE');
  assert.equal(row.gate_failed, 'PASS');
  assert.equal(row.config_hash, logger.CONFIG_HASH);
  assert.equal(typeof row.ts, 'number');
});

test('forwardAuditLogger: logs heartbeat row with required schema', () => {
  const hb = logger.logHeartbeat({
    session_date: '2026-10-23',
    symbols_expected: 494,
    symbols_with_complete_bars: 492,
    bars_missing: 14,
    candidates_logged: 18,
  });

  assert.equal(hb.type, 'HEARTBEAT');
  assert.equal(hb.symbols_expected, 494);
  assert.equal(hb.candidates_logged, 18);
  assert.equal(hb.config_hash, logger.CONFIG_HASH);
});

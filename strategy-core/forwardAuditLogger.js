'use strict';

/**
 * strategy-core/forwardAuditLogger.js
 *
 * Implements the pre-registered append-only logging schema for GB01 forward testing:
 * - Candidate rows (all evaluated FVG retests, both passed and rejected)
 * - Session heartbeat rows (tracking data completeness and symbols scanned)
 * - Computes deterministic SHA-256 config hash
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function getLogDir() {
  return process.env.GB_ORDERFLOW_DIR || path.join(ROOT, 'data', 'orderflow');
}

function getLogFile() {
  return path.join(getLogDir(), 'forward_audit_2026.jsonl');
}

// Frozen production parameters for config hashing
const FROZEN_CONFIG = {
  strategy: 'GB01',
  setup: 'FG01',
  minGapPct: 0.10,
  minZoneAgeBars: 1,
  maxZoneAgeBars: 180,
  wickRatio: 0.35,
  minVolRatio: 1.0,
  powerHourVolRatio: 1.5,
  maxEntryMinute: 14 * 60 + 45,
  minAtrPct: 0.60,
  maxAtrPct: 8.00,
  maxRangePosPct: 92,
  maxVwapDistPct: 2.50,
  minStopPct: 0.15,
  maxStopPct: 1.50,
  minRR1: 1.20,
  frictionRoundTripPct: 0.05,
};

const CONFIG_HASH = crypto
  .createHash('sha256')
  .update(JSON.stringify(FROZEN_CONFIG))
  .digest('hex')
  .slice(0, 16);

function ensureLogDir() {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function appendRow(rowObj) {
  try {
    ensureLogDir();
    const line = JSON.stringify(rowObj) + '\n';
    fs.appendFileSync(getLogFile(), line, 'utf8');
  } catch (err) {
    console.error('[forwardAuditLogger] Error writing audit log:', err.message);
  }
}

function logCandidate(candidate) {
  const row = {
    type: 'CANDIDATE',
    ts: candidate.ts || Date.now(),
    session_date: candidate.session_date || new Date().toISOString().slice(0, 10),
    symbol: candidate.symbol || 'UNKNOWN',
    config_hash: CONFIG_HASH,
    fvg_id: candidate.fvg_id || null,
    c1_ts: candidate.c1_ts || null,
    c3_ts: candidate.c3_ts || null,
    zone_low: candidate.zone_low != null ? Number(candidate.zone_low) : null,
    zone_high: candidate.zone_high != null ? Number(candidate.zone_high) : null,
    gap_pct: candidate.gap_pct != null ? Number(candidate.gap_pct) : null,
    age_bars: candidate.age_bars != null ? Number(candidate.age_bars) : null,
    retest_ts: candidate.retest_ts || null,
    wick_ratio: candidate.wick_ratio != null ? Number(candidate.wick_ratio) : null,
    atr_pct: candidate.atr_pct != null ? Number(candidate.atr_pct) : null,
    vwap_side: candidate.vwap_side || null,
    mtf15_ok: Boolean(candidate.mtf15_ok),
    volume_ratio: candidate.volume_ratio != null ? Number(candidate.volume_ratio) : null,
    range_pos: candidate.range_pos != null ? Number(candidate.range_pos) : null,
    vwap_dist_pct: candidate.vwap_dist_pct != null ? Number(candidate.vwap_dist_pct) : null,
    rr: candidate.rr != null ? Number(candidate.rr) : null,
    stop_width_pct: candidate.stop_width_pct != null ? Number(candidate.stop_width_pct) : null,
    stop_price: candidate.stop_price != null ? Number(candidate.stop_price) : null,
    target_price: candidate.target_price != null ? Number(candidate.target_price) : null,
    gate_failed: candidate.gate_failed || 'PASS',
    signal_ts: candidate.signal_ts || null,
    fill_price: candidate.fill_price != null ? Number(candidate.fill_price) : null,
    exit_ts: candidate.exit_ts || null,
    exit_reason: candidate.exit_reason || null,
    r_multiple: candidate.r_multiple != null ? Number(candidate.r_multiple) : null,
    cost_r: candidate.cost_r != null ? Number(candidate.cost_r) : null,
  };
  appendRow(row);
  return row;
}

function logHeartbeat(heartbeat) {
  const row = {
    type: 'HEARTBEAT',
    ts: Date.now(),
    session_date: heartbeat.session_date || new Date().toISOString().slice(0, 10),
    symbols_expected: Number(heartbeat.symbols_expected) || 0,
    symbols_with_complete_bars: Number(heartbeat.symbols_with_complete_bars) || 0,
    bars_missing: Number(heartbeat.bars_missing) || 0,
    candidates_logged: Number(heartbeat.candidates_logged) || 0,
    config_hash: CONFIG_HASH,
  };
  appendRow(row);
  return row;
}

module.exports = {
  CONFIG_HASH,
  FROZEN_CONFIG,
  get LOG_FILE() { return getLogFile(); },
  logCandidate,
  logHeartbeat,
};

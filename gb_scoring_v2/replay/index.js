/**
 * gb_scoring_v2/replay/index.js — THE REPLAY HARNESS (Phase 3).
 *
 * V3 spec Section 7.2:
 *   - "Deterministic replay of recorded sessions in receipt-time order through the
 *      same adapter and engine code used live, with a virtual clock."
 *   - "Consistency test: replay of a session must reproduce the live shadow output
 *      for that session. Differences are bugs."
 *   - "All tuning and validation runs use replay, so tuning does not require
 *      waiting for live days."
 *
 * The reason replay is a PHASE-3 requirement and not a later convenience is in
 * Section 21: tuning on the sessions you validate on is how a backtest lies. With
 * replay, tuning sessions and unseen sessions can be separated by DATE, and the
 * frozen config evaluated only on the ones it never saw.
 *
 * DETERMINISM RULE. The live path stamps `receiptTs = Date.now()`. A replay that
 * did the same would produce different bytes on every run and could never satisfy
 * the consistency test, so replay injects the RECORDED receipt time instead. That
 * is the one place the harness must diverge from the live code path, and it is
 * why snapshots carry their timestamp rather than reading the clock themselves.
 */
const { readSession, listSessions } = require('../recorder');
const { toSnapshot } = require('../adapter/snapshot');
const { hash } = require('../config/index');   // explicit: a draft config.js sits beside config/

/** A virtual clock: every read returns the replayed instant, never the wall clock. */
class VirtualClock {
  constructor(startMs) { this.now = startMs; this.reads = 0; }
  advanceTo(ms) { if (ms > this.now) this.now = ms; }
  get() { this.reads++; return this.now; }
}

/**
 * replaySession(file, { until }) -> { records, scans, snapshots, configHashes }
 * Records are consumed in receipt-time order; ordering is explicit rather than
 * trusting the file to already be sorted.
 */
function replaySession(file, opts = {}) {
  const records = readSession(file).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const until = opts.until || null;
  const clock = new VirtualClock(records.length ? records[0].ts : Date.now());
  const scans = [];
  const snapshots = [];
  const configHashes = new Set();
  for (const rec of records) {
    if (until && rec.ts > until) break;
    clock.advanceTo(rec.ts);
    if (rec.configHash) configHashes.add(rec.configHash);
    if (rec.type === 'gb_scan') scans.push({ ts: rec.ts, data: rec.data });
    else if (rec.type === 'snapshot_batch') {
      // Re-derive through the SAME normalizer the live adapter uses. If a snapshot
      // cannot be reproduced, that is the consistency test failing loudly.
      for (const s of (rec.data && rec.data.snapshots) || []) {
        const replayed = toSnapshot(fromSnapshotShaped(s), { receiptTs: rec.ts, generatedAt: s.scanTs });
        snapshots.push({ ts: rec.ts, live: s, replayed });
      }
    }
  }
  return { file, records: records.length, scans, snapshots, clock: clock.get(), configHashes: [...configHashes] };
}

/**
 * Snapshot -> the row shape the live normalizer expects. The recorder stores the
 * normalized snapshot, so replay goes back the other way and re-normalizes; if
 * the two disagree the round trip has lost information.
 */
function fromSnapshotShaped(s) {
  const ct = {};
  const back = { m1: s.structure && s.structure.trend1m, m5: s.structure && s.structure.trend5m, m15: s.structure && s.structure.trend15m };
  for (const k of Object.keys(back)) ct[k] = numToWord(back[k]);
  return {
    symbol: s.symbol, ltp: s.price, s10: s.price_evidence.roc10, s20: s.price_evidence.roc20, s30: s.price_evidence.roc30,
    s15: s.price_evidence.roc15s, roc1: s.price_evidence.roc1m, roc5: s.price_evidence.roc5m, roc15: s.price_evidence.roc15m,
    roc60: s.price_evidence.roc60m, volume: s.flow.volume, volX: s.flow.volumeRatio, volRoc: s.flow.volumeRoc,
    totBuy: s.flow.rawBuyQty, totSell: s.flow.rawSellQty, flowBias: s.flow.delta,
    vwap: s.location.vwap, vwapDrift: s.location.vwapSlope, poc: s.location.poc, vaHigh: s.location.vah, vaLow: s.location.val,
    candleTrend: ct, swingAgree: numToWord(s.structure.swingAgree), market: s.context.niftyState,
    daily: { atrPct: s.price_evidence.atrPct }, dayPct: s.reference.dayPct, dayValue: s.reference.turnover,
    engine: s.context.setup, phase: s.reference.phase, tickOnly: s.reference.tickOnly,
    givenAt: s.scanTs,
  };
}
function numToWord(v) {
  if (v === 1) return 'UP';
  if (v === 0.5) return 'UP-LEAN';
  if (v === -1) return 'DOWN';
  if (v === -0.5) return 'DOWN-LEAN';
  if (v === 0) return 'MIXED';
  return null;
}

/**
 * consistency(file, keys) -- THE spec's consistency test.
 * Compares the stored snapshot against the re-derived one on the fields the score
 * actually consumes. Returns per-field mismatch counts, so a failure points at
 * the field rather than just saying "differs".
 */
function consistency(file, keys = ['price', 'roc10', 'roc20', 'roc30', 'delta', 'volume', 'vwap', 'poc']) {
  const r = replaySession(file);
  let compared = 0;
  const mismatches = {};
  const bump = k => { mismatches[k] = (mismatches[k] || 0) + 1; };
  for (const item of r.snapshots) {
    const flat = (s) => ({
      price: s.price, roc10: s.price_evidence.roc10, roc20: s.price_evidence.roc20, roc30: s.price_evidence.roc30,
      delta: s.flow.delta, volume: s.flow.volume, vwap: s.location.vwap, poc: s.location.poc,
    });
    const a = flat(item.live), b = flat(item.replayed);
    for (const k of keys) {
      compared++;
      const x = a[k], y = b[k];
      // null vs null is a MATCH (both "unknown"); null vs number is not.
      if (x !== y) bump(k);
    }
  }
  const total = Object.values(mismatches).reduce((s, n) => s + n, 0);
  return { ok: total === 0, file, records: r.records, compared, mismatches, configHashes: r.configHashes };
}

/** Split recorded sessions into tuning vs unseen by date. */
function splitSessions(files = listSessions(), cutoff) {
  const tuning = [], unseen = [];
  for (const f of files) {
    const m = /raw_(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (!m) continue;
    (cutoff && m[1] > cutoff ? unseen : tuning).push(f);
  }
  return { tuning, unseen, cutoff: cutoff || null };
}

module.exports = { replaySession, consistency, VirtualClock, splitSessions, fromSnapshotShaped, numToWord };

if (require.main === module) {
  const files = listSessions();
  if (!files.length) { console.log('no recorded sessions yet -- run record-session.js first'); process.exit(0); }
  const file = process.argv[2] || files[files.length - 1];
  const c = consistency(file);
  console.log('consistency ' + (c.ok ? 'OK' : 'FAILED') + '  ' + file);
  console.log('  records ' + c.records + '  fields compared ' + c.compared + '  mismatches ' + JSON.stringify(c.mismatches));
  console.log('  config hashes seen: ' + (c.configHashes.join(', ') || '(none)') + '  current ' + hash());
}

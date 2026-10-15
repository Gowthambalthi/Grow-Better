const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  runCandidateStrategy,
  build15mBarsCausal,
  check15mConfluence,
  getMinuteOfIST
} = require('../strategies/fvg/candidate_sweep_15m_fvg');

test('getMinuteOfIST correctly parses IST times', () => {
  assert.strictEqual(getMinuteOfIST('2026-08-03 09:15'), 555);
  assert.strictEqual(getMinuteOfIST('2026-08-03 13:00'), 780);
  assert.strictEqual(getMinuteOfIST('2026-08-03 15:14'), 914);
  assert.strictEqual(getMinuteOfIST('2026-08-03 15:30'), 930);
});

test('build15mBarsCausal groups 15 1m bars into 1 15m bar without peeking', () => {
  const bars1m = [];
  for (let m = 555; m < 570; m++) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    bars1m.push({
      time: `2026-08-03 ${hh}:${mm}`,
      open: 100,
      high: 105,
      low: 95,
      close: 102,
      volume: 1000
    });
  }
  const bars15 = build15mBarsCausal(bars1m);
  assert.strictEqual(bars15.length, 1);
  assert.strictEqual(bars15[0].bucketMin, 555);
  assert.strictEqual(bars15[0].v, 15000);
});

test('runCandidateStrategy runs on empty or short data without throwing', () => {
  const res = runCandidateStrategy([]);
  assert.strictEqual(res.trades.length, 0);
  assert.strictEqual(res.stats.totalTrades, 0);
});

test('When Candidate and Baseline trigger on the same setup ID, trade geometry and exits match bit-for-bit (non-vacuous)', () => {
  const relPath = path.join(__dirname, '../data/ohlcv_1m/RELIANCE.json');
  const d = JSON.parse(fs.readFileSync(relPath, 'utf8'));
  const sessionBars = d.candles.filter(c => c[0].startsWith('2026-06-15'));

  const baseRes = runCandidateStrategy(sessionBars, { symbol: 'RELIANCE', filter15mFvg: false, minRr: 0.1 });
  const candRes = runCandidateStrategy(sessionBars, { symbol: 'RELIANCE', filter15mFvg: true, minRr: 0.1 });

  // Non-vacuous check: must have at least one trade in both arms
  assert.ok(candRes.trades.length >= 1, 'Candidate must produce at least 1 trade');
  assert.ok(baseRes.trades.length >= 1, 'Baseline must produce at least 1 trade');

  for (const cTrade of candRes.trades) {
    const bTrade = baseRes.trades.find(t => t.id === cTrade.id);
    assert.ok(bTrade, `Candidate trade ${cTrade.id} must exist in Baseline`);
    assert.strictEqual(cTrade.side, bTrade.side, 'Side must match');
    assert.strictEqual(cTrade.entryBar, bTrade.entryBar, 'Entry bar must match');
    assert.strictEqual(cTrade.entryTime, bTrade.entryTime, 'Entry time must match');
    assert.strictEqual(cTrade.entryPx, bTrade.entryPx, 'Entry price must match');
    assert.strictEqual(cTrade.exitBar, bTrade.exitBar, 'Exit bar must match');
    assert.strictEqual(cTrade.exitTime, bTrade.exitTime, 'Exit time must match');
    assert.strictEqual(cTrade.exitPx, bTrade.exitPx, 'Exit price must match');
    assert.strictEqual(cTrade.exitReason, bTrade.exitReason, 'Exit reason must match');
    assert.strictEqual(cTrade.grossBps, bTrade.grossBps, 'Gross bps must match');
    assert.strictEqual(cTrade.tollBps, bTrade.tollBps, 'Toll bps must match');
    assert.strictEqual(cTrade.netBps, bTrade.netBps, 'Net bps must match');
    assert.strictEqual(cTrade.rMultiple, bTrade.rMultiple, 'R-multiple must match');
  }
});

test('Multi-trade session demonstrates position-locking state divergence', () => {
  const hdfcPath = path.join(__dirname, '../data/ohlcv_1m/HDFCBANK.json');
  const d = JSON.parse(fs.readFileSync(hdfcPath, 'utf8'));
  const sessionBars = d.candles.filter(c => c[0].startsWith('2026-05-20'));

  const baseRes = runCandidateStrategy(sessionBars, { symbol: 'HDFCBANK', filter15mFvg: false, minRr: 0.1 });
  const candRes = runCandidateStrategy(sessionBars, { symbol: 'HDFCBANK', filter15mFvg: true, minRr: 0.1 });

  // Baseline took SHORT at 09:46 and held it to session close
  assert.strictEqual(baseRes.trades.length, 1);
  assert.strictEqual(baseRes.trades[0].side, 'SHORT');
  assert.strictEqual(baseRes.trades[0].entryTime, '2026-05-20 09:46');

  // Candidate filtered out the 09:46 SHORT, remained flat, and took LONG at 11:36
  assert.strictEqual(candRes.trades.length, 1);
  assert.strictEqual(candRes.trades[0].side, 'LONG');
  assert.strictEqual(candRes.trades[0].entryTime, '2026-05-20 11:36');

  // Explicit proof that Candidate trade is NOT a subset of Baseline trades in this session
  const matchingBase = baseRes.trades.find(t => t.id === candRes.trades[0].id);
  assert.strictEqual(matchingBase, undefined, 'Candidate trade did not exist in Baseline because Baseline was locked in position');
});

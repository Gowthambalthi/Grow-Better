/**
 * scripts/audit1hData.js — aggregate data-quality audit across all 1h files.
 *
 * Acceptance-gate companion to verify1hAlignment.js. Reports:
 *   - bars per symbol (min/p25/median/p75/max) and thin-symbol list
 *   - session-time validity: any bar NOT in {09:15..14:15} (post-stub-filter)
 *   - any zero-volume bars that survived (should be 0 — fetcher filters)
 *   - day coverage per symbol (distinct dates vs max)
 *
 * Usage: node scripts/audit1hData.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'ohlcv_1h');
const SESSION_TIMES = new Set(['09:15', '10:15', '11:15', '12:15', '13:15', '14:15']);

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const rows = [];
  let badTimeBars = 0, zeroVolBars = 0, dupTs = 0;

  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { continue; }
    const c = j.candles || [];
    const dates = new Set(c.map(x => x[0].slice(0, 10)));
    const tsSet = new Set();
    for (const b of c) {
      if (!SESSION_TIMES.has(b[0].slice(11))) badTimeBars++;
      if (b[5] === 0) zeroVolBars++;
      if (tsSet.has(b[0])) dupTs++;
      tsSet.add(b[0]);
    }
    rows.push({ symbol: j.symbol || f.replace('.json', ''), bars: c.length, days: dates.size });
  }

  rows.sort((a, b) => a.bars - b.bars);
  const bars = rows.map(r => r.bars).sort((a, b) => a - b);
  const q = p => bars[Math.floor(p * bars.length)];
  console.log(`Files: ${rows.length}`);
  console.log(`Bars/symbol: min=${bars[0]} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} max=${bars[bars.length - 1]}`);
  console.log(`Off-session bars: ${badTimeBars} | zero-volume bars: ${zeroVolBars} | duplicate timestamps: ${dupTs}`);

  const thin = rows.filter(r => r.bars < 100);
  console.log(`\nThin symbols (<100 bars, expect ~160 for 40 days): ${thin.length}`);
  for (const t of thin.slice(0, 15)) console.log(`  ${t.symbol}: ${t.bars} bars / ${t.days} days`);

  const days = rows.map(r => r.days).sort((a, b) => a - b);
  console.log(`\nDay coverage: min=${days[0]} median=${days[Math.floor(days.length / 2)]} max=${days[days.length - 1]} (trading days in window ≈ 27)`);
}

main();

/**
 * scripts/cleanIntradaySession.js — remove out-of-session bars from the
 * intraday history stores (data/ohlcv_15m, data/ohlcv_1h).
 *
 * Keeps only the NSE regular session: 09:15 <= bar start < 15:15 IST.
 * Drops the 15:15-15:30 closing-auction bar and any stray pre-open rows.
 * Idempotent: re-running finds 0 removals.
 *
 * Usage: node scripts/cleanIntradaySession.js [--dir=ohlcv_15m]
 */
const fs = require('fs');
const path = require('path');

const argDir = (process.argv.find(a => a.startsWith('--dir=')) || '').split('=')[1];
const dirs = argDir ? [argDir] : ['ohlcv_15m', 'ohlcv_1h'];

function inSession(tsMs) {
  const d = new Date(tsMs);
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  const day = ist.getDay();
  if (day < 1 || day > 5) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 555 && mins < 915;
}

let totRemoved = 0, totKept = 0, filesTouched = 0;
for (const dir of dirs) {
  const full = path.join(__dirname, '..', 'data', dir);
  if (!fs.existsSync(full)) { console.log(dir + ': missing, skip'); continue; }
  let removed = 0, kept = 0, touched = 0;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(full, f);
    let j;
    try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(j.candles)) continue;
    const before = j.candles.length;
    j.candles = j.candles.filter(c => Array.isArray(c) && inSession(c[0]));
    if (j.candles.length !== before) {
      j.cleansedAt = new Date().toISOString();
      fs.writeFileSync(p, JSON.stringify(j));
      removed += before - j.candles.length;
      touched++;
    }
    kept += j.candles.length;
  }
  console.log(`${dir}: removed ${removed} out-of-session bars from ${touched} files (${kept} kept)`);
  totRemoved += removed; totKept += kept; filesTouched += touched;
}
console.log(`TOTAL: ${totRemoved} removed, ${totKept} kept across ${filesTouched} files`);

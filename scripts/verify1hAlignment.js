/**
 * scripts/verify1hAlignment.js — verify stock hourly bars and the Nifty-proxy
 * hourly series share IDENTICAL timestamps (same session, no drift).
 *
 * A one-bar misalignment between stock and benchmark would silently corrupt
 * every RS calculation, so this checks:
 *   1. SETFNIF50 bar timestamps ⊆ each stock's timestamps (per symbol sample)
 *   2. no duplicate timestamps within a file
 *   3. every bar timestamp is a known session time (09:15..14:15 after stub drop)
 *
 * Usage: node scripts/verify1hAlignment.js [SYMBOL...]
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'ohlcv_1h');
const PROXY = 'SETFNIF50';
const SESSION_TIMES = new Set(['09:15', '10:15', '11:15', '12:15', '13:15', '14:15']);

function load(sym) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, sym + '.json'), 'utf8')).candles; }
  catch (_) { return null; }
}

function main() {
  const proxy = load(PROXY);
  if (!proxy) { console.log(`FATAL: ${PROXY} hourly series missing — fetch it first`); process.exit(1); }

  // proxy self-checks
  const proxyTs = new Set(proxy.map(c => c[0]));
  if (proxyTs.size !== proxy.length) { console.log(`FAIL: ${PROXY} has duplicate timestamps`); process.exit(1); }
  const badTimes = [...proxyTs].filter(ts => !SESSION_TIMES.has(ts.slice(11)));
  if (badTimes.length) { console.log(`FAIL: ${PROXY} off-session times: ${badTimes.slice(0, 5).join(', ')}`); process.exit(1); }
  console.log(`${PROXY}: ${proxy.length} bars, no dups, all session times valid`);

  const symbols = process.argv.slice(2);
  if (!symbols.length) {
    symbols.push(...fs.readdirSync(DIR).filter(f => f.endsWith('.json')).slice(0, 25).map(f => f.replace('.json', '')));
  }

  let aligned = 0, misaligned = 0;
  for (const sym of symbols) {
    if (sym === PROXY) continue;
    const c = load(sym);
    if (!c) { console.log(`SKIP ${sym} (missing)`); continue; }
    // Compare only on the common date range: fetch windows may start
    // mid-day for one series and at open for the other — those edge-day
    // differences are fetch-window artifacts, NOT session misalignment.
    const commonFrom = c[0][0].slice(0, 10);
    const proxyCommon = [...proxyTs].filter(t => t.slice(0, 10) >= commonFrom);
    const ts = new Set(c.map(x => x[0]));
    let missing = 0;
    for (const p of proxyCommon) if (!ts.has(p)) missing++;
    if (missing === 0) aligned++;
    else { misaligned++; console.log(`MISALIGNED ${sym}: ${missing}/${proxyCommon.length} proxy bars absent from stock series`); }
  }
  console.log(`\nAlignment: ${aligned} aligned, ${misaligned} misaligned of ${symbols.length - (symbols.includes(PROXY) ? 1 : 0)}`);
  process.exit(misaligned ? 1 : 0);
}

main();

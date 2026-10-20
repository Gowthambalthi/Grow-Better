/**
 * orderflow/f1ReplayCheck.js — parity check for the live F1 path.
 *
 * Feeds a RECORDED session tape through orderflow/f1Live.js — the same module that will consume
 * live ticks — and diffs the signals it produces against the Python research run for the same
 * session. If the live module and the research module disagree, the live values are not the
 * researched values, and any live number would be describing a different instrument.
 *
 * Uses a DISCOVERY session on purpose. The held-out session (2026-10-08) stays unread until a
 * cell clears discovery (SPEC 8.27K).
 *
 *   node orderflow/f1ReplayCheck.js 2026-10-06
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createF1Live } = require('./f1Live');

const day = process.argv[2] || '2026-10-06';
const tape = path.join(__dirname, '..', '..', 'data', 'orderflow', 'ticks-' + day + '.jsonl');
if (!fs.existsSync(tape)) { console.error('no tape at ' + tape); process.exit(2); }

// STREAMED, not slurped. A session tape can exceed Node's maximum string length (10-07 does:
// reading it whole throws ERR_STRING_TOO_LONG), and streaming is also how live ticks arrive.
const readline = require('readline');
console.log('[parity] replaying ' + path.basename(tape) + ' (' +
  (fs.statSync(tape).size / 1048576).toFixed(1) + ' MB)');

// The research universe, so live and research look at the same instrument set.
const uni = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'backtest', 'f1', 'universe.json'), 'utf8'));
const symbols = uni.selected || [];
console.log('[parity] research universe: ' + symbols.length + ' symbols');

const live = createF1Live({ symbols, log: process.env.F1_VERBOSE ? console.log : () => {},
  journalPath: path.join(__dirname, '..', '..', 'data', 'orderflow', 'replay', 'f1-signals-' + day + '.jsonl') });

async function replay() {
  const rl = readline.createInterface({ input: fs.createReadStream(tape), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (!line) continue;
    n++;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    live.onTick(row);
    if (n % 500000 === 0) process.stderr.write('  ' + (n / 1e6).toFixed(1) + 'M rows\r');
  }
  console.log('[parity] fed ' + n + ' rows');
  live.closeSession();
}

replay().then(() => {
report();
});

function report() {

// Bar index, not minute-of-day: the research CSVs index bars 0.. from 09:15.
const mine = new Map();   // cell -> Set("SYM|bar|side")
for (const sig of live.signals()) {
  if (sig.status !== 'closed') continue;   // parity is against executed trades, not arms
  if (sig.usable === false) continue;      // research `usable` gate: >= 20 traded bars
  const k = sig.sym + '|' + sig.barIdx + '|' + sig.side;
  if (!mine.has(sig.cell)) mine.set(sig.cell, new Set());
  mine.get(sig.cell).add(k);
}

/**
 * readTrades - the Python runs write UTF-8 WITH A BOM. A naive split leaves \uFEFF glued to the
 * first column, which silently makes every comparison key unmatchable (this cost one debugging
 * round: 0.0% agreement that looked like a broken module and was a broken reader).
 */
function readTrades(file, onlyDay) {
  const out = new Set();
  const rows = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .slice(1).filter((x) => x.trim());
  for (const r of rows) {
    const c = r.split(',');
    if (onlyDay && c[1] !== onlyDay) continue;
    out.add(c[0] + '|' + c[16] + '|' + c[3]);
  }
  return out;
}

const f1dir = path.join(__dirname, '..', '..', 'backtest', 'f1');
let totMine = 0, totTheirs = 0, totBoth = 0;
console.log('\ncell                py   js   both   Jaccard');
for (const cell of [...mine.keys()].sort()) {
  const f = path.join(f1dir, 'trades_discovery_' + cell.replace(/\|/g, '_') + '.csv');
  if (!fs.existsSync(f)) continue;
  const theirs = readTrades(f, day);
  const m = mine.get(cell);
  const both = [...m].filter((x) => theirs.has(x)).length;
  const union = new Set([...m, ...theirs]).size;
  totMine += m.size; totTheirs += theirs.size; totBoth += both;
  console.log(cell.padEnd(18) + String(theirs.size).padStart(4) + String(m.size).padStart(5) +
    String(both).padStart(6) + '   ' + (union ? (both / union * 100).toFixed(1) + '%' : '-'));
}

// Signal-level agreement across ALL cells: a signal is "the same event" if symbol, bar and side
// match, regardless of which cell produced it — that is what matters for live trading.
const allMine = new Set();
for (const s of mine.values()) for (const x of s) allMine.add(x);
const allTheirs = new Set();
for (const f of fs.readdirSync(f1dir)) {
  if (!f.startsWith('trades_discovery_') || !f.endsWith('.csv')) continue;
  for (const k of readTrades(path.join(f1dir, f), day)) allTheirs.add(k);
}
const bothAll = [...allMine].filter((x) => allTheirs.has(x)).length;
const unionAll = new Set([...allMine, ...allTheirs]).size;
console.log('\nALL CELLS  py=' + allTheirs.size + '  js=' + allMine.size + '  both=' + bothAll +
  '  Jaccard=' + (unionAll ? (bothAll / unionAll * 100).toFixed(1) : '0') + '%');
if (process.env.F1_DIFF) {
  const pyOnly = [...allTheirs].filter((x) => !allMine.has(x)).sort();
  const jsOnly = [...allMine].filter((x) => !allTheirs.has(x)).sort();
  console.log('\nPY-ONLY (research found, live missed) n=' + pyOnly.length);
  for (const k of pyOnly) console.log('  ' + k);
  console.log('JS-ONLY (live invented) n=' + jsOnly.length);
  for (const k of jsOnly) console.log('  ' + k);
}
console.log('\nfeed: ' + JSON.stringify(live.feedQuality()));
const perf = live.performance();
console.log('live perf: closed=' + perf.closed + ' overall=' + JSON.stringify(perf.overall));
}

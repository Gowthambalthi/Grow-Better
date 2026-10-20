/**
 * orderflow/f1LiveScoreboard.js — the LIVE scoreboard, per pre-registered cell.
 *
 * Replays a session through orderflow/f1Live.js and prints what each of the 27 cells
 * measured, in the same shape as the research tables, so live and research numbers can be
 * read side by side. Read-only: it never places an order.
 *
 *   node orderflow/f1LiveScoreboard.js 2026-10-06
 *
 * 2026-10-06 and 2026-10-07 are the DISCOVERY sessions (the grid was chosen on them, so these
 * are in-sample). 2026-10-08 is HELD OUT and is deliberately not run here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createF1Live } = require('./f1Live');

const day = process.argv[2] || '2026-10-06';
const tape = path.join(__dirname, '..', '..', 'data', 'orderflow', 'ticks-' + day + '.jsonl');
const uni = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'backtest', 'f1', 'universe.json'), 'utf8'));

const live = createF1Live({
  symbols: uni.selected,
  log: () => {},
  // NOT `f1-live-<day>.jsonl`. A replayed session must never be able to masquerade as a captured
  // one: the live path writes f1-live-*.jsonl and any number read off those files is understood
  // to be live. Replay journals are named for what they are and kept in their own directory.
  journalPath: path.join(__dirname, '..', '..', 'data', 'orderflow', 'replay', 'f1-replay-' + day + '.jsonl'),
});

(async () => {
  const rl = readline.createInterface({ input: fs.createReadStream(tape), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { live.onTick(JSON.parse(line)); } catch (e) { /* counted by the module */ }
  }
  live.closeSession();

  const p = live.performance();
  console.log('==================== LIVE F1 SCOREBOARD — ' + day + ' ====================');
  console.log('feed  : ' + JSON.stringify(p.feed));
  console.log('counts: armed=' + p.armed + ' confirmed=' + p.confirmed + ' closed=' + p.closed +
              ' skipped=' + p.skipped + ' still-live=' + p.live);
  console.log('');
  console.log('cell              n   win%   gross    net@meas  net@frozen  stop  tgt  oflow');
  const rows = Object.entries(p.byCell).sort();
  for (const [cell, b] of rows) {
    console.log(cell.padEnd(17) + String(b.n).padStart(3) +
      String(b.winGrossPct).padStart(7) +
      String(b.gross).padStart(8) +
      String(b.netMeasured == null ? 'n/a' : b.netMeasured).padStart(10) +
      String(b.netFrozen).padStart(11) +
      String(b.stops).padStart(6) + String(b.targets).padStart(5) +
      String(b.oppositeFlow).padStart(7));
  }
  console.log('');
  console.log('by side:  long  ' + JSON.stringify(p.bySide.long));
  console.log('          short ' + JSON.stringify(p.bySide.short));
  console.log('');
  console.log('by pattern (what actually predicted anything):');
  for (const [pat, b] of Object.entries(p.byPattern).sort((a, b) => b[1].n - a[1].n)) {
    console.log('  ' + pat.padEnd(16) + 'n=' + String(b.n).padStart(4) +
      '  win%=' + String(b.winGrossPct).padStart(5) +
      '  gross=' + String(b.gross).padStart(7) +
      '  net@meas=' + String(b.netMeasured == null ? 'n/a' : b.netMeasured).padStart(7));
  }
  const signs = Object.entries(p.byPattern).filter(([, b]) => b.n >= 20 && b.gross > 0)
    .sort((a, b) => b[1].gross - a[1].gross);
  console.log('');
  console.log('patterns with n>=20 and POSITIVE gross: ' +
    (signs.length ? signs.map(([k, b]) => k + '(n=' + b.n + ',' + b.gross + ')').join(', ')
                  : 'none'));
})();

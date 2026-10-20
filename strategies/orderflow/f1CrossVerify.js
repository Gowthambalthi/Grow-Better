/**
 * orderflow/f1CrossVerify.js — side by side: the live module's number vs the research path's number.
 *
 * For a chosen session, symbol and cell this prints, for ONE trade at a time:
 *
 *   1. the DERIVATION — every input the module used, the formula, and the substituted arithmetic,
 *      from the raw 5-minute bar up to net P&L;
 *   2. the CROSS-CHECK — the same field read out of the research trade CSV, next to the live value,
 *      with the difference and a verdict.
 *
 * It deliberately does NOT recompute anything: the derivation is printed from the live module's own
 * signal object and bar series, and the comparison column is read from the file the research path
 * wrote. Two independent producers, one table. If the module and the research run disagree, that is
 * what shows up here.
 *
 *   node orderflow/f1CrossVerify.js 2026-10-08 ANGELONE BHARATFORG CAMS
 *   node orderflow/f1CrossVerify.js 2026-10-08 ANGELONE 1.5|0.00|0.00
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createF1Live } = require('./f1Live');

const ROOT = path.join(__dirname, '..');
const F1DIR = path.join(ROOT, 'backtest', 'f1');
const DISCOVERY = ['2026-10-06', '2026-10-07'];

const day = process.argv[2] || '2026-10-08';
const rest = process.argv.slice(3);
const cell = rest.find((a) => a.includes('|')) || '1.5|0.00|0.00';
const SYMS = rest.filter((a) => !a.includes('|')).map((s) => s.toUpperCase());
if (!SYMS.length) { console.error('usage: node orderflow/f1CrossVerify.js <day> <SYM...> [cell]'); process.exit(2); }

const SPLIT = DISCOVERY.includes(day) ? 'discovery' : 'heldout';
const CSV = path.join(F1DIR, 'trades_' + SPLIT + '_' + cell.replace(/\|/g, '_') + '.csv');

const IST_OFFSET_MS = 330 * 60000;
const istMinOfMs = (ms) => Math.floor((ms + IST_OFFSET_MS) / 60000) % 1440;
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const f = (x, n) => (x == null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(n));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const totalOf = (b) => b.buy + b.sell + b.unc;

// header: 0 sym 1 day 2 cell 3 side 4 pats 5 loc 6 gross 7 net_meas 8 net_frozen 9 risk_bps
//         10 tgt_bps 11 mfe 12 mae 13 fi 14 bi 15 why 16 bar
const COLS = [
  ['gross', 6], ['net_meas', 7], ['net_frozen', 8], ['risk_bps', 9], ['tgt_bps', 10],
  ['mfe', 11], ['mae', 12], ['fi', 13], ['bi', 14],
];
const LIVE_OF = (s) => ({
  gross: s.grossBps, net_meas: s.netMeasured, net_frozen: s.netFrozen, risk_bps: s.riskBps,
  tgt_bps: s.targetBps, mfe: s.mfe, mae: s.mae, fi: s.fi, bi: s.bi,
});

(async () => {
  if (!fs.existsSync(CSV)) { console.error('no research trade file at ' + CSV); process.exit(2); }
  const uni = JSON.parse(fs.readFileSync(path.join(F1DIR, 'universe.json'), 'utf8'));
  const live = createF1Live({
    symbols: uni.selected, log: () => {},
    journalPath: path.join(ROOT, 'data', 'orderflow', 'replay', 'f1-crossverify-' + day + '.jsonl'),
  });

  const tape = path.join(ROOT, 'data', 'orderflow', 'ticks-' + day + '.jsonl');
  const rl = readline.createInterface({ input: fs.createReadStream(tape), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { live.onTick(JSON.parse(line)); } catch (e) { /* counted by the module */ }
  }
  live.closeSession();

  const csvRows = [];
  for (const line of fs.readFileSync(CSV, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1)) {
    if (line.trim()) csvRows.push(line.split(','));
  }

  console.log('');
  console.log('===== CROSS-VERIFICATION  ' + day + '  cell ' + cell + '  (research file: ' +
    path.basename(CSV) + ') =====');
  console.log('      "research" = python backtest/f1/flow_scalper.py, the independent implementation.');
  console.log('      "live"     = orderflow/f1Live.js, the module the server runs.');
  console.log('      Tolerances: gross/net_frozen/why are compared EXACTLY; the rest are read back from a');
  console.log('      CSV written to 4 decimal places, so their floor is ~5e-5 (the file\'s own precision).');

  let anyDiff = 0;
  for (const sym of SYMS) {
    const sigs = live.signals().filter((s) => s.sym === sym && s.status === 'closed' && s.cell === cell);
    console.log('');
    console.log('#' .repeat(100));
    if (!sigs.length) { console.log('  ' + sym + ': no closed signal in this cell'); continue; }

    for (const s of sigs) {
      const bars = live.state.get(sym).sealed;
      const b = bars[s.barIdx];
      const prior = bars.slice(Math.max(0, s.barIdx - 20), s.barIdx).map(totalOf);
      const base = median(prior);
      const tot = totalOf(b);
      const fiCalc = (b.buy + b.sell) > 0 ? (b.buy - b.sell) / (b.buy + b.sell) : null;
      const biCalc = (b.bq && b.sq) ? (b.bq - b.sq) / (b.bq + b.sq) : null;

      console.log('##  ' + sym + '  ' + s.side.toUpperCase() + '  bar ' + s.barIdx + ' (' + hhmm(b.t) + ')');
      console.log('');
      console.log('  -- 1. DERIVATION (what the live module did, step by step)');
      console.log('     signal bar o/h/l/c      : ' + [b.o, b.h, b.l, b.c].map((v) => f(v, 2)).join(' / '));
      console.log('     per-tick aggressor split: buy ' + f(b.buy, 0) + '  sell ' + f(b.sell, 0) + '  unclassified ' + f(b.unc, 0));
      console.log('        (quote rule first: p >= ask -> buy, p <= bid -> sell; else the tick rule)');
      console.log('     total = buy + sell + unc = ' + f(b.buy, 0) + ' + ' + f(b.sell, 0) + ' + ' + f(b.unc, 0) + ' = ' + f(tot, 0));
      console.log('     delta = buy - sell       = ' + f(b.buy - b.sell, 0));
      console.log('     baseline: median of the previous ' + prior.length + ' traded-bar totals = ' + f(base, 0));
      console.log('     BIG BAR  : ' + f(tot, 0) + ' >= ' + f(s.cellVolMult, 2) + ' x ' + f(base, 0) + ' = ' + f(s.cellVolMult * base, 0) +
        '  ->' + (base > 0 && tot >= s.cellVolMult * base ? ' PASS' : ' FAIL'));
      console.log('     FLOW     : FI = (' + f(b.buy, 0) + ' - ' + f(b.sell, 0) + ') / (' + f(b.buy, 0) + ' + ' + f(b.sell, 0) + ') = ' + f(fiCalc, 4) +
        '   |FI| >= ' + f(s.cellFlowTheta, 2) + ' ->' + (fiCalc != null && Math.abs(fiCalc) >= s.cellFlowTheta ? ' PASS' : ' FAIL'));
      console.log('     BOOK     : BI = (' + f(b.bq, 0) + ' - ' + f(b.sq, 0) + ') / (' + f(b.bq, 0) + ' + ' + f(b.sq, 0) + ') = ' + f(biCalc, 4) +
        '   |BI| >= ' + f(s.cellBookTheta, 2) + ' ->' + (biCalc != null && Math.abs(biCalc) >= s.cellBookTheta ? ' PASS' : ' FAIL'));
      console.log('     LOCATION : close ' + f(b.c, 2) + ' vs running POC ' + f(s.locPoc, 2) + ' -> ' + s.loc);
      console.log('     PATTERNS : ' + (s.patterns || []).join('+') +
        '   (all found on the bar, incl. neutral)' + '\n' +
        '     ARMING   : ' + (s.patternsArming || []).join('+') +
        '   (the directional subset research records as `pats`)');
      console.log('     ENTRY    : next bar open = ' + f(s.entry, 2));
      console.log('     STOP     : signal candle far side = ' + f(s.stop, 2) + '  risk = ' + f(s.riskBps, 4) + ' bps');
      console.log('     TARGET   : session POC / nearest profitable node = ' + f(s.target, 2) + '  reward = ' + f(s.targetBps, 4) + ' bps');
      console.log('     EXIT     : ' + s.why + ' @ ' + f(s.exit, 2));
      console.log('     GROSS    : ' + (s.side === 'short'
        ? '(' + f(s.entry, 2) + ' - ' + f(s.exit, 2) + ') / ' + f(s.entry, 2) + ' x 1e4'
        : '(' + f(s.exit, 2) + ' - ' + f(s.entry, 2) + ') / ' + f(s.entry, 2) + ' x 1e4') +
        ' = ' + f(s.grossBps, 6) + ' bps');
      console.log('     TOLL     : measured(causal) ' + f(s.tollMeasured, 4) + ' bps  |  frozen(8.22A) ' + f(s.tollFrozen, 4) + ' bps');
      console.log('     NET      : @measured ' + f(s.netMeasured, 6) + '  |  @frozen ' + f(s.netFrozen, 6));
      console.log('');

      // ---- the research path's own row for the same trade
      const py = csvRows.find((c) => c[0] === sym && c[2] === cell && c[3] === s.side && c[16] === String(s.barIdx));
      console.log('  -- 2. CROSS-CHECK against the research path');
      if (!py) { console.log('     research has NO row for this trade (sym/cell/side/bar)'); anyDiff++; continue; }
      const liveOf = LIVE_OF(s);
      console.log('     field        research          live              diff');
      for (const [name, idx] of COLS) {
        const r = parseFloat(py[idx]);
        const l = liveOf[name];
        const d = (l == null || Number.isNaN(r)) ? null : Math.abs(r - l);
        // `net_meas` IS NOT COMPARABLE AND MUST NOT BE COUNTED AS A PASS OR A FAIL.
        // Research charges the whole-session median spread (it can see bars that had not happened at
        // entry); the live module can only charge the causal trailing-20 spread. They differ by
        // construction, on every trade, by 0.3-0.8 bps - so counting it made this tool report
        // DIFFERENCES on every run and exit non-zero forever, which is a gate that can never pass
        // and therefore gets ignored. It is reported for information; `net_frozen` is the column
        // that means the same thing on both sides. See SPEC 8.27O.
        if (name === 'net_meas') {
          console.log('     ' + name.padEnd(12) + String(f(r, 6)).padStart(16) + '  ' + String(f(l, 6)).padStart(16) +
            '  ' + (d == null ? 'n/a' : d.toExponential(1)) + '  not comparable (hindsight vs causal toll)');
          continue;
        }
        const tol = (name === 'gross' || name === 'net_frozen') ? 1e-6 : 2e-4;
        const ok = d != null && d <= tol;
        if (!ok) anyDiff++;
        console.log('     ' + name.padEnd(12) + String(f(r, 6)).padStart(16) + '  ' + String(f(l, 6)).padStart(16) +
          '  ' + (d == null ? 'n/a' : (d === 0 ? '0 (exact)' : d.toExponential(1))) + (ok ? '  OK' : '  <<< DIFF'));
      }
      const whyOk = py[15] === s.why || (py[15] === 'opposite-flow-close' && s.why === 'opposite-flow');
      console.log('     ' + 'why'.padEnd(12) + String(py[15]).padStart(16) + '  ' + String(s.why).padStart(16) +
        '  ' + (whyOk ? 'match' : '<<< DIFF'));
      const armJs = (s.patternsArming || []).join('|');
      const armPy = String(py[4]).split('|').filter(Boolean).sort().join('|');
      const armJsSorted = armJs.split('|').filter(Boolean).sort().join('|');
      console.log('     ' + 'pats'.padEnd(12) + String(py[4]).padStart(16) + '  ' + armJs.padStart(16) +
        '  ' + (armPy === armJsSorted ? 'match' : '<<< DIFF'));
      if (armPy !== armJsSorted) anyDiff++;
      if (!whyOk) anyDiff++;
    }
  }
  console.log('');
  console.log(anyDiff ? ('CROSS-VERIFICATION: ' + anyDiff + ' DIFFERENCES') : 'CROSS-VERIFICATION: IDENTICAL on every field');
  process.exitCode = anyDiff ? 1 : 0;
})();

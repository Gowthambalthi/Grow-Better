/**
 * orderflow/f1Trace.js — the audit trail for ONE signal, end to end.
 *
 * Answers "where did this number come from" without re-implementing anything: it replays the
 * session through the SAME live module the server runs (orderflow/f1Live.js) and prints what that
 * module actually saw and computed — the raw stored tape lines, the 5-minute bar they aggregated
 * into, the threshold arithmetic on that bar, and then the trade from entry to exit to net P&L.
 *
 *   node orderflow/f1Trace.js 2026-10-08 ANGELONE BHARATFORG CAMS
 *   node orderflow/f1Trace.js 2026-10-08 ANGELONE 1.5|0.00|0.00
 *
 * Nothing here is recomputed by a second implementation. If a printed number is wrong, the module
 * that produced it is wrong — which is the point: this is for cross-verification, so it must not
 * be able to agree with the module while disagreeing with the truth.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { createF1Live } = require('./f1Live');

const day = process.argv[2] || '2026-10-08';
const rest = process.argv.slice(3);
const cellFilter = rest.find((a) => a.includes('|')) || null;
const SYMS = rest.filter((a) => !a.includes('|')).map((s) => s.toUpperCase());
if (!SYMS.length) { console.error('usage: node orderflow/f1Trace.js <day> <SYM...> [cell]'); process.exit(2); }

const ROOT = path.join(__dirname, '..');
const TAPE = path.join(ROOT, 'data', 'orderflow', 'ticks-' + day + '.jsonl');
const UNI = JSON.parse(fs.readFileSync(path.join(ROOT, 'backtest', 'f1', 'universe.json'), 'utf8'));

// CAREFUL: two different clocks in this file.
//   * a TAPE row carries `t` in epoch ms.
//   * a BAR carries `t` as the MINUTE OF DAY (IST) that the bar starts on - e.g. 570 is 09:30.
//     (`f1Live.barStart` returns SESS_OPEN_MIN + 5*k.) Treating a bar's `t` as epoch ms prints
//     05:30 for every bar, because 570 plus the 5h30m offset lands just after the epoch.
const IST_OFFSET_MS = 330 * 60000;
const istMinOfMs = (ms) => Math.floor((ms + IST_OFFSET_MS) / 60000) % 1440;   // epoch ms -> minute of day
const hhmm = (minuteOfDay) => String(Math.floor(minuteOfDay / 60)).padStart(2, '0') + ':' +
  String(minuteOfDay % 60).padStart(2, '0');
const f = (x, n = 2) => (x == null || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(n));
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const totalOf = (b) => b.buy + b.sell + b.unc;

(async () => {
  const live = createF1Live({
    symbols: UNI.selected,
    log: () => {},
    journalPath: path.join(ROOT, 'data', 'orderflow', 'replay', 'f1-trace-' + day + '.jsonl'),
  });

  const raw = new Map(SYMS.map((s) => [s, []]));
  const rl = readline.createInterface({ input: fs.createReadStream(TAPE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (e) { continue; }
    const sym = String(row.s || '').toUpperCase();
    if (!raw.has(sym)) continue;
    raw.get(sym).push(row);
    try { live.onTick(row); } catch (e) { /* counted by the module */ }
  }
  live.closeSession();

  for (const sym of SYMS) {
    const bars = live.state.get(sym) ? live.state.get(sym).sealed : [];
    let sigs = live.signals().filter((s) => s.sym === sym && s.status === 'closed');
    if (cellFilter) sigs = sigs.filter((s) => s.cell === cellFilter);
    // One row per real signal by default: the 27 cells overlap, so without this the same trade is
    // printed up to 27 times and the bar table repeats with it.
    if (!cellFilter) {
      const once = new Map();
      for (const s of sigs) { const k = s.barIdx + '|' + s.side; if (!once.has(k)) once.set(k, s); }
      sigs = [...once.values()];
    }
    const rows = raw.get(sym);

    console.log('');
    console.log('################################################################################');
    console.log('#  ' + sym + '  ' + day + '   (' + rows.length + ' tape rows, ' + bars.length + ' five-minute bars)');
    console.log('################################################################################');

    if (!bars.length) { console.log('  no bars — symbol not in the tape or excluded'); continue; }
    if (!sigs.length) { console.log('  no closed signal' + (cellFilter ? ' in cell ' + cellFilter : '') + ' for this symbol'); }

    // ---- the bar series the module built, around each signal -------------------------------
    const win = [];
    for (const s of (sigs.length ? sigs : [{ barIdx: Math.min(30, bars.length - 1) }])) {
      const lo = Math.max(0, s.barIdx - 3), hi = Math.min(bars.length - 1, s.barIdx + 6);
      if (!win.some(([a, b2]) => a === lo && b2 === hi)) win.push([lo, hi]);
    }
    console.log('');
    console.log('--- the 5-minute bars this module built (its OWN aggregate of the raw rows) -----------------');
    console.log('  idx  time   open      high      low       close     buy       sell      unc      total     delta     bq        sq        bid       ask');
    for (const [lo, hi] of win) {
      console.log('  ' + '-'.repeat(150));
      for (let i = lo; i <= hi; i++) {
        const b = bars[i];
        if (!b) continue;
        console.log('  ' + String(i).padStart(3) + '  ' + hhmm(b.t) + '  ' +
          [b.o, b.h, b.l, b.c].map((v) => String(f(v, 2)).padStart(8)).join(' ').replace(/^/, '') + '  ' +
          [b.buy, b.sell, b.unc, totalOf(b), b.buy - b.sell, b.bq, b.sq, b.bid, b.ask]
            .map((v) => String(v == null ? 'n/a' : Number(v).toFixed(0)).padStart(9)).join(' '));
      }
    }

    // ---- the arithmetic of each signal ----------------------------------------------------
    for (const s of sigs) {
      const b = bars[s.barIdx];
      const prior = bars.slice(Math.max(0, s.barIdx - 20), s.barIdx).map(totalOf);
      const base = median(prior);
      const tot = totalOf(b);
      const buy = b.buy, sell = b.sell;
      const fiCalc = (buy + sell) > 0 ? (buy - sell) / (buy + sell) : null;
      const biCalc = (b.bq && b.sq) ? (b.bq - b.sq) / (b.bq + b.sq) : null;
      console.log('');
      console.log('--- SIGNAL: ' + s.side.toUpperCase() + '  ' + sym + '  bar ' + s.barIdx + ' (' + hhmm(b.t) + ')  cell ' + s.cell);
      console.log('    patterns on the signal bar : ' + (s.patterns || []).join('+'));
      console.log('    rolling median of the previous ' + prior.length + ' bar totals = ' + f(base, 0));
      console.log('    THIS bar total            = ' + f(tot, 0) +
        '    test: total >= vol_mult x base   ->  ' + f(tot, 0) + ' vs ' + f(s.cellVolMult * base, 0) +
        '  =>  ' + (base > 0 && tot >= s.cellVolMult * base ? 'PASS' : 'FAIL?'));
      console.log('    FI = (buy - sell)/(buy + sell) = (' + f(buy, 0) + ' - ' + f(sell, 0) + ')/(' + f(buy, 0) + ' + ' + f(sell, 0) + ') = ' + f(fiCalc, 4) +
        '   |FI| >= ' + f(s.cellFlowTheta, 2) + '  =>  ' + (fiCalc != null && Math.abs(fiCalc) >= s.cellFlowTheta ? 'PASS' : 'FAIL?'));
      console.log('    BI = (bq - sq)/(bq + sq)       = (' + f(b.bq, 0) + ' - ' + f(b.sq, 0) + ')/(' + f(b.bq, 0) + ' + ' + f(b.sq, 0) + ') = ' + f(biCalc, 4) +
        '   |BI| >= ' + f(s.cellBookTheta, 2) + '  =>  ' + (biCalc != null && Math.abs(biCalc) >= s.cellBookTheta ? 'PASS' : 'FAIL?'));
      console.log('    location: close ' + f(b.c, 2) + '  vs running POC ' + f(s.poc, 2) + '  =>  ' + s.loc +
        '   (a SHORT must be at/above the POC, a LONG at/below)');
      console.log('    ENTRY  = next bar open            = ' + f(s.entry, 2) + '   (the bar after the signal — you cannot trade a closed bar)');
      console.log('    STOP   = far side of signal candle= ' + f(s.stop, 2) +
        '   risk = |stop-entry|/entry x 1e4 = ' + f(s.riskBps, 2) + ' bps   [' + (s.riskBps >= 5 ? '>= 5 bps min' : 'TOO TIGHT?') + ']');
      console.log('    TARGET = session POC / nearest profitable node = ' + f(s.target, 2) +
        '   reward = ' + f(s.targetBps, 2) + ' bps');
      console.log('    EXIT   = ' + s.why + ' @ ' + f(s.exit, 2));
      console.log('    gross  = ' + (s.side === 'short'
        ? '(entry - exit)/entry x 1e4 = (' + f(s.entry, 2) + ' - ' + f(s.exit, 2) + ')/' + f(s.entry, 2) + ' x 1e4'
        : '(exit - entry)/entry x 1e4 = (' + f(s.exit, 2) + ' - ' + f(s.entry, 2) + ')/' + f(s.entry, 2) + ' x 1e4') +
        ' = ' + f(s.grossBps, 4) + ' bps');
      console.log('    excursions over the hold: MFE ' + f(s.mfe, 2) + ' bps (best)   MAE ' + f(s.mae, 2) + ' bps (worst adverse)');
      console.log('    TOLL (causal, trailing-20 relative spread + impact + statutory) = ' + f(s.tollMeasured, 4) + ' bps');
      console.log('    TOLL (frozen 8.22A)                                            = ' + f(s.tollFrozen, 4) + ' bps');
      console.log('    net@measured = gross - toll(measured) = ' + f(s.netMeasured, 4) + ' bps');
      console.log('    net@frozen   = gross - toll(frozen)   = ' + f(s.netFrozen, 4) + ' bps');
      console.log('    still open at session end? ' + (s.pendingExit ? 'YES — opposite flow printed on the final bar' : 'no'));
    }

    // ---- the raw rows behind the most interesting bar -------------------------------------
    if (sigs.length) {
      const s = sigs[0];
      const window = [bars[s.barIdx], bars[s.barIdx + 1], bars[s.barIdx + 2]].filter(Boolean);
      console.log('');
      console.log('--- the RAW tape rows behind those bars (what Angel One delivered, as stored) ------------');
      console.log('    a stored row is {t=(epoch ms), s=symbol, p=last traded price, q=last traded QUANTITY,');
      console.log('     v=volume traded today, bq=total BUY qty, sq=total SELL qty [, bid, ask = best-5 level 1]}');
      for (const b of window) {
        // `b.t` is a minute of day, `r.t` is epoch ms - compare in the same units.
        const inside = rows.filter((r) => { const m = istMinOfMs(r.t); return m >= b.t && m < b.t + 5; });
        const label = b === bars[s.barIdx] ? 'SIGNAL bar'
          : b === bars[s.barIdx + 1] ? 'ENTRY bar' : 'next bar';
        console.log('');
        console.log('    ' + label + ' ' + hhmm(b.t) + '  (' + inside.length + ' rows) -- first 8:');
        for (const r of inside.slice(0, 8)) {
          console.log('      ' + JSON.stringify(r));
        }
        const qs = inside.map((r) => Number(r.q) || 0);
        console.log('    ' + label + ' aggregate: rows=' + inside.length + '  sum(q)=' + qs.reduce((a, x) => a + x, 0) +
          '  stored bar: o=' + f(b.o, 2) + ' h=' + f(b.h, 2) + ' l=' + f(b.l, 2) + ' c=' + f(b.c, 2) +
          '  buy=' + f(b.buy, 0) + ' sell=' + f(b.sell, 0) + ' unc=' + f(b.unc, 0));
      }
    }
  }
})();

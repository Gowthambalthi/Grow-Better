'use strict';

/**
 * FVG ELIMINATION TEST — does the FVG actually add anything, or is it decoration?
 *   node scratch/fvg_elimination_test.js
 *
 * THE QUESTION. Every rule set tested in this project either REQUIRES an FVG, counts it as one of
 * four confluence points, or reports it in the call record. Nobody has isolated its contribution:
 * do setups WITH a fair value gap pay more than setups WITHOUT one, everything else held equal?
 *
 * HOW IT IS ISOLATED. The same core gates are applied to every bar (below VWAP for shorts, above
 * for longs, day move, trend alignment, premium/discount, POC, delta-when-known). Within that
 * population each bar is then classified by its FVG state using the engine's own gap finder:
 *   FVG_CE     a LIVE gap exists AND price has retraced to its upper half  (the engine's entry rule)
 *   FVG_OTHER  a LIVE gap exists but price is elsewhere
 *   NO_FVG     no live gap in the last 8 bars
 * The three cohorts are then priced identically (measured cost, stop-FIRST, EOD) so the only
 * difference between them is the FVG.
 *
 * COST IS MEASURED, NOT ASSUMED: 4.5 bps median quoted spread (scratch/spread_measure.js) plus
 * 13.1 bps statutory+brokerage at Rs 50k = 17.6 bps round trip.
 *
 * TWO GEOMETRIES, because the Indian practitioner sources collected by researcher-web state a
 * minimum 1:2 risk-reward as their convention while our live shape is 1:1.50:
 *   50/1.5R (live)  and  60/2R (the external convention's floor)
 *
 * PRE-REGISTERED ACCEPTANCE (fixed before the run): the FVG cohort qualifies only if its mean net
 * beats the NO_FVG cohort by more than 0 bps with a 95% bootstrap CI excluding zero on the PAST 5
 * sessions, AND the same FVG-minus-non-FVG sign appears on the OLDER 5. A difference whose interval
 * straddles zero is reported as "cannot be distinguished from noise", not as a finding.
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const eng = require('../orderflow/liveMinuteEngine');

const BARS = process.env.GB_BARS_DIR
  ? path.resolve(process.env.GB_BARS_DIR)
  : path.join(__dirname, '..', 'data', 'orderflow', 'bars');
const OLDER5 = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05'];
const PAST5 = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'];
const ARM_A = 9 * 60 + 45;
const ARM_B = 14 * 60 + 45;
const COST_BPS = 17.6;               // measured: 13.1 statutory+brokerage at Rs 50k + 4.5 spread
const GEOMS = [{ key: '50_1.5', label: '50/1.5R (live)' }, { key: '60_2', label: '60/2R (1:2 floor)' }];

function toBars(rows) {
  return rows.map((r) => ({
    min: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5],
    delta: r[6] || 0, hasDelta: (r[6] || 0) !== 0,
  }));
}

function resolve(bars, i, price, stopBps, rr, dir) {
  const stop = dir < 0 ? price * (1 + stopBps / 1e4) : price * (1 - stopBps / 1e4);
  const target = dir < 0 ? price * (1 - (stopBps * rr) / 1e4) : price * (1 + (stopBps * rr) / 1e4);
  for (let k = i + 1; k < bars.length; k++) {
    if (dir < 0) {
      if (bars[k].h >= stop) return -stopBps;           // STOP FIRST
      if (bars[k].l <= target) return stopBps * rr;
    } else {
      if (bars[k].l <= stop) return -stopBps;           // STOP FIRST
      if (bars[k].h >= target) return stopBps * rr;
    }
  }
  const last = bars[bars.length - 1].c;
  return (dir < 0 ? ((price - last) / price) : ((last - price) / price)) * 10000;
}

function scanDay(day) {
  const file = path.join(BARS, `bars-${day}.json.gz`);
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const syms = raw.symbols || {};
  const rows = [];
  for (const [sym, rec] of Object.entries(syms)) {
    if (sym.startsWith('999') || !rec.bars || rec.bars.length < 30) continue;
    const bars = toBars(rec.bars);
    const n = bars.length;
    const e20 = new Float64Array(n), e50 = new Float64Array(n), k20 = 2 / 21, k50 = 2 / 51;
    for (let i = 0; i < n; i++) {
      const c = bars[i].c;
      if (i === 0) { e20[0] = c; e50[0] = c; } else { e20[i] = c * k20 + e20[i - 1] * (1 - k20); e50[i] = c * k50 + e50[i - 1] * (1 - k50); }
    }
    let rHi = -Infinity, rLo = Infinity;
    for (let i = 0; i < 25; i++) { if (bars[i].h > rHi) rHi = bars[i].h; if (bars[i].l < rLo) rLo = bars[i].l; }
    let num = 0, den = 0;
    const firstOpen = bars[0].o || bars[0].c;
    const poc = new Map();
    for (let i = 25; i < n - 1; i++) {
      const b = bars[i], price = b.c;
      if (b.h > rHi) rHi = b.h;
      if (b.l < rLo) rLo = b.l;
      num += ((b.h + b.l + b.c) / 3) * b.v; den += b.v;
      const vwap = den > 0 ? num / den : price;
      const step = 0.10;
      const steps = Math.max(1, Math.round((b.h - b.l) / step) + 1);
      for (let q = Math.floor(b.l / step) * step; q <= b.h + 1e-9; q += step) {
        const kq = q.toFixed(2);
        poc.set(kq, (poc.get(kq) || 0) + b.v / steps);
      }
      if (b.min < ARM_A || b.min >= ARM_B) continue;

      const vd = ((price - vwap) / vwap) * 100;
      const dc = ((price - firstOpen) / firstOpen) * 100;
      const r5 = bars.slice(Math.max(0, i - 4), i + 1);
      const v5 = r5.reduce((s, x) => s + x.v, 0);
      const d5 = r5.reduce((s, x) => s + x.delta, 0);
      const deltaKnown = r5.some((x) => x.hasDelta);
      const deltaRatio = v5 > 0 ? d5 / v5 : 0;
      let pk = null, mv = -1;
      for (const [kq, v] of poc.entries()) if (v > mv) { mv = v; pk = parseFloat(kq); }
      const slice = bars.slice(0, i + 1);

      for (const dir of [-1, 1]) {
        // core gates — identical for every cohort, and no FVG requirement anywhere
        if (dir < 0) {
          if (!(price < vwap && vd <= -0.05 && vd >= -0.85 && dc < -0.3)) continue;
          if (!(price <= e20[i] && e20[i] <= e50[i])) continue;
          if (!(price >= rLo + 0.5 * (rHi - rLo))) continue;
          if (pk && pk < price && ((price - pk) / price) * 10000 <= 25) continue;
          if (deltaKnown && !(deltaRatio < -0.05)) continue;
        } else {
          if (!(price > vwap && vd >= 0.05 && vd <= 0.85 && dc > 0.3)) continue;
          if (!(price >= e20[i] && e20[i] >= e50[i])) continue;
          if (!(price <= rLo + 0.5 * (rHi - rLo))) continue;
          if (pk && pk > price && ((pk - price) / price) * 10000 <= 25) continue;
          if (deltaKnown && !(deltaRatio > 0.05)) continue;
        }

        // FVG state — the engine's own gap finder, LIVE gap only (dead gaps do not count)
        const gap = eng.findFvg(slice, dir);
        const live = !!(gap && !gap.dead);
        let cohort;
        if (!live) cohort = 'NO_FVG';
        else if (dir < 0) cohort = price >= gap.ce && price <= gap.top ? 'FVG_CE' : 'FVG_OTHER';
        else cohort = price <= gap.ce && price >= gap.bottom ? 'FVG_CE' : 'FVG_OTHER';

        const nets = {};
        for (const g of GEOMS) {
          const [stopBps, rr] = g.key.split('_').map(Number);
          nets[g.key] = resolve(bars, i, price, stopBps, rr, dir) - COST_BPS;
        }
        rows.push({ sym, dir, cohort, nets });
      }
    }
  }
  return rows;
}

function capPerSymbol(rows) {
  const seen = new Map();
  const out = [];
  for (const r of rows) {
    const k = r.sym + '|' + r.dir + '|' + r.cohort;
    if ((seen.get(k) || 0) >= 2) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
    out.push(r);
  }
  return out;
}

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function winRate(a) { return a.length ? a.filter((x) => x > 0).length / a.length : null; }

// Bootstrap the difference between two independent samples (95% percentile interval).
function bootstrapDiff(a, b, iters = 2000) {
  if (a.length < 3 || b.length < 3) return null;
  const diffs = [];
  for (let it = 0; it < iters; it++) {
    const ra = [], rb = [];
    for (let i = 0; i < a.length; i++) ra.push(a[Math.floor(Math.random() * a.length)]);
    for (let i = 0; i < b.length; i++) rb.push(b[Math.floor(Math.random() * b.length)]);
    diffs.push(mean(ra) - mean(rb));
  }
  diffs.sort((x, y) => x - y);
  return { lo: diffs[Math.floor(iters * 0.025)], hi: diffs[Math.floor(iters * 0.975)], point: mean(a) - mean(b) };
}

function analyse(label, days) {
  const rows = [];
  for (const d of days) for (const r of scanDay(d)) rows.push(r);
  const capped = capPerSymbol(rows);
  console.log('\n' + label + '  (' + capped.length + ' setups, capped 2/symbol/day/cohort)');
  const out = { label, cohorts: {} };
  for (const g of GEOMS) {
    console.log('  geometry ' + g.label);
    const byCohort = {};
    for (const c of ['FVG_CE', 'FVG_OTHER', 'NO_FVG']) {
      const v = capped.filter((r) => r.cohort === c).map((r) => r.nets[g.key]);
      byCohort[c] = v;
      console.log('    ' + c.padEnd(10) + ' n=' + String(v.length).padStart(4) +
        '  win ' + (v.length ? (winRate(v) * 100).toFixed(1) : '  0.0').padStart(5) + '%' +
        '  mean ' + (v.length ? mean(v).toFixed(1) : '  0.0').padStart(7) + ' bps');
    }
    const d1 = bootstrapDiff(byCohort.FVG_CE, byCohort.NO_FVG);
    const d2 = bootstrapDiff([...byCohort.FVG_CE, ...byCohort.FVG_OTHER], byCohort.NO_FVG);
    const fmt = (d) => d ? (d.point >= 0 ? '+' : '') + d.point.toFixed(1) + ' bps [95% CI ' +
      d.lo.toFixed(1) + ' .. ' + d.hi.toFixed(1) + ']' + (d.lo > 0 || d.hi < 0 ? '  SIGNIFICANT' : '  straddles zero') : 'n/a';
    console.log('    FVG_CE  minus NO_FVG : ' + fmt(d1));
    console.log('    ANY FVG minus NO_FVG : ' + fmt(d2));
    out.cohorts[g.key] = { d1, d2, byCohort };
  }
  return out;
}

console.log('FVG ELIMINATION TEST — measured cost ' + COST_BPS + ' bps round trip (Rs 50k, 4.5 bps spread)');
const older = analyse('OLDER 5 SESSIONS', OLDER5);
const past = analyse('PAST 5 SESSIONS', PAST5);

console.log('\n============================================================');
console.log('PRE-REGISTERED CHECK — FVG must beat NO_FVG, CI excluding zero on PAST, same sign on OLDER');
console.log('============================================================');
let pass = [];
for (const g of GEOMS) {
  const p = past.cohorts[g.key].d1, o = older.cohorts[g.key].d1;
  if (p && o) {
    const sig = p.lo > 0;
    const sameSign = (p.point > 0) === (o.point > 0);
    console.log('  ' + g.label.padEnd(20) + ' past ' + p.point.toFixed(1) + ' bps CI[' + p.lo.toFixed(1) + ',' + p.hi.toFixed(1) +
      ']  older ' + o.point.toFixed(1) + ' bps | ' + (sig && sameSign ? 'QUALIFIES' : 'does not qualify') +
      (sig ? '' : ' (past CI includes 0)') + (sameSign ? '' : ' (sign flips between sets)'));
    if (sig && sameSign) pass.push(g.label);
  }
}
console.log('\nVERDICT: ' + (pass.length
  ? 'FVG adds value at: ' + pass.join(', ')
  : 'the FVG cannot be shown to add anything over NO_FVG — it is not a discriminator on this tape.'));

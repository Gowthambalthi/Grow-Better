/**
 * gb_scoring_v2/institutional/backtest.js — DO THE INSTITUTIONAL LAYERS PREDICT ANYTHING?
 *
 * THE METHOD, AND WHY IT IS THIS ONE. The claim to test is not "here is a strategy that made money";
 * it is "this classification is INFORMATIVE". Those need different experiments, and the second one
 * is the harder to fake. A strategy can be tuned until it looks good; a conditional distribution
 * cannot, because it reports what happened after the state was observed rather than what a rule
 * would have done.
 *
 * So for every layer this measures CONDITIONAL FORWARD OUTCOMES:
 *
 *   * state is read from the FIRST HOUR only (09:15-10:15) — strictly no lookahead;
 *   * the outcome is measured over the REST OF THE SESSION (10:15 to the close);
 *   * every result is reported with its sample size, and a result under `minSamples` is labelled
 *     rather than ranked;
 *   * gross AND net are reported, with the same round-trip cost as every other study in this repo,
 *     because a classification that predicts direction but not enough of it to pay the spread is
 *     not an edge, it is an explanation.
 *
 * THE FOUR QUESTIONS
 *   1. BALANCE vs TREND. On a session whose first hour is one-sided, does the rest of the day
 *      CONTINUE in that direction? On a rotating first hour, does price MEAN-REVERT toward the
 *      first hour's value area? This is the fade-vs-follow decision, and it is the single read
 *      every retail stack skips.
 *   2. RELATIVE STRENGTH vs NIFTY. Do the names that led the index in the first hour keep leading
 *      it in the second half? Institutional rotation is supposed to persist; if it does not, the
 *      layer is folklore.
 *   3. TIME OF DAY. Where does the day's travel actually begin, measured per 30-minute bucket.
 *   4. PROFILE LOCATION. Does being above/below the PRIOR day's value area predict continuation,
 *      and does being INSIDE it predict rotation? (Acceptance vs rejection at the reference frame
 *      everyone else is using.)
 *
 * WHAT IT CANNOT TEST. Iceberg detection and true order-book absorption need trade-by-trade prints
 * with size; this feed is QUOTE mode. That layer is reported as UNMEASURED_FEED_LIMIT rather than
 * skipped quietly, so the gap stays visible instead of becoming an assumption.
 *
 * Usage: node gb_scoring_v2/institutional/backtest.js [--limit 300] [--cost 0.10]
 */
const fs = require('fs');
const path = require('path');
const L = require('./layers');

const ROOT = path.join(__dirname, '..', '..');
const DIR_1M = path.join(ROOT, 'data', 'ohlcv_1m');
const OUT_FILE = path.join(ROOT, 'data', 'institutional_layers.json');

function argOf(name, dflt) {
  const hit = process.argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
}

const COST_PCT = Number(argOf('cost', 0.10));
const LIMIT = Number(argOf('limit', 0)) || 0;
const FIRST_HOUR_END = L.SESSION_OPEN_MIN + 60;   // 10:15

// ---------- stats ----------
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function shareAbove(a, x) { return a.length ? a.filter(v => v > x).length / a.length : null; }
const r2 = (v) => (v == null ? null : +v.toFixed(4));
const r3 = (v) => (v == null ? null : +v.toFixed(3));

/** bucket a set of outcomes into a report with its sample size and a verdict. */
function report(label, outcomes, opts = {}) {
  const n = outcomes.length;
  const m = median(outcomes);
  const gross = mean(outcomes);
  const net = gross == null ? null : gross - COST_PCT;
  const hit = shareAbove(outcomes, 0);
  const minSamples = opts.minSamples || 200;
  let verdict;
  if (n < minSamples) verdict = 'TOO_FEW';
  else if (net == null || net <= 0) verdict = 'NO_EDGE';
  else if (net < COST_PCT) verdict = 'COST_ONLY';
  else verdict = 'EDGE';
  return {
    label, samples: n,
    medianPct: r3(m), meanPct: r3(gross), netOfCostPct: r3(net),
    hitRate: hit == null ? null : r2(hit),
    verdict,
    note: n < minSamples ? ('only ' + n + ' samples (need ' + minSamples + ')') : null,
  };
}

// ---------- data ----------
function loadSessions(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  const candles = j && Array.isArray(j.candles) ? j.candles : null;
  if (!candles) return null;
  return L.sessionsOf(candles);
}

// ---------- the study ----------
function main() {
  const files = fs.readdirSync(DIR_1M).filter(f => f.endsWith('.json'));
  const niftyFile = path.join(DIR_1M, 'NIFTY.json');
  const nifty = fs.existsSync(niftyFile) ? loadSessions(niftyFile) : null;
  const symbols = LIMIT ? files.slice(0, LIMIT) : files;

  console.log('\n=== INSTITUTIONAL LAYERS — NSE 1m, ' + COST_PCT + '% round trip, ' + symbols.length + ' files ===');
  console.log('state is read from 09:15-10:15 ONLY; the outcome is measured from 10:15 to the close.\n');

  // ---- 1. balance vs trend
  const trendCont = [];    // continue in the first hour's direction
  const trendFade = [];    // rotate back toward the first hour's open
  const balCont = [];
  const balFade = [];
  // ---- 2. relative strength
  const rsTop = [], rsBottom = [], rsMid = [];
  const rsAll = [];
  // ---- 4. prior value area location
  const aboveVA = [], insideVA = [], belowVA = [];
  // ---- 3. time of day
  const todCols = [];
  const profileModes = { TREND_UP: 0, TREND_DOWN: 0, BALANCE: 0 };

  let scanned = 0, sessionsSeen = 0, skipped = 0;

  for (const f of symbols) {
    const sym = f.replace(/\.json$/, '');
    if (sym === 'NIFTY') continue;
    const sessions = loadSessions(path.join(DIR_1M, f));
    if (!sessions) { skipped++; continue; }
    scanned++;
    const days = [...sessions.keys()].sort();

    for (let d = 0; d < days.length; d++) {
      const rows = sessions.get(days[d]);
      if (!rows || rows.length < 200) { skipped++; continue; }
      sessionsSeen++;
      const first = rows.filter(r => r.mins < FIRST_HOUR_END);
      const second = rows.filter(r => r.mins >= FIRST_HOUR_END);
      if (first.length < 40 || second.length < 40) { skipped++; continue; }

      const fhi = Math.max(...first.map(r => r.h));
      const flo = Math.min(...first.map(r => r.l));
      const fOpen = first[0].o, fClose = first[first.length - 1].c;
      const fRange = fhi - flo;
      if (!(fRange > 0)) continue;
      const r1 = ((fClose - fOpen) / fOpen) * 100;

      // no-lookahead state reads
      const shape = L.profileShape(first);
      if (!shape) continue;
      profileModes[shape.mode] = (profileModes[shape.mode] || 0) + 1;

      // outcome: where the rest of the session went FROM THE 10:15 CLOSE
      const sClose = second[second.length - 1].c;
      const fwdPct = ((sClose - fClose) / fClose) * 100;
      const continuation = Math.sign(r1) * fwdPct;         // positive = the morning move kept going
      const rotation = -Math.sign(r1) * fwdPct;            // positive = it came back

      if (shape.mode === 'TREND_UP' || shape.mode === 'TREND_DOWN') {
        trendCont.push(continuation); trendFade.push(rotation);
      } else {
        balCont.push(continuation); balFade.push(rotation);
      }

      // ---- relative strength vs NIFTY over the SAME window
      const nRows = nifty && nifty.get(days[d]);
      if (nRows && nRows.length > 100) {
        const nFirst = nRows.filter(r => r.mins < FIRST_HOUR_END);
        if (nFirst.length > 20 && nFirst[0].o > 0) {
          const nRet = ((nFirst[nFirst.length - 1].c - nFirst[0].o) / nFirst[0].o) * 100;
          const rs = L.relativeStrength(r1, nRet, 1);
          if (rs) rsAll.push({ sym, day: days[d], excess: rs.excess, fwd: fwdPct, strength: rs.strength });
        }
      }

      // ---- prior value area location
      const prev = d > 0 ? sessions.get(days[d - 1]) : null;
      if (prev && prev.length > 100) {
        const pl = L.priorLevels(prev);
        if (pl && pl.vah != null && pl.val != null) {
          const bucket = fClose > pl.vah ? aboveVA : fClose < pl.val ? belowVA : insideVA;
          bucket.push(fwdPct);
        }
      }

      // ---- time of day: range that BEGINS in each bucket
      const totalRange = Math.max(...rows.map(r => r.h)) - Math.min(...rows.map(r => r.l));
      if (totalRange > 0) {
        for (let i = 0; i < 13; i++) {
          const startMin = L.SESSION_OPEN_MIN + i * 30;
          const idx = rows.findIndex(r => r.mins >= startMin);
          if (idx < 0) continue;
          const entry = rows[idx].o;
          if (!(entry > 0)) continue;
          let h2 = -Infinity, l2 = Infinity;
          for (let j = idx; j < rows.length; j++) { if (rows[j].h > h2) h2 = rows[j].h; if (rows[j].l < l2) l2 = rows[j].l; }
          if (!todCols[i]) todCols[i] = [];
          todCols[i].push((h2 - l2) / totalRange);
        }
      }
    }
  }

  // ---- relative strength: split by TERCILE of excess, since a threshold invented by hand would
  // be a tuned parameter and this study is about whether the ordering matters at all.
  if (rsAll.length) {
    const sorted = rsAll.slice().sort((a, b) => a.excess - b.excess);
    const cut = Math.floor(sorted.length / 3);
    const bottom = sorted.slice(0, cut);
    const top = sorted.slice(sorted.length - cut);
    const mid = sorted.slice(cut, sorted.length - cut);
    for (const x of top) rsTop.push(x.fwd);
    for (const x of mid) rsMid.push(x.fwd);
    for (const x of bottom) rsBottom.push(x.fwd);
  }

  const todRaw = todCols.map(c => median(c));
  const todFirst = todRaw[0] || 1;
  const todWeights = todRaw.map(v => (v == null ? null : r3(v / todFirst)));

  const layers = [
    Object.assign({ layer: 'profileTrendDay', question: 'TREND-flagged first hour: does the rest of the day CONTINUE?', direction: 'with the morning move' },
      report('trend → continuation', trendCont)),
    Object.assign({ layer: 'profileBalanceDay', question: 'BALANCE-flagged first hour: does price ROTATE back?', direction: 'against the morning move' },
      report('balance → rotation', balFade)),
    Object.assign({ layer: 'profileTrendFade', question: 'control: following a TREND flag by fading it', direction: 'against the morning move' },
      report('trend → rotation', trendFade)),
    Object.assign({ layer: 'profileBalanceCont', question: 'control: following a BALANCE flag by continuing it', direction: 'with the morning move' },
      report('balance → continuation', balCont)),
    Object.assign({ layer: 'relativeStrengthTop', question: 'top third by excess return vs NIFTY in hour one: does it keep leading?', direction: 'long' },
      report('RS top third → forward return', rsTop)),
    Object.assign({ layer: 'relativeStrengthBottom', question: 'bottom third by excess return vs NIFTY: does it keep lagging?', direction: 'short' },
      report('RS bottom third → forward return (SHORT it)', rsBottom.map(v => -v))),
    Object.assign({ layer: 'relativeStrengthMid', question: 'control: the middle third, which has no rotation signal', direction: 'none' },
      report('RS middle third → forward return', rsMid)),
    Object.assign({ layer: 'priorValueAcceptance', question: 'first hour above YESTERDAY\'s value area: continuation?', direction: 'long' },
      report('above prior VAH → forward return', aboveVA)),
    Object.assign({ layer: 'priorValueRejection', question: 'first hour below YESTERDAY\'s value area: continuation down?', direction: 'short' },
      report('below prior VAL → forward return (SHORT it)', belowVA.map(v => -v))),
    Object.assign({ layer: 'priorValueRotation', question: 'first hour INSIDE yesterday\'s value area: rotation or nothing?', direction: 'none' },
      report('inside prior value → forward return', insideVA)),
    {
      layer: 'tapeIcebergAbsorption',
      question: 'hidden size replenishing a level / size absorbed without price progress',
      samples: 0,
      verdict: 'UNMEASURED_FEED_LIMIT',
      note: 'needs trade-by-trade prints with size; this feed is Angel QUOTE mode (best bid/ask quantity and running totals only). The order-flow engine measures the absorption half from what the feed can support; iceberg REPLENISHMENT is not identifiable from it.',
    },
  ];

  const ranked = layers.slice().sort((a, b) => {
    const av = a.netOfCostPct == null ? -Infinity : a.netOfCostPct;
    const bv = b.netOfCostPct == null ? -Infinity : b.netOfCostPct;
    return bv - av;
  });
  ranked.forEach((l, i) => { l.rank = i + 1; });

  const withEdge = ranked.filter(l => l.verdict === 'EDGE');
  const out = {
    generatedAt: new Date().toISOString(),
    method: 'state read from 09:15-10:15 only; outcome measured from the 10:15 close to the session close; no lookahead; median, mean, hit rate and net-of-cost all reported with sample size',
    costPct: COST_PCT,
    symbolsScanned: scanned,
    sessionsMeasured: sessionsSeen,
    skipped,
    profileModes,
    layers: ranked,
    timeOfDay: {
      note: 'share of the session range that BEGINS in each 30-minute bucket, normalised to the first bucket. This is the measured basis for the confidence multiplier in layers.js.',
      rawByBucket: todRaw.map(r3),
      weightsByBucket: todWeights,
    },
    best: withEdge.length ? withEdge[0].layer : null,
    established: withEdge.length ? withEdge.map(l => l.layer) : null,
    summary: withEdge.length
      ? withEdge.length + ' layer(s) cleared the round-trip cost on this tape: ' + withEdge.map(l => l.layer).join(', ')
      : 'NOTHING cleared the round-trip cost. Every layer that predicted a direction did so by less than ' + COST_PCT + '%, which is the same result the ROC stack produced.',
  };

  try {
    fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  } catch (e) { console.error('could not write ' + OUT_FILE + ': ' + e.message); }

  console.log('symbols ' + scanned + ' · sessions ' + sessionsSeen + ' · skipped ' + skipped);
  console.log('first-hour modes: ' + JSON.stringify(profileModes));
  console.log('\nrank | layer                          | n      | median   | mean     | net      | hit%   | verdict');
  for (const l of ranked) {
    console.log(
      String(l.rank).padEnd(4) + ' | ' + l.layer.padEnd(30) + ' | '
      + String(l.samples).padEnd(6) + ' | ' + String(l.medianPct).padEnd(8) + ' | '
      + String(l.meanPct).padEnd(8) + ' | ' + String(l.netOfCostPct).padEnd(8) + ' | '
      + String(l.hitRate == null ? '-' : (l.hitRate * 100).toFixed(1)).padEnd(6) + ' | ' + l.verdict
    );
  }
  console.log('\ntime of day (share of the session range beginning in each bucket):');
  console.log('  ' + todWeights.map((w, i) => (L.SESSION_OPEN_MIN + i * 30) + ':' + w).join('  '));
  console.log('\n' + out.summary);
  console.log('\nwritten to ' + OUT_FILE);
}

if (require.main === module) main();

module.exports = { report, main, OUT_FILE, FIRST_HOUR_END };

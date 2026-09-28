/**
 * gb_scoring_v2/raschke/headToHead.js — THE OLD ENGINE vs THE NEW FRAMEWORK, ON THE SAME BARS.
 *
 * This is the comparison the deletion decision rests on, so three rules keep it honest:
 *
 *   1. THE OLD ENGINE IS ITS OWN CODE. The committed file cannot be the one replayed: `git show
 *      HEAD:common/market/liveCallEngine.js` is a 1067-line ancestor with no `rocSignal` and no
 *      `confluence`, while the engine that produced this week's calls is the 2709-line working-tree
 *      file (1740 uncommitted lines). Replaying HEAD would compare the new framework against a
 *      retired engine and flatter it. .freebuff/freeze-old-engine.js therefore freezes the engine
 *      actually in use, proves the two edits it makes are the only ones, and this file requires it
 *      so the calls are `computeRoc` and `rocSignal` exactly as they run in production.
 *
 *   2. BOTH BOOKS USE THE SAME RISK PLACEMENT. Every signal from either engine is turned into a
 *      trade by the SAME structural plan builder (the swing that invalidates the idea) and the SAME
 *      simulator, with the pessimistic intrabar assumption (stop first when a bar touches both).
 *      So the difference measured is ENTRY SELECTION, which is what a decision function is for.
 *
 *   3. THE VERDICT IS COMPUTED, NOT NARRATED. The kill criterion is read from the pre-registered,
 *      hashed config and evaluated mechanically, including the case where a condition cannot be
 *      evaluated at all — which is reported as such rather than quietly dropped.
 *
 * Usage: node gb_scoring_v2/raschke/headToHead.js [--limit=N] [--cost=0.10]
 */
const fs = require('fs');
const path = require('path');
const IND = require('./indicators');
const S = require('./setups');
const BT = require('./backtest');
// NOTE: '../config' would resolve to gb_scoring_v2/config.js (a different module, different keys) —
// the versioned config with the pre-registration lives in the directory.
const { CONFIG, hash: configHash } = require('../config/index');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'ohlcv_1m');
const DAY = path.join(ROOT, 'data', 'ohlcv');
const OUT = path.join(ROOT, 'data', 'v2_sessions', 'head_to_head_' + new Date().toISOString().slice(0, 10) + '.json');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const LIMIT = Number(argOf('limit', 0)) || 0;
const COST = Number(argOf('cost', BT.COST_PCT));
const SWING = S.DEF.swingLookback;
const WARM = 20;                      // bars before either engine is asked (the old engine's own floor)

// --- the frozen old engine, kept in the file, required by name ------------------------------------
const FROZEN = path.join(ROOT, '.freebuff', 'frozen', 'liveCallEngine.frozen.js');
if (!fs.existsSync(FROZEN)) require(path.join(ROOT, '.freebuff', 'freeze-old-engine.js'));
const OLD = require(FROZEN);
if (typeof OLD.computeRoc !== 'function' || typeof OLD.rocSignal !== 'function') {
  throw new Error('frozen old engine is missing computeRoc/rocSignal — refusing to run a comparison against the wrong code');
}

/** previous session's close, for the old engine's day-change read. */
function prevCloseOf(symbol, sessionIso) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DAY, symbol + '.json'), 'utf8'));
    const rows = j.candles || j.bars || (Array.isArray(j) ? j : []);
    let best = null;
    for (const r of rows) {
      const d = String(r[0]).slice(0, 10);
      if (d < sessionIso) best = +r[4];
    }
    return best;
  } catch (e) { return null; }
}

/**
 * the same structural stop rule for both engines: the swing that invalidates the idea.
 *
 * THE SIDE GOES THROUGH BT.sideSign, NOT A STRING COMPARISON. `side === 'BUY' ? sw.low : sw.high`
 * silently treats EVERY other label as a short — which is exactly how the liquiditySweep row was
 * fabricated (a long labelled 'LONG' resolved as a short and booked a constant +1.00R,
 * .freebuff/verify-side-bug.js). A label this harness cannot resolve now returns null, so the
 * candidate is dropped and counted rather than reversed.
 */
function structuralStop(bars, i, side) {
  const dir = BT.sideSign(side);
  if (!dir) return null;
  const sw = IND.swings(bars, i, SWING);
  const stop = dir === 1 ? sw.low : sw.high;
  if (stop == null) return null;
  return S.planForSetup({ setup: 'X', side, entry: bars[i].c, stop });
}

function newCandidates(bars, ctx, i) {
  const raw = S.candidatesAt(bars, ctx, i, {});
  return raw.map((c) => Object.assign({}, c, { engine: 'NEW' }));
}

function oldCandidates(bars, dayBars, i, prevClose) {
  const series = { bars: dayBars, prevClose };
  let roc;
  try { roc = OLD.computeRoc(series, null); } catch (e) { return [{ error: e.message }]; }
  if (!roc) return [];
  let sig;
  try { sig = OLD.rocSignal(roc, bars[i].c, null, false, null, {}); } catch (e) { return [{ error: e.message }]; }
  if (!sig || !sig.signal) return [];
  const side = sig.signal === 'BUY' ? 'BUY' : sig.signal === 'SHORT' ? 'SELL' : null;
  if (!side) return [];
  const plan = structuralStop(bars, i, side);
  if (!plan) return [];
  return [Object.assign({}, plan, { setup: 'OLD-ENGINE', engine: 'OLD', oldSignal: sig.signal, oldReason: sig.reason || null, oldScore: sig.conf != null ? sig.conf : null })];
}

function summarise(rows) {
  const r = rows.map((x) => x.R);
  const f5 = rows.map((x) => x.f5adj).filter((v) => v != null);
  const stopFirst = rows.filter((x) => /stop/.test(x.reason)).length;
  const sessions = {};                       // session -> [R] (what sessionCI resamples)
  const byDay = {};                          // session -> [row]
  for (const x of rows) {
    (sessions[x.session] = sessions[x.session] || []).push(x.R);
    (byDay[x.session] = byDay[x.session] || []).push(x);
  }
  const dayList = Object.keys(sessions);
  const posDays = dayList.filter((d) => BT.mean(sessions[d]) > 0).length;
  return {
    trades: rows.length,
    winRate: rows.length ? +(rows.filter((x) => x.R > 0).length / rows.length).toFixed(3) : null,
    meanR: rows.length ? +BT.mean(r).toFixed(3) : null,
    meanF5: f5.length ? +BT.mean(f5).toFixed(4) : null,
    stopBeforeTargetRate: rows.length ? +(stopFirst / rows.length).toFixed(3) : null,
    sessions: dayList.length,
    positiveSessions: posDays,
    rCI: BT.sessionCI(sessions),
    perSession: dayList.sort().map((d) => ({ session: d, trades: byDay[d].length, meanR: +BT.mean(sessions[d]).toFixed(3), meanF5: +((BT.mean(byDay[d].map((x) => x.f5adj).filter((v) => v != null)) || 0)).toFixed(4) })),
  };
}

function main() {
  let files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'NIFTY.json').sort();
  if (LIMIT) files = files.slice(0, LIMIT);
  const nifty = BT.niftySeries();
  console.log('head-to-head · symbols ' + files.length + ' · cost ' + COST + '% · frozen old engine in use');

  const newRows = [], oldRows = [], overlap = [];
  let oldErrors = 0, barsCompared = 0;
  const t0 = Date.now();

  for (const f of files) {
    const symbol = f.replace(/\.json$/, '');
    const j = BT.load(symbol);
    if (!j) continue;
    const raw = j.candles;
    const bars = IND.norm(raw);
    if (bars.length < 200) continue;
    const ctx = S.buildContext(bars);
    // session blocks
    let start = 0;
    for (let i = 1; i <= bars.length; i++) {
      if (i === bars.length || String(raw[i][0]).slice(0, 10) !== String(raw[start][0]).slice(0, 10)) {
        const session = String(raw[start][0]).slice(0, 10);
        if (i - start > 60) {
          const prevClose = prevCloseOf(symbol, session);
          let busyNew = -1, busyOld = -1;
          for (let k = start + WARM; k < i - 2; k++) {
            barsCompared++;
            const dayBars = [];
            for (let d = start; d <= k; d++) dayBars.push({ t: raw[d][0], o: raw[d][1], h: raw[d][2], l: raw[d][3], c: raw[d][4], v: raw[d][5] });
            const oc = oldCandidates(bars, dayBars, k, prevClose);
            if (oc.length && oc[0].error) { oldErrors++; }
            const nc = k > busyNew ? newCandidates(bars, ctx, k) : [];
            const oldPick = oc.length && oc[0].engine ? oc[0] : null;

            const take = (cand, which) => {
              const r = BT.simulate(raw, k, cand, COST);
              if (!r) return null;
              const fr = BT.forwardReturn(raw, k, 5, nifty);
              // the same rule the simulator applies: a side it cannot resolve is not signed as a short
              const sign = BT.sideSign(cand.side);
              if (!sign) return null;
              return Object.assign({ symbol, session, at: raw[k][0], side: cand.side, setup: cand.setup, reason: r.reason, R: r.R, netPct: r.netPct, riskPct: r.riskPct, f5adj: fr ? fr.adjusted * sign : null, engine: which });
            };
            const nT = nc.length && k > busyNew ? take(nc[0], 'NEW') : null;
            const oT = oldPick && k > busyOld ? take(oldPick, 'OLD') : null;
            if (nT) { newRows.push(nT); busyNew = k + 2; }
            if (oT) { oldRows.push(oT); busyOld = k + 2; }
            if (nT && oT && nT.side === oT.side) overlap.push({ session, symbol, side: nT.side, Rnew: nT.R, Rold: oT.R, f5new: nT.f5adj, f5old: oT.f5adj });
          }
        }
        start = i;
      }
    }
  }

  const NEW = summarise(newRows), OLD = summarise(oldRows);
  const overlapF5 = (which) => BT.mean(overlap.map((o) => which === 'new' ? o.f5new : o.f5old).filter((v) => v != null));
  const overlapR = (which) => BT.mean(overlap.map((o) => which === 'new' ? o.Rnew : o.Rold));

  // ---- the pre-registered kill criterion, evaluated mechanically ----
  const KC = CONFIG.preRegistration.killCriterion;
  const sameSide = { n: overlap.length, newF5: overlapF5('new') != null ? +overlapF5('new').toFixed(4) : null, oldF5: overlapF5('old') != null ? +overlapF5('old').toFixed(4) : null };
  const checks = {
    // K1 is evaluated on the IDENTICAL EPISODES — the bars where both engines took the same side —
    // as the rule literally states. Each engine's own book is printed beside it as the secondary
    // read, because that is what a trader would actually have been holding.
    K1: {
      rule: KC.K1, unit: 'same-side overlap episodes', episodes: sameSide.n,
      newMeanF5: sameSide.newF5, oldMeanF5: sameSide.oldF5,
      ownBookNewF5: NEW.meanF5, ownBookOldF5: OLD.meanF5,
      pass: sameSide.n >= 50 && sameSide.newF5 != null && sameSide.oldF5 != null ? sameSide.newF5 >= sameSide.oldF5 : null,
      note: sameSide.n < 50 ? 'too few same-side episodes in this sample to judge K1 on' : 'judged on the overlap set; the own-book means are reported alongside',
    },
    K2: { rule: KC.K2, newStopRate: NEW.stopBeforeTargetRate, oldStopRate: OLD.stopBeforeTargetRate, pass: NEW.stopBeforeTargetRate != null && OLD.stopBeforeTargetRate != null ? NEW.stopBeforeTargetRate < OLD.stopBeforeTargetRate : null },
    K3: { rule: KC.K3, pass: null, note: 'NOT EVALUABLE in this cycle: the delta layer lives in the order-flow gate, and this harness replays the price/context setups, which do not use it. By the AND rule this alone forces INCONCLUSIVE.' },
    K4: { rule: KC.K4, newPositiveSessions: NEW.positiveSessions, newSessions: NEW.sessions, pass: NEW.sessions ? NEW.positiveSessions * 2 > NEW.sessions : null },
    minSessions: { required: KC.minSessions, have: Math.min(NEW.sessions, OLD.sessions), pass: Math.min(NEW.sessions, OLD.sessions) >= KC.minSessions },
  };
  const allPass = ['K1', 'K2', 'K3', 'K4'].every((k) => checks[k].pass === true) && checks.minSessions.pass;
  const anyFail = ['K1', 'K2', 'K4'].some((k) => checks[k].pass === false);
  const verdict = allPass ? 'PASS' : anyFail ? 'FAIL' : 'INCONCLUSIVE';

  const report = {
    at: new Date().toISOString(), cost: COST, symbols: files.length, barsCompared, oldEngineErrors: oldErrors,
    configHash: configHash, preRegistered: { lockedAt: CONFIG.preRegistration.lockedAt, killCriterion: KC },
    newEngine: NEW, oldEngine: OLD, overlapSameSide: sameSide,
    checks, verdict,
    caveats: [
      'One vendor, one bar size (1m), 21 sessions; the V3 spec asks for 15+ and this has them, but all from 2026-08/09 only.',
      "Today's filtered universe only — survivorship and selection bias are not measured.",
      'No ticks: intrabar order is unknowable, so every ambiguity is resolved against the trade (stop first).',
      'The old engine here is its DECISION FUNCTION on 1m bars, not its scan cadence: its live book also passes liquidity/phone/watchlist filters this harness does not replay.',
      'The old engine\'s own stop was applied as the same structural swing, so this measures entry selection, not risk placement.',
      'The old engine runs here WITHOUT its live tick read, order-flow tickets, route/phone/watchlist filters and scan cadence — the replay gives it its decision function and nothing else. That handicaps it, so a FAIL for the new engine is the robust reading: the new framework did not beat a handicapped old one.',
      'The new engine here is the Raschke price/context framework, NOT the full rehost conjunction (OF gate + V3 veto): V3 evidence cannot be replayed from 1m bars. K3 stays unevaluated until the order-flow gate is replayed against real ticks.',
    ],
  };

  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); } catch (e) { console.log('write failed: ' + e.message); }

  const line = (name, s) => console.log(name + ': trades ' + s.trades + ' · mean R ' + s.meanR + ' · win ' + (s.winRate * 100).toFixed(1) + '% · stop-before-target ' + (s.stopBeforeTargetRate * 100).toFixed(1) + '% · mean signed +5m ' + s.meanF5 + '% · positive sessions ' + s.positiveSessions + '/' + s.sessions + (s.rCI ? ' · R CI [' + s.rCI.lo + ', ' + s.rCI.hi + ']' : ''));
  console.log('\n=== HEAD TO HEAD (identical bars, identical risk rule, cost ' + COST + '%) ===');
  line('NEW (Raschke framework)', NEW);
  line('OLD (liveCallEngine)     ', OLD);
  console.log('same-side overlap episodes: ' + sameSide.n + ' · new +5m ' + sameSide.newF5 + '% vs old ' + sameSide.oldF5 + '% · new mean R ' + (overlapR('new') != null ? overlapR('new').toFixed(3) : null) + ' vs old ' + (overlapR('old') != null ? overlapR('old').toFixed(3) : null));
  console.log('bars compared ' + barsCompared + ' · old-engine errors ' + oldErrors + ' · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('\n=== PRE-REGISTERED KILL CRITERION (locked ' + CONFIG.preRegistration.lockedAt + ') ===');
  for (const k of ['K1', 'K2', 'K3', 'K4']) console.log('  ' + k + ' ' + (checks[k].pass === true ? 'PASS' : checks[k].pass === false ? 'FAIL' : 'NOT EVALUABLE') + ' — ' + checks[k].rule + (checks[k].note ? ' [' + checks[k].note + ']' : ''));
  console.log('  minSessions ' + (checks.minSessions.pass ? 'PASS' : 'FAIL') + ' (' + checks.minSessions.have + ' of ' + checks.minSessions.required + ')');
  console.log('\nVERDICT: ' + verdict + ' — ' + CONFIG.preRegistration.outcomes[verdict]);
  console.log('written: ' + OUT);
}

main();

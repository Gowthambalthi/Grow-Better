/**
 * strategy-core/strategyLedger.js — THE POSITIVE / NEGATIVE LEDGER.
 *
 * WHY THIS FILE EXISTS. "Which strategies actually make money after cost?" was
 * answered in five different places (the board's `rules` panel, the research
 * sweep's markdown, the C1 report, the OR1 page) and nowhere as ONE answer. A
 * strategy that is net POSITIVE at one round-trip cost can be net NEGATIVE at
 * another — FVG is 1.012 at 0.05% and 0.822 at 0.10% — so "positive" without a
 * stated cost is not a fact about the strategy, it is a fact about the sentence.
 *
 * The ledger therefore keeps the rule and the cost in the SAME object as the
 * verdict, so a positive row can always be read back to the number that made it
 * positive and the cost that number was measured at.
 *
 * THE RULE, IN ONE LINE: a strategy is POSITIVE when its measured NET profit
 * factor (gross wins / gross losses, after the round-trip cost) is STRICTLY
 * greater than 1. Anything else — a PF at or below 1, a PF that was never
 * measured, or no resolved trades at all — is NEGATIVE. Nothing is "unknown":
 * an unmeasured strategy is a strategy with no earned record, and it is filed
 * where it belongs rather than given a third bucket that hides it.
 *
 * `maySpeak` is a STRICTER, SEPARATE gate (the board's own: net PF >= 1.5 AND
 * >= 30 resolved trades). A strategy can be net-positive and still silent, and
 * that is the normal state here: ORDERFLOW is +8.02R at 0.05% and still under
 * the 30-trade floor, so it is positive and silent. Telegram carries the
 * POSITIVE rows; the speak gate is what decides whether a row may name a
 * direction. The two are deliberately not the same threshold.
 *
 * EVERY SOURCE IS READ, NOTHING IS RE-DERIVED. The numbers come from the files
 * that already measured them (`board.json` rules at 0.05%, `backtest_results.json`
 * bySetup + cost ladder, `intraday_strategy_report.json` at 0.07% over the locked
 * LEARNING manifest, `c1_gapgo_report.json`, `or1_signals.json`). This module
 * performs no backtest and reads no candle: it classifies records that exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// The ONE engine registry (strategy-core/engines.js) — so the ledger names the
// same file and the same setups the harness, the board and the server name.
const { BY_KEY: REGISTRY, ENGINES: REG_LIST, measuredRules } = require('./engines');

const ROOT = path.resolve(__dirname, '..');
const P = (...a) => path.join(ROOT, ...a);

const FILES = {
  board: P('data', 'terminal', 'board.json'),
  engines: P('data', 'terminal', 'backtest_results.json'),
  research: P('data', 'terminal', 'intraday_strategy_report.json'),
  candidate: P('data', 'terminal', 'c1_gapgo_report.json'),
  shadow: P('public', 'data', 'or1_signals.json'),
  history: P('data', 'terminal', 'strategy_ledger_history.json'),
};

/**
 * THE ONE THRESHOLD, IN NET. Strictly above ZERO: "breakeven" earns nothing, so
 * it is not positive. This is the decider; the PF line below is the SAME rule read
 * as a ratio, kept only so a source that publishes nothing but a profit factor can
 * still be decided by this one rule instead of a second one.
 */
const POSITIVE_ABOVE_NET_R = 0;
/** net PF > 1  <=>  net R > 0. The equivalent reading, for PF-only sources. */
const POSITIVE_ABOVE_PF = 1;
/** The board's speak gate — net PF >= 1.0 allows positive strategies to speak and alert. */
const SPEAK_NET_PF = process.env.GB_MIN_NET_PF ? Number(process.env.GB_MIN_NET_PF) : 1.0;
const SPEAK_MIN_TRADES = process.env.GB_MIN_TUNED_TRADES ? Number(process.env.GB_MIN_TUNED_TRADES) : 0;
/** How many daily snapshots to keep. One per session, ~250 sessions a year. */
const HISTORY_CAP = 400;

const RULE_TEXT = 'POSITIVE = measured NET R > 0 after the stated round-trip cost — the money KEPT, not a ratio. '
  + 'NEGATIVE = net R <= 0, net PF <= 1, unmeasured, or no resolved trades. '
  + 'maySpeak (net PF >= ' + SPEAK_NET_PF + ' and >= ' + SPEAK_MIN_TRADES + ' trades) allows positive strategies to emit live calls. '
  + 'Telegram carries the POSITIVE rows only.';

function readJSON(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function istDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const IST = 330 * 60000;
  return new Date(d.getTime() + (d.getTimezoneOffset() * 60000) + IST).toISOString().slice(0, 10);
}

function num(v) { return (v == null || isNaN(v)) ? null : Number(v); }
function r3(v) { return num(v) == null ? null : Number(Number(v).toFixed(3)); }

/**
 * THE VERDICT, IN NET. Pure and total on purpose: every (netR, trades, netPF)
 * triple gets one of exactly two answers, so no row can be silently dropped.
 *
 * WHY NET AND NOT PF. A profit factor is a RATIO, and a ratio cannot tell a large
 * edge from a rounding error: PF 1.012 on 48 trades and PF 1.5 on 3 trades read as
 * "more positive" and "less positive", and neither number says how much money the
 * strategy kept. The board shows NET — the R-multiple P&L actually earned after
 * cost — and decides on it. `netR` is preferred; a source that publishes only a
 * profit factor is still decided by the equivalent line (net PF > 1 <=> net R > 0)
 * and says so in its own reason, rather than being classified by a second rule.
 */
function judge(netR, trades, netPF) {
  const t = num(trades);
  const r = num(netR);
  const pf = num(netPF);
  const nT = t + (Number(t) === 1 ? ' trade' : ' trades');
  if (!t) return { classification: 'negative', reason: 'no resolved trades — nothing was measured, so nothing was earned' };
  if (r != null) {
    return r > POSITIVE_ABOVE_NET_R
      ? { classification: 'positive', reason: 'net +' + r.toFixed(3) + 'R after cost — ' + nT }
      : { classification: 'negative', reason: 'net ' + r.toFixed(3) + 'R after cost — nothing kept (' + nT + ')' };
  }
  if (pf != null) {
    return pf > POSITIVE_ABOVE_PF
      ? { classification: 'positive', reason: 'net PF ' + pf.toFixed(3) + ' > 1 after cost (this source publishes no net R) — ' + nT }
      : { classification: 'negative', reason: 'net PF ' + pf.toFixed(3) + ' <= 1 after cost (this source publishes no net R) — ' + nT };
  }
  return { classification: 'negative', reason: 'no net R or profit factor recorded for ' + nT };
}

/**
 * THE COST UNIT, ONCE AND FOR ALL: `costPct` is ALREADY A PERCENT.
 * 0.05 means 0.05% round trip (= 5 bp), NOT 5%. Every source on disk uses that
 * unit (board.json rules `costPct: 0.05`, the research report's
 * `costSensitivityPctByRoundTrip` keys) and so does the board's own existing
 * history panel (`SNAP.performance.window.costPct.toFixed(2) + '%'`). The two
 * files that store basis points (C1, OR1) are divided by 100 on the way in, here,
 * so a renderer never has to ask which unit it is holding.
 */

/** The cost ladder an engine was measured over, as {costPct -> record}. */
function ladderFrom(byCost) {
  if (!byCost || typeof byCost !== 'object') return [];
  return Object.keys(byCost).sort((a, b) => Number(a) - Number(b)).map((k) => ({
    costPct: Number(k),
    trades: num(byCost[k].trades),
    winPct: num(byCost[k].winPct),
    netPF: r3(byCost[k].netPF),
    netR: r3(byCost[k].netR),
    expectancyR: r3(byCost[k].expectancyR),
    verdict: judge(byCost[k].netR, byCost[k].trades, byCost[k].netPF).classification,
  }));
}

/** A bounded copy of a measured block — the detail view prints it whole. */
function statBlock(m) {
  if (!m) return null;
  return {
    trades: num(m.trades), winPct: num(m.winPct), netPF: r3(m.netPF), grossPF: r3(m.grossPF),
    netR: r3(m.netR), expectancyR: r3(m.expectancyR), medianR: r3(m.medianR),
    avgWinR: r3(m.avgWinR), avgLossR: r3(m.avgLossR),
    t1Pct: num(m.t1Pct), t2Pct: num(m.t2Pct), stopPct: num(m.stopPct), expiredPct: num(m.expiredPct),
    sessionEndPct: num(m.sessionEndPct), sessions: num(m.sessions), avgHoldBars: r3(m.avgHoldBars),
    maxDDR: r3(m.maxDDR),
    long: m.long ? { trades: num(m.long.trades), winPct: num(m.long.winPct), netPF: r3(m.long.netPF), netR: r3(m.long.netR), expectancyR: r3(m.long.expectancyR) } : null,
    short: m.short ? { trades: num(m.short.trades), winPct: num(m.short.winPct), netPF: r3(m.short.netPF), netR: r3(m.short.netR), expectancyR: r3(m.short.expectancyR) } : null,
  };
}

/** The live record for one engine, from the board snapshot's `performance`. */
function liveFor(perf, engine) {
  if (!perf || !Array.isArray(perf.engines)) return null;
  const e = perf.engines.find((x) => x.engine === engine);
  if (!e) return null;
  const pick = (m) => (m && m.trades != null
    ? { trades: num(m.trades), winPct: num(m.winPct), netR: r3(m.netR), expectancyR: r3(m.expectancyR), verdict: judge(m.netR, m.trades, m.netPF) }
    : { trades: 0, winPct: null, netR: null, expectancyR: null, verdict: 'no record', note: (m && m.note) || null });
  return {
    scope: 'engine',
    window: Object.assign({ from: perf.window.from, to: perf.window.to, sessions: num(perf.window.sessions), symbols: num(perf.window.symbols), costPct: num(perf.window.costPct) }, pick(e.window)),
    today: Object.assign({ session: perf.window.to }, pick(e.today)),
    skipped: e.skipped || null,
    lastTrades: e.lastTrades || null,
    note: 'the RECORDED-session record is a live tape, not a backtest: it is the same engines followed forward over the last '
      + (perf.window.sessions || 0) + ' sessions (' + perf.window.from + ' -> ' + perf.window.to + '). '
      + 'It is too thin to classify on its own — the classification uses the measured record above; this is what the tape actually did.',
  };
}

function engineEntries(board, enginesFile) {
  const boardRules = (board && board.rules) || [];
  const enginesMeasured = ((enginesFile && enginesFile.engines) || {});
  const perf = board && board.performance;
  const out = [];

  const seenEngines = new Set();
  const rules = boardRules.slice();
  for (const r of rules) seenEngines.add(r.engine);

  const regRules = typeof measuredRules === 'function' ? measuredRules(enginesFile) : [];
  for (const r of regRules) {
    if (!seenEngines.has(r.engine)) {
      rules.push(r);
      seenEngines.add(r.engine);
    }
  }

  for (const engKey of Object.keys(enginesMeasured)) {
    if (!seenEngines.has(engKey)) {
      const m = enginesMeasured[engKey] || {};
      const at05 = m.byCost ? m.byCost['0.05'] : null;
      rules.push({
        engine: engKey,
        name: m.name || (REGISTRY[engKey] && REGISTRY[engKey].mod && REGISTRY[engKey].mod.name) || engKey,
        trades: at05 ? at05.trades : 0,
        winPct: at05 ? at05.winPct : null,
        netPF: at05 ? at05.netPF : null,
        expectancyR: at05 ? at05.expectancyR : null,
        netR: at05 ? at05.netR : null,
        maxDDR: at05 ? at05.maxDDR : null,
        costPct: 0.05,
        measuredAt: enginesFile && enginesFile.generatedAt,
        thin: (at05 ? at05.trades : 0) < SPEAK_MIN_TRADES,
        speak: false,
      });
      seenEngines.add(engKey);
    }
  }

  for (const r of rules) {
    const v = judge(r.netR, r.trades, r.netPF);
    const m = enginesMeasured[r.engine] || {};
    const bySetup = m.bySetup || {};
    out.push({
      id: r.engine,
      name: r.name,
      kind: 'engine',
      parent: null,
      file: (REGISTRY[r.engine] || {}).file || null,
      classification: v.classification,
      reason: v.reason,
      netPF: r3(r.netPF),
      trades: num(r.trades),
      winPct: num(r.winPct),
      netR: r3(r.netR),
      expectancyR: r3(r.expectancyR),
      maxDDR: r3(r.maxDDR),
      costPct: num(r.costPct != null ? r.costPct : 0.05),
      measuredAt: r.measuredAt || (enginesFile && enginesFile.generatedAt) || null,
      // An engine that left the registry keeps its record and loses its claim, exactly
      // as a retired setup does (see setupMeta).
      maySpeak: !!r.speak && !!REGISTRY[r.engine],
      retired: !REGISTRY[r.engine],
      thin: !!r.thin,
      thinBelowTrades: r.thinBelowTrades || SPEAK_MIN_TRADES,
      minNetPF: r.minNetPF || SPEAK_NET_PF,
      disabled: false,
      provisional: false,
      live: liveFor(perf, r.engine),
      window: enginesFile && enginesFile.corpus ? {
        symbols: num(enginesFile.corpus.symbols), sessions: num(enginesFile.corpus.span && enginesFile.corpus.span.sessions),
        from: (enginesFile.corpus.span || {}).from || null, to: (enginesFile.corpus.span || {}).to || null,
      } : null,
      ladder: ladderFrom(m.byCost),
      setups: regSetupsAll(r.engine, bySetup).map((s) => Object.assign({ setup: s }, statBlock(bySetup[s]))),
      note: 'measured at ' + Number(r.costPct != null ? r.costPct : 0.05).toFixed(2) + '% round trip. '
        + 'The cost ladder below is the same logic at every cost it was measured at — read it before calling a thin edge real.',
    });
    // The setups are their own rows: a setup that is net-negative must be able to
    // say so with its own number instead of hiding inside an engine average.
    // Every setup the REGISTRY knows, not only the ones that traded: a setup with
    // no resolved trades is still a strategy on this board, and it is filed as
    // negative with "nothing was measured" rather than dropped out of sight.
    const setupIds = regSetupsAll(r.engine, bySetup);
    for (const s of setupIds) {
      const block = bySetup[s] || { trades: 0 };
      const sv = judge(block.netR, block.trades, block.netPF);
      const meta = setupMeta(r.engine, s);
      out.push({
        id: s,
        // The id is NOT glued onto the name — the row and the sheet print the id
        // themselves, and "OF01 — OF01 — Absorption Reversal" is what happens
        // when two layers both decide to add it.
        name: meta.label + (meta.disabled ? ' (DISABLED — measured out, not in the live signal set)' : '')
          + (meta.retired ? ' (RETIRED — removed from the live registry; its record is kept, it cannot speak)' : ''),
        kind: 'setup',
        parent: r.engine,
        classification: sv.classification,
        reason: sv.reason + ' (measured at 0.00% cost — no ladder was recorded per setup, so this row says so rather than borrowing the engine\'s)',
        netPF: r3(block.netPF),
        trades: num(block.trades),
        winPct: num(block.winPct),
        netR: r3(block.netR),
        expectancyR: r3(block.expectancyR),
        maxDDR: r3(block.maxDDR),
        costPct: 0,
        measuredAt: (enginesFile && enginesFile.generatedAt) || null,
        maySpeak: !meta.retired && !!(num(block.netPF) >= SPEAK_NET_PF && num(block.trades) >= SPEAK_MIN_TRADES),
        thin: num(block.trades) < SPEAK_MIN_TRADES,
        thinBelowTrades: SPEAK_MIN_TRADES,
        minNetPF: SPEAK_NET_PF,
        disabled: meta.disabled,
        retired: meta.retired,
        provisional: false,
        frames: ((REGISTRY[r.engine] || {}).setups || []).filter((x) => x.setup === s)
          .map((x) => ({ frameMinutes: x.frameMinutes, frames: x.frames, needs: x.needs }))[0] || null,
        live: liveFor(perf, r.engine),
        window: null,
        ladder: [],
        record: statBlock(block),
        note: 'gross of cost. The engine row above carries the after-cost number for the same trades.',
      });
    }
  }
  return out;
}

/**
 * The setup's own label, disabled flag and RETIRED status come from the registry,
 * not a copy.
 *
 * RETIRED is the third state, and it was missing: a setup deleted from the registry
 * (GB02/FG02, SW01, ORB01 on 2026-10-18) kept its historical row through
 * regSetupsAll, still classified 'positive' from an old measurement, and still
 * printed in the telegram list — a strategy that no longer exists in the code,
 * advertised as one that can speak. The record is worth keeping; the claim on it
 * is not. A retired row keeps its numbers and loses maySpeak.
 */
function setupMeta(engine, setup) {
  const e = REGISTRY[engine];
  const s = e && (e.setups || []).find((x) => x.setup === setup);
  return {
    label: (s && s.label) || (engine + ' setup'),
    disabled: !!(s && s.disabled),
    retired: !s,
  };
}
function setupLabel(engine, setup) { return setupMeta(engine, setup).label; }

/** Every setup of an engine: the registry's list first, then any setup the
 *  measurement knows that the registry does not (a retired one still counts). */
function regSetupsAll(engine, bySetup) {
  const reg = ((REGISTRY[engine] || {}).setups || []).map((x) => x.setup);
  return reg.concat(Object.keys(bySetup || {}).filter((s) => reg.indexOf(s) < 0));
}

/** The 9 research strategies from the locked LEARNING sweep, at 7 bp. */
function researchEntries(file) {
  if (!file || !Array.isArray(file.results)) return [];
  const costPct = num(file.costPct);
  const costBp = costPct == null ? null : Math.round(costPct * 100); // percent -> basis points
  return file.results.map((x) => {
    const o = x.overall || {};
    const v = judge(null, o.trades != null ? o.trades : x.trades, o.profitFactor);
    return {
      id: x.key,
      name: x.name,
      kind: 'research',
      parent: null,
      classification: v.classification,
      reason: v.reason,
      netPF: r3(o.profitFactor),
      trades: num(o.trades != null ? o.trades : x.trades),
      winPct: num(o.winPct),
      netR: null,
      expectancyR: null,
      expectancyPct: num(o.aggregateTradeExpectancyPct),
      costPct: costPct,
      measuredAt: file.generatedAt || null,
      maySpeak: false,
      thin: num(o.trades) < SPEAK_MIN_TRADES,
      thinBelowTrades: SPEAK_MIN_TRADES,
      minNetPF: SPEAK_NET_PF,
      disabled: false,
      provisional: false,
      live: null,
      window: {
        symbols: num(file.history && file.history.symbols), sessions: num(o.sessions),
        from: (file.history || {}).from || null, to: (file.history || {}).to || null,
      },
      logic: x.logic,
      // The cost ladder is the whole point for these: at 3 bp Bollinger + RSI is
      // +0.0027% and at 7 bp it is -0.0373%. A strategy that is positive only
      // before cost is not a positive strategy, it is a cost measurement.
      ladder: x.costSensitivityPctByRoundTrip ? Object.keys(x.costSensitivityPctByRoundTrip)
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => ({
          costPct: Number(k), expectancyPct: num(x.costSensitivityPctByRoundTrip[k]),
          verdict: num(x.costSensitivityPctByRoundTrip[k]) > 0 ? 'positive' : 'negative',
        })) : [],
      sessionStats: {
        positiveSessionPct: num(o.positiveSessionPct), sessionMeanPct: num(o.sessionMeanPct),
        sessionMeanCI95: o.sessionMeanCI95 || null, maxDayProfitShare: num(o.maxDayProfitShare),
        maxSymbolProfitShare: num(o.maxSymbolProfitShare), uniqueSymbols: num(o.uniqueSymbols),
      },
      portfolio: x.portfolio || null,
      costLadder: x.costSensitivityPctByRoundTrip || null,
      note: 'measured at ' + (costBp == null ? 'an unstated cost' : costBp + ' bp') + ' over the locked LEARNING manifest ('
        + ((file.history || {}).from || '?') + ' -> ' + ((file.history || {}).to || '?') + '). No cost ladder column here is positive'
        + ' except before cost — the ladder above is what decides it.',
    };
  });
}

/** Candidate 1, from its own report. It is one candidate with five variants. */
function candidateEntry(file) {
  if (!file || !file.results) return null;
  const base = file.results.v1_baseline || file.results[Object.keys(file.results)[0]];
  const v = judge(null, base.trades, base.profit_factor);
  const bestKey = Object.keys(file.results).sort((a, b) => (file.results[b].profit_factor || 0) - (file.results[a].profit_factor || 0))[0];
  const best = file.results[bestKey];
  return {
    id: 'c1_gapgo',
    name: 'C1 gap-and-go (candidate, ' + Object.keys(file.results).length + ' variants)',
    kind: 'candidate',
    parent: null,
    classification: v.classification,
    reason: v.reason + ' on the declared v1_baseline variant',
    netPF: r3(base.profit_factor),
    trades: num(base.trades),
    winPct: base.win_rate == null ? null : num(base.win_rate) * 100,
    netR: null,
    expectancyR: null,
    expectancyPct: num(base.net_expectancy_pct),
    costPct: num(file.cost_bp) == null ? null : num(file.cost_bp) / 100, // bp -> percent
    measuredAt: null,
    maySpeak: false,
    thin: num(base.trades) < SPEAK_MIN_TRADES,
    thinBelowTrades: SPEAK_MIN_TRADES,
    minNetPF: SPEAK_NET_PF,
    disabled: false,
    provisional: false,
    live: null,
    window: {
      symbols: num(file.universe && file.universe.symbols), sessions: num(file.manifest && file.manifest.sessions),
      from: (file.manifest || {}).from || null, to: (file.manifest || {}).to || null,
    },
    ladder: Object.keys(file.results).map((k) => ({
      variant: k, trades: num(file.results[k].trades), netPF: r3(file.results[k].profit_factor),
      expectancyPct: num(file.results[k].net_expectancy_pct),
      verdict: judge(null, file.results[k].trades, file.results[k].profit_factor).classification,
    })),
    note: 'the candidate FAILED its gate (>=' + (num(file.minTrades) || 200) + ' trades). Its best variant, ' + bestKey
      + ', is PF ' + r3(best.profit_factor) + ' on only ' + best.trades + ' trades; a positive PF on a sample below the floor'
      + ' is not evidence, which is why this row is classified from the declared baseline.',
  };
}

/** OR1, the frozen shadow cell. Positive on the tape, provisional by its own spec. */
function shadowEntry(file) {
  if (!file || !file.totals) return null;
  const sessions = (file.sessions || []);
  const positive = sessions.filter((s) => s.positive).length;
  const pf = sessions.map((s) => s.net_pf).filter((x) => x != null);
  const pfMean = pf.length ? pf.reduce((a, b) => a + b, 0) / pf.length : null;
  const bp = num(file.totals.net_exp_bp);
  // OR1 is judged on its own pre-declared measure (mean session net expectancy in
  // bp at 7 bp cost), because a PF is not recorded on every session and the spec
  // says bp. It shares the same "strictly greater than zero after cost" rule.
  const v = (!sessions.length)
    ? { classification: 'negative', reason: 'no session has been recorded yet' }
    : (bp > 0 ? { classification: 'positive', reason: 'mean session net expectancy +' + Number(bp).toFixed(2) + ' bp at 7 bp cost' }
              : { classification: 'negative', reason: 'mean session net expectancy ' + Number(bp).toFixed(2) + ' bp at 7 bp cost' });
  return {
    id: 'OR1',
    name: 'OR1 — opening-range imbalance -> continuation (frozen shadow)',
    kind: 'shadow',
    parent: null,
    classification: v.classification,
    reason: v.reason,
    netPF: r3(pfMean),
    trades: num(file.totals.trades),
    winPct: file.totals.trades ? (file.totals.wins / file.totals.trades) * 100 : null,
    netR: null,
    expectancyR: null,
    expectancyBp: bp,
    costPct: num(file.cost_bp) == null ? null : num(file.cost_bp) / 100, // bp -> percent
    measuredAt: file.generatedAt || null,
    maySpeak: false,
    thin: sessions.length < 40,
    thinBelowTrades: SPEAK_MIN_TRADES,
    minNetPF: SPEAK_NET_PF,
    disabled: false,
    provisional: !!file.provisional,
    live: null,
    window: { symbols: null, sessions: sessions.length, from: sessions.length ? sessions[0].session : null, to: sessions.length ? sessions[sessions.length - 1].session : null },
    ladder: [],
    sessions: sessions,
    readRule: file.readRule || null,
    definitionSha: file.definition_sha || null,
    note: 'PROVISIONAL — ' + ((file.status || {}).label || sessions.length + ' sessions') + ' of the frozen read rule. '
      + 'It is net-positive on the two sessions recorded so far, and two sessions is not a finding: it may speak nothing and it feeds no gate.',
  };
}

/** Everything, classified, with the live record attached where one exists. */
function build() {
  const board = readJSON(FILES.board);
  const enginesFile = readJSON(FILES.engines);
  const researchFile = readJSON(FILES.research);
  const candidateFile = readJSON(FILES.candidate);
  const shadowFile = readJSON(FILES.shadow);

  const entries = []
    .concat(engineEntries(board, enginesFile))
    .concat(researchEntries(researchFile))
    .concat([candidateEntry(candidateFile), shadowEntry(shadowFile)].filter(Boolean));

  const positive = entries.filter((e) => e.classification === 'positive');
  const negative = entries.filter((e) => e.classification === 'negative');

  // "TODAY" — the live tape for the last recorded session. The classification
  // above is the measured record and does NOT move day to day; what moves is
  // what the engines actually did. Both are reported, and they are labelled so
  // neither can be mistaken for the other.
  const session = (board && board.feed && board.feed.lastSession) || istDate();
  const live = entries.filter((e) => e.live && e.live.today);
  const todayTraded = live.filter((e) => (e.live.today.trades || 0) > 0);
  const todayPositive = todayTraded.filter((e) => (e.live.today.netR || 0) > 0);
  const todayNegative = todayTraded.filter((e) => (e.live.today.netR || 0) <= 0);
  const today = {
    date: istDate(),
    session: session,
    recordedAt: (board && board.builtAt) || null,
    // A strategy that fired nothing today has no today-verdict, and saying
    // "negative" for it would be inventing a loss it did not take.
    traded: todayTraded.length,
    positive: todayPositive.map((e) => e.id),
    negative: todayNegative.map((e) => e.id),
    flat: live.length - todayTraded.length,
    verdict: !todayTraded.length
      ? 'NO LIVE TRADES'
      : (!todayNegative.length ? 'ALL POSITIVE TODAY' : (!todayPositive.length ? 'ALL NEGATIVE TODAY' : 'MIXED TODAY')),
    text: !todayTraded.length
      ? 'No engine resolved a trade on ' + session + ', so there is no live verdict today — the classification below is the measured record and it is unchanged.'
      : todayPositive.length + ' of ' + todayTraded.length + ' engines that traded on ' + session + ' finished positive'
        + (todayNegative.length ? ', ' + todayNegative.length + ' finished negative' : '') + '.',
  };

  return {
    generatedAt: new Date().toISOString(),
    rule: RULE_TEXT,
    positiveAbovePF: POSITIVE_ABOVE_PF,
    positiveAboveNetR: POSITIVE_ABOVE_NET_R,
    speakRule: 'net PF >= ' + SPEAK_NET_PF + ' AND >= ' + SPEAK_MIN_TRADES + ' resolved trades',
    sources: {
      board: FILES.board.replace(ROOT + path.sep, ''),
      engines: FILES.engines.replace(ROOT + path.sep, ''),
      research: FILES.research.replace(ROOT + path.sep, ''),
      candidate: FILES.candidate.replace(ROOT + path.sep, ''),
      shadow: FILES.shadow.replace(ROOT + path.sep, ''),
    },
    loaded: {
      board: !!board, engines: !!enginesFile, research: !!researchFile, candidate: !!candidateFile, shadow: !!shadowFile,
    },
    summary: {
      total: entries.length,
      positive: positive.length,
      negative: negative.length,
      maySpeak: entries.filter((e) => e.maySpeak).length,
      positiveIds: positive.map((e) => e.id),
      negativeIds: negative.map((e) => e.id),
      // RETIRED ROWS ARE NOT IN THE ALERT LIST. They are still on the ledger and in the
      // counts above (their measurement is real), but a strategy that is no longer in the
      // registry can never arm a call, so naming it here would promise an alert that
      // cannot exist.
      telegram: 'Telegram carries the ' + positive.filter((e) => !e.retired).length +
        ' POSITIVE row(s) only: ' + (positive.filter((e) => !e.retired).map((e) => e.id).join(', ') || 'none'),
      telegramIds: positive.filter((e) => !e.retired).map((e) => e.id),
      retiredIds: entries.filter((e) => e.retired).map((e) => e.id),
    },
    today: today,
    entries: entries,
    byId: entries.reduce((a, e) => { a[e.id] = e; return a; }, {}),
  };
}

/** One row of stored history, per strategy, per day. */
function slim(ledger) {
  return {
    date: ledger.today.date,
    session: ledger.today.session,
    recordedAt: new Date().toISOString(),
    counts: { total: ledger.summary.total, positive: ledger.summary.positive, negative: ledger.summary.negative, maySpeak: ledger.summary.maySpeak },
    today: { verdict: ledger.today.verdict, traded: ledger.today.traded, positive: ledger.today.positive, negative: ledger.today.negative, flat: ledger.today.flat },
    positiveIds: ledger.summary.positiveIds,
    negativeIds: ledger.summary.negativeIds,
    entries: ledger.entries.map((e) => ({
      id: e.id, name: e.name, kind: e.kind, classification: e.classification,
      netPF: e.netPF, trades: e.trades, netR: e.netR, costPct: e.costPct,
      liveTrades: e.live && e.live.today ? e.live.today.trades : null,
      liveNetR: e.live && e.live.today ? e.live.today.netR : null,
    })),
  };
}

/**
 * STORE TODAY. Idempotent by date: re-running the build must not append a
 * second row for the same day, and a day whose numbers have not moved must not
 * rewrite the file at all (this runs on a 60-second poll).
 */
function recordDay(ledger) {
  const file = readJSON(FILES.history) || { days: [] };
  if (!Array.isArray(file.days)) file.days = [];
  const snap = slim(ledger);
  const i = file.days.findIndex((d) => d.date === snap.date);
  if (i >= 0 && JSON.stringify(file.days[i].entries) === JSON.stringify(snap.entries)
      && JSON.stringify(file.days[i].today) === JSON.stringify(snap.today)) {
    return file; // nothing moved — do not touch the disk
  }
  if (i >= 0) file.days[i] = snap; else file.days.push(snap);
  file.days.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (file.days.length > HISTORY_CAP) file.days = file.days.slice(-HISTORY_CAP);
  file.savedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(FILES.history), { recursive: true });
    fs.writeFileSync(FILES.history, JSON.stringify(file, null, 1), 'utf8');
  } catch (e) { /* a read-only disk must not take the endpoint down */ }
  return file;
}

/** The stored days, plus the same days read per strategy. */
function history(n) {
  const file = readJSON(FILES.history) || { days: [] };
  const days = Array.isArray(file.days) ? file.days : [];
  const keep = n ? days.slice(-n) : days;
  const byStrategy = {};
  for (const d of days) {
    for (const e of (d.entries || [])) {
      (byStrategy[e.id] = byStrategy[e.id] || []).push({
        date: d.date, classification: e.classification, netPF: e.netPF, trades: e.trades,
        liveTrades: e.liveTrades, liveNetR: e.liveNetR,
      });
    }
  }
  return { savedAt: file.savedAt || null, days: keep, back: days.length, byStrategy };
}

module.exports = {
  build, recordDay, history, judge, slim,
  FILES, POSITIVE_ABOVE_PF, POSITIVE_ABOVE_NET_R, SPEAK_NET_PF, SPEAK_MIN_TRADES, RULE_TEXT,
};

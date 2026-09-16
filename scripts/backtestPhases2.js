/**
 * scripts/backtestPhases2.js — Phase 5 v2: honest (as-of) bounce backtest +
 * S2 regime gate + S3 liquidity gate + S6 cooldown + S5 MFE/MAE logging.
 *
 * Compares, on the same universe and simulator as backtestPhases.js:
 *   - Support Bounce v2 (as-of zones, regime+liquidity gated, cooldown)
 *   - Breakout (unchanged from v1, for continuity)
 * vs the GB baseline. Every bounce signal logs MFE/MAE over the trade horizon.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { detectBounceSignals } = require('../common/market/bounceSignals');
const { detectBreakoutSignals } = require('../common/market/breakoutEntry');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_FILE = path.join(__dirname, '..', 'data', 'phase5v2_backtest.json');

// Nifty-50 proxy for the regime gate (an index ETF tracks it 1:1 closely)
const NIFTY_PROXY = 'SETFNIF50';

function simulate(candles, signal, horizon = 35) {
  const entryBar = signal.entry_bar != null ? signal.entry_bar : signal.trigger.bounceBar;
  const entry = signal.entry, stop = signal.stop, target = signal.target;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  let mfe = 0, mae = 0; // S5 — in R units
  for (let k = entryBar + 1; k < Math.min(candles.length, entryBar + 1 + horizon); k++) {
    const lo = candles[k][3], hi = candles[k][2];
    mfe = Math.max(mfe, (hi - entry) / risk);
    mae = Math.min(mae, (lo - entry) / risk);
    if (lo <= stop) return { exit: stop, reason: 'SL', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hi >= target) return { exit: target, reason: 'TGT', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
  }
  const k = Math.min(candles.length - 1, entryBar + horizon);
  return { exit: candles[k][4], reason: 'TIME', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { signals: 0 };
  const wins = trades.filter(t => t.rr > 0).length;
  const withMfe = trades.filter(t => t.mfe != null);
  return {
    signals: n,
    winRate: +(100 * wins / n).toFixed(1),
    avgR: +(trades.reduce((s, t) => s + t.rr, 0) / n).toFixed(2),
    avgHoldDays: +(trades.reduce((s, t) => s + t.holdDays, 0) / n).toFixed(1),
    avgMFE: +(withMfe.reduce((s, t) => s + t.mfe, 0) / (withMfe.length || 1)).toFixed(2),
    avgMAE: +(withMfe.reduce((s, t) => s + t.mae, 0) / (withMfe.length || 1)).toFixed(2),
    stoppedButRan: withMfe.filter(t => t.reason === 'SL' && t.mfe >= 1.5).length, // SL'd after being ≥1.5R in profit
    reversedAfterRunner: withMfe.filter(t => t.reason !== 'SL' && t.mfe >= 2 && t.rr < 1).length,
  };
}

function main() {
  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const niftyJ = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, NIFTY_PROXY + '.json'), 'utf8'));
  const niftyCandles = niftyJ.candles;

  const trades = { bounce: [], bounceNoRegime: [], breakout: [] };
  const rejections = { regime: 0, liquidity: 0 };
  let scanned = 0;

  for (const sym of symbols) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8')); } catch (_) { continue; }
    const candles = j.candles;
    if (!Array.isArray(candles) || candles.length < 90 || sym === NIFTY_PROXY) continue;
    scanned++;

    // ----- Support Bounce v2: as-of zones + regime + liquidity + cooldown -----
    try {
      const r = detectBounceSignals(candles, niftyCandles, {
        recencyMode: 'all', asOfZones: true,
        minAvgTurnover: 2e7,          // S3: ₹2 Cr/day
        regimeFilter: 'auto',          // S2
        cooldownBars: 10,              // S6
      });
      for (const s of r.signals) {
        const sim = simulate(candles, s);
        if (!sim || sim.exitBar - s.trigger.bounceBar <= 0) continue;
        const entryBar = s.trigger.bounceBar;
        const risk = s.entry - s.stop;
        trades.bounce.push({
          symbol: sym, engine: 'SUPPORT BOUNCE', entry_type: 'bounce',
          signal_date: candles[entryBar][0], entry: +s.entry.toFixed(2), stop: +s.stop.toFixed(2),
          target: +s.target.toFixed(2), exit: +sim.exit.toFixed(2), reason: sim.reason,
          rr: +((sim.exit - s.entry) / risk).toFixed(2), holdDays: sim.exitBar - entryBar,
          mfe: sim.mfe, mae: sim.mae, zone_strength: s.zone_strength, regime: s.regime,
        });
      }
      rejections.regime += r.rejected.filter(x => /market regime/.test(x.reason)).length;
      rejections.liquidity += r.rejected.filter(x => /turnover/.test(x.reason)).length;
      // ablation: same pipeline WITHOUT the regime gate (to quantify S2's impact)
      const rNoReg = detectBounceSignals(candles, niftyCandles, {
        recencyMode: 'all', asOfZones: true, minAvgTurnover: 2e7, regimeFilter: 'off', cooldownBars: 10,
      });
      for (const s of rNoReg.signals) {
        const sim = simulate(candles, s);
        if (!sim || sim.exitBar - s.trigger.bounceBar <= 0) continue;
        const entryBar = s.trigger.bounceBar;
        const risk = s.entry - s.stop;
        trades.bounceNoRegime.push({
          symbol: sym, signal_date: candles[entryBar][0], entry: +s.entry.toFixed(2),
          stop: +s.stop.toFixed(2), exit: +sim.exit.toFixed(2), reason: sim.reason,
          rr: +((sim.exit - s.entry) / risk).toFixed(2), holdDays: sim.exitBar - entryBar,
          mfe: sim.mfe, mae: sim.mae,
        });
      }
    } catch (_) {}

    // ----- Breakout (unchanged; continuity with v1) -----
    try {
      const r = detectBreakoutSignals(candles, null, { retestEntry: true });
      for (const s of r.signals) {
        const sim = simulate(candles, s);
        if (!sim || sim.exitBar - s.entry_bar <= 0) continue;
        const risk = s.entry - s.stop;
        trades.breakout.push({
          symbol: sym, engine: 'BREAKOUT', entry_type: s.entry_type,
          signal_date: candles[s.entry_bar][0], entry: +s.entry.toFixed(2), stop: +s.stop.toFixed(2),
          target: +s.target.toFixed(2), exit: +sim.exit.toFixed(2), reason: sim.reason,
          rr: +((sim.exit - s.entry) / risk).toFixed(2), holdDays: sim.exitBar - s.entry_bar,
          mfe: sim.mfe, mae: sim.mae,
        });
      }
    } catch (_) {}
  }

  const out = {
    generatedAt: new Date().toISOString(),
    scanned,
    niftyProxy: NIFTY_PROXY,
    baseline: { source: 'GB fresh-buy engine', signals: 1250, winRate: 25.6, avgR: -0.20, avgHoldDays: 8.4 },
    supportBounceV2: summarize(trades.bounce),
    supportBounceV2_noRegime: summarize(trades.bounceNoRegime),
    breakout: summarize(trades.breakout),
    regimeGateImpact: { regimeRejections: rejections.regime, liquidityRejections: rejections.liquidity },
    trades,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));

  const fmt = (label, s) => console.log(
    `${label.padEnd(30)} signals: ${String(s.signals ?? 0).padStart(5)}  win: ${String(s.winRate ?? '—').padStart(6)}%  avgR: ${String(s.avgR ?? '—').padStart(6)}  hold: ${String(s.avgHoldDays ?? '—').padStart(5)}d  MFE: ${s.avgMFE ?? '—'}  MAE: ${s.avgMAE ?? '—'}`
  );
  console.log(`Scanned ${scanned} stocks (regime proxy: ${NIFTY_PROXY})\n`);
  console.log('=== Baseline ==='); fmt('GB fresh-buy', out.baseline);
  console.log('\n=== Phase 5 v2 (as-of, honest) ===');
  fmt('Support Bounce v2', out.supportBounceV2);
  fmt('Bounce v2 (no regime gate)', out.supportBounceV2_noRegime);
  fmt('Breakout', out.breakout);
  console.log(`\nGate ablation: ${rejections.regime} signals blocked by regime, ${rejections.liquidity} by liquidity`);
  const d = out.supportBounceV2.winRate - out.supportBounceV2_noRegime.winRate;
  console.log(`Regime gate win-rate delta: ${d >= 0 ? '+' : ''}${d.toFixed(1)}pp (${out.supportBounceV2_noRegime.signals} → ${out.supportBounceV2.signals} signals)`);
  console.log('\nS5 diagnostics: stoppedButRan (SL after ≥1.5R) =', out.supportBounceV2.stoppedButRan, '| reversedAfterRunner =', out.supportBounceV2.reversedAfterRunner);
}

main();

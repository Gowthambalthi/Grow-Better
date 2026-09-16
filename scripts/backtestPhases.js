/**
 * scripts/backtestPhases.js — Phase 5: backtest & comparison.
 *
 * Task 5.1  Runs the SAME trade simulator over three signal sets on the full
 *           2,704-stock universe: Support Bounce (Phases 1+2), Breakout
 *           (Phases 3+4), and Combined (both). Baseline = the existing GB
 *           fresh-buy engine backtest (scripts/backtestStrategy.js output).
 * Task 5.2  Every REJECTED signal is logged with the gate that failed it plus
 *           a full metrics snapshot, so thresholds can be grid-searched later
 *           without re-running detection (data/phase5_rejections.json).
 * Task 5.3  Prints a before/after comparison vs the 25.6% / −0.2R / 1,250-sig
 *           baseline (fresh-buy tightened table: 160 signals).
 *
 * Trade simulation (identical for all sets, fair comparison):
 *   - entry at next bar's close after the entry_bar
 *   - SL / target from the signal; SL checked first on collision (conservative)
 *   - T1 = +1.5R partial at 50% is NOT modeled: exits are SL / target / time-35
 *   - 3-bar cooldown after each trade per symbol
 *
 * Output: data/phase5_backtest.json + console report.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { detectBounceSignals } = require('../common/market/bounceSignals');
const { detectBreakoutSignals } = require('../common/market/breakoutEntry');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_FILE = path.join(__dirname, '..', 'data', 'phase5_backtest.json');
const REJ_FILE = path.join(__dirname, '..', 'data', 'phase5_rejections.json');

// ---------- shared trade simulator ----------
function simulate(candles, signal) {
  // entry at next bar's close (never mid-candle); signal carries stop/target/rr
  const entryBar = signal.entry_bar != null ? signal.entry_bar : signal.trigger.bounceBar;
  const entry = signal.entry;
  const stop = signal.stop, target = signal.target;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  for (let k = entryBar + 1; k < Math.min(candles.length, entryBar + 1 + 35); k++) {
    const lo = candles[k][3], hi = candles[k][2];
    if (lo <= stop) return { exit: stop, reason: 'SL', exitBar: k };        // SL first (conservative)
    if (hi >= target) return { exit: target, reason: 'TGT', exitBar: k };
  }
  const k = Math.min(candles.length - 1, entryBar + 35);
  return { exit: candles[k][4], reason: 'TIME', exitBar: k };
}

function record(trade, sim, candles, signal, engine) {
  const entryBar = signal.entry_bar != null ? signal.entry_bar : signal.trigger.bounceBar;
  const entry = candles[entryBar + 1] ? candles[entryBar + 1][4] : signal.entry;
  const risk = signal.entry - signal.stop;
  const rr = risk > 0 ? (sim.exit - signal.entry) / risk : 0;
  trade.push({
    symbol: signal.symbol,
    engine,
    entry_type: signal.entry_type || 'bounce',
    signal_date: candles[entryBar][0],
    entry_date: candles[Math.min(entryBar + 1, candles.length - 1)][0],
    entry: +signal.entry.toFixed(2),
    stop: +signal.stop.toFixed(2),
    target: +signal.target.toFixed(2),
    exit: +sim.exit.toFixed(2),
    reason: sim.reason,
    rr: +rr.toFixed(2),
    holdDays: sim.exitBar - entryBar,
  });
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { signals: 0 };
  const wins = trades.filter(t => t.rr > 0).length;
  return {
    signals: n,
    winRate: +(100 * wins / n).toFixed(1),
    avgR: +((trades.reduce((s, t) => s + t.rr, 0)) / n).toFixed(2),
    avgHoldDays: +((trades.reduce((s, t) => s + t.holdDays, 0)) / n).toFixed(1),
    exits: trades.reduce((m, t) => { m[t.reason] = (m[t.reason] || 0) + 1; return m; }, {}),
  };
}

// ---------- main ----------
function main() {
  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const trades = { bounce: [], breakout: [], combined: [], bounceRelaxed: [] };
  const rejections = [];
  let scanned = 0;

  for (const sym of symbols) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8')); } catch (_) { continue; }
    const candles = j.candles;
    if (!Array.isArray(candles) || candles.length < 90) continue;
    scanned++;
    const used = new Set(); // per-symbol cooldown across engines (entryBar dates)

    // ----- Support Bounce engine (Phases 1+2) — walk-forward: all touches -----
    try {
      const r = detectBounceSignals(candles, null, { zoneOpts: {}, recencyMode: 'all' });
      for (const s of r.signals) {
        const key = s.trigger.bounceBar;
        if (used.has(key)) continue;
        used.add(key);
        const sim = simulate(candles, s);
        if (sim && sim.exitBar - key > 0) record(trades.bounce, sim, candles, { ...s, symbol: sym }, 'SUPPORT BOUNCE');
      }
      // Task 5.2 — log rejections with the failing gate
      for (const rej of r.rejected) {
        rejections.push({ symbol: sym, engine: 'SUPPORT BOUNCE', date: rej.date, touchBar: rej.touchBar, gate: rej.reason, detail: { rs: rej.detail && rej.detail.rs ? rej.detail.rs : null, volume: rej.detail && rej.detail.volume ? rej.detail.volume : null, structure: rej.detail && rej.detail.structure ? rej.detail.structure.state : null } });
      }
      // sensitivity row: relaxed volume gates (grid-search candidates)
      const rr = detectBounceSignals(candles, null, { zoneOpts: {}, recencyMode: 'all', bounceVolMult: 1.3, volTrendMaxRise: 0.3 });
      for (const s of rr.signals) {
        if (used.has(s.trigger.bounceBar + 'R')) continue;
        used.add(s.trigger.bounceBar + 'R');
        const sim = simulate(candles, s);
        if (sim && sim.exitBar - s.trigger.bounceBar > 0) record(trades.bounceRelaxed, sim, candles, { ...s, symbol: sym }, 'SUPPORT BOUNCE (relaxed)');
      }
    } catch (_) {}

    // ----- Breakout engine (Phases 3+4) -----
    try {
      const r = detectBreakoutSignals(candles, null, { retestEntry: true });
      for (const s of r.signals) {
        if (used.has(s.entry_bar)) continue;
        used.add(s.entry_bar);
        const sim = simulate(candles, s);
        if (sim && sim.exitBar - s.entry_bar > 0) record(trades.breakout, sim, candles, { ...s, symbol: sym }, 'BREAKOUT');
      }
      for (const u of r.unconfirmed) {
        rejections.push({ symbol: sym, engine: 'BREAKOUT', date: u.date, gate: `volume unconfirmed: ${u.reason}`, breakout_bar: u.bar });
      }
      for (const rej of r.rejected) {
        rejections.push({ symbol: sym, engine: 'BREAKOUT', date: rej.date, gate: rej.reason, breakout_bar: rej.bar });
      }
    } catch (_) {}
  }

  // Combined = union of both (deduped by symbol+entryBar already via `used` per symbol,
  // but engines run separately here; dedupe across engines by symbol+signal_date+entry)
  const seen = new Set();
  trades.combined = [...trades.bounce, ...trades.breakout].filter(t => {
    const k = `${t.symbol}|${t.signal_date}|${t.entry}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const out = {
    generatedAt: new Date().toISOString(),
    scanned,
    baseline: { source: 'scripts/backtestStrategy.js (GB fresh-buy engine)', signals: 1250, winRate: 25.6, avgR: -0.20, avgHoldDays: 8.4 },
    supportBounce: summarize(trades.bounce),
    supportBounceRelaxed: summarize(trades.bounceRelaxed),
    breakout: summarize(trades.breakout),
    combined: summarize(trades.combined),
    byEntryType: {
      breakout_entries: summarize(trades.combined.filter(t => t.entry_type === 'breakout')),
      retest_entries: summarize(trades.combined.filter(t => t.entry_type === 'retest')),
      bounce_entries: summarize(trades.combined.filter(t => t.entry_type === 'bounce')),
    },
    trades: { bounce: trades.bounce, bounceRelaxed: trades.bounceRelaxed, breakout: trades.breakout, combined: trades.combined },
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  fs.writeFileSync(REJ_FILE, JSON.stringify({ generatedAt: out.generatedAt, count: rejections.length, rejections }));

  // ---------- console report (Task 5.3) ----------
  const fmt = (label, s) => console.log(
    `${label.padEnd(22)} signals: ${String(s.signals ?? 0).padStart(5)}  winRate: ${String(s.winRate ?? '—').padStart(6)}%  avgR: ${String(s.avgR ?? '—').padStart(6)}  avgHold: ${String(s.avgHoldDays ?? '—').padStart(5)}d`
  );
  console.log(`Scanned ${scanned} stocks\n`);
  console.log('=== Baseline (existing GB engine, same simulator) ===');
  fmt('GB fresh-buy', out.baseline);
  console.log('\n=== Phase 1–4 engines (same simulator, same universe) ===');
  fmt('Support Bounce', out.supportBounce);
  fmt('Support Bounce (relaxed)', out.supportBounceRelaxed);
  fmt('Breakout', out.breakout);
  fmt('Combined', out.combined);
  console.log('\n=== Entry-type split (combined) ===');
  fmt('breakout entries', out.byEntryType.breakout_entries);
  fmt('retest entries', out.byEntryType.retest_entries);
  fmt('bounce entries', out.byEntryType.bounce_entries);

  const cmp = (label, s) => {
    if (!s.signals) { console.log(`${label}: no signals`); return; }
    const dw = s.winRate - out.baseline.winRate;
    const dr = s.avgR - out.baseline.avgR;
    console.log(`${label}: ${dw >= 0 ? '+' : ''}${dw.toFixed(1)}pp win rate, ${dr >= 0 ? '+' : ''}${dr.toFixed(2)}R vs baseline, ${s.signals} signals (baseline 1250 → ${(100 * s.signals / 1250).toFixed(0)}%)`);
  };
  console.log('\n=== Vs baseline (Task 5.3) ===');
  cmp('Support Bounce', out.supportBounce);
  cmp('Breakout', out.breakout);
  cmp('Combined', out.combined);
  console.log(`\nRejections logged for grid search: ${rejections.length} → ${path.basename(REJ_FILE)}`);
}

main();

/**
 * scripts/buildTradeTable.js — rebuild data/trade_table_stocks.json from
 * data/engine_scores.json using the GB fresh-buy rules:
 *
 *   - engineRate >= 7
 *   - volRatio > 1.2
 *   - no traps (RSI>80, close > EMA20*1.10, volRatio<0.8, ADX<18)
 *   - freshness: close within 1% of the entry zone (late entries dropped)
 *
 * Entry zone per winning engine: BREAKOUT→resistance30, SUPPORT BOUNCE→support30,
 * TREND/PULLBACK/ACCUMULATION→EMA20.
 * stopLoss = min(support30, low−ATR); T1 = entry+1.5×risk; T2 = entry+4×risk.
 *
 * ETFs are excluded via the AMFI ISIN set when present (same as the server).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { scoreFrames } = require('../common/market/confirmFrames');

const SCORES = path.join(__dirname, '..', 'data', 'engine_scores.json');
const OHLCV = path.join(__dirname, '..', 'data', 'ohlcv');
const OUT = path.join(__dirname, '..', 'data', 'trade_table_stocks.json');
const ETF_ISINS = path.join(__dirname, '..', 'data', 'amfi_etf_isins.json');
const BENCH_FILE = path.join(__dirname, '..', 'data', 'ohlcv', 'SETFNIF50.json');

function loadEtfIsins() {
  try { return new Set(JSON.parse(fs.readFileSync(ETF_ISINS, 'utf8'))); } catch (_) { return new Set(); }
}

function main() {
  const scores = JSON.parse(fs.readFileSync(SCORES, 'utf8'));
  const etfIsins = loadEtfIsins();

  // ISIN lookup via Groww instrument master (has ISIN field; Angel does not)
  let isinOf = null;
  try {
    const gi = require('../common/instruments/growwInstruments');
    gi.refresh().then(() => {
      isinOf = s => { try { return gi.findEquity(s)?.isin || null; } catch (_) { return null; } };
      run();
    }).catch(() => run());
  } catch (_) { run(); }

  function run() {
    const rows = [];
    let etfDropped = 0, lateEntries = 0, trapped = 0, confirmDropped = 0;

    // benchmark for the RS frame
    let bench = null;
    try { bench = JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8')).candles; } catch (_) { bench = null; }

    for (const r of scores.results) {
      if (r.engineRate < 7) continue;
      const i = r.indicators;

      // ETF filter
      if (isinOf) {
        const isin = isinOf(r.symbol);
        if (isin && etfIsins.has(isin)) { etfDropped++; continue; }
      }

      // traps
      if (i.rsi14 > 80 || i.volRatio < 0.8 || i.adx14 < 18) { trapped++; continue; }
      if (r.close > i.ema20 * 1.10) { trapped++; continue; }

      // entry zone + freshness (within 1%)
      const zone = r.winningEngine === 'BREAKOUT' ? i.resistance30
        : r.winningEngine === 'SUPPORT BOUNCE' ? i.support30
        : i.ema20;
      if (!(r.close >= zone * 0.99 && r.close <= zone * 1.01)) { lateEntries++; continue; }
      if (i.volRatio <= 1.2) { trapped++; continue; }

      // today's low for stop calc
      let low = r.close;
      let candles = null;
      try {
        candles = JSON.parse(fs.readFileSync(path.join(OHLCV, r.symbol + '.json'), 'utf8')).candles;
        low = candles[candles.length - 1][3];
      } catch (_) {}

      // Multi-frame confirmation (3y-validated gate: extension + RS + volume)
      // f5 ext<=2.5 ATR, f2 RS>=0 vs Nifty, f3 volRatio>=1.5 — the gate that
      // produced 50% win / +0.39R vs 46.2% / +0.24R ungated (n=88, all years +).
      let frames = null;
      if (candles) {
        try {
          const sigStub = { breakout_bar: candles.length - 1, entry_bar: candles.length - 1, base: null };
          frames = scoreFrames({ stockCandles: candles, sig: sigStub, benchmarkCandles: bench });
        } catch (_) { frames = null; }
      }
      const f5ok = frames?.f5?.pass !== false;   // not over-extended
      const f2ok = frames?.f2?.pass !== false;   // RS vs Nifty >= 0
      const f3ok = (i.volRatio >= 1.5);          // volume quality
      const confirmCount = [f5ok, f2ok, f3ok].filter(Boolean).length;
      if (!(f5ok && f2ok && f3ok)) { confirmDropped++; continue; }

      const stopLoss = +Math.min(i.support30, low - i.atr14).toFixed(2);
      const risk = Math.max(r.close - stopLoss, i.atr14 * 0.5);
      rows.push({
        symbol: r.symbol,
        engine: r.winningEngine,
        score: r.engineRate,
        close: +r.close.toFixed(2),
        entry: +zone.toFixed(2),
        stopLoss,
        target1: +(r.close + risk * 1.5).toFixed(2),
        target2: +(r.close + risk * 4).toFixed(2),
        rsi: i.rsi14,
        adx: i.adx14,
        volRatio: +i.volRatio.toFixed(2),
        confirm: {
          framesPassed: confirmCount,
          extAtr: frames?.f5?.ext ?? null,
          rsVsNifty: frames?.f2?.rs ?? null,
        },
      });
    }

    rows.sort((a, b) => b.score - a.score);
    const out = {
      generatedAt: new Date().toISOString(),
      scanned: scores.scanned,
      freshBuys: rows.length,
      etfDropped, lateEntries, trapped, confirmDropped,
      rows,
    };
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`Fresh buys: ${rows.length} (ETFs dropped ${etfDropped}, late entries ${lateEntries}, trapped ${trapped}, confirm-dropped ${confirmDropped})`);
    console.log(`Output: ${OUT}`);
  }
}

main();

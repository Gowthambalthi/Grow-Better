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
const { scoreFrames, frameVolumeAtPrice, frameNiftyDirection } = require('../common/market/confirmFrames');

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
      // F9 volume-at-price: close in the top 30% of the bar's range (buying
      // conviction at the highs). In backtest the bar IS the breakout bar; live,
      // today may be a pullback day after the signal bar, so measure on the
      // most recent of the last 5 bars that shows the conviction (the signal
      // bar). If none of the last 5 show it, the setup lacks conviction — drop.
      let f9 = { pass: false, upperShare: null }; // no conviction bar in last 5 → fail
      if (candles) {
        for (let k = candles.length - 1; k >= Math.max(0, candles.length - 5); k--) {
          const f = frameVolumeAtPrice(candles, k);
          if (f.pass) { f9 = f; break; }
        }
      }
      const f9ok = f9.pass === true;
      const f8 = frames?.f8 ?? frameNiftyDirection(bench, (candles ? candles[candles.length - 1][0] : null));
      const confirmCount = [f5ok, f2ok, f3ok, f9ok].filter(Boolean).length;
      if (!(f5ok && f2ok && f3ok && f9ok)) { confirmDropped++; continue; }

      // ---- Intraday execution plan (Camarilla-style levels from prev day) ----
      // For each confirmed swing, compute tradeable intraday levels off the
      // previous day's H/L/C: R3/R4 (breakout targets), S3 (intraday stop
      // reference), plus pivot. The 9:15-10:00 opening range gives the entry
      // trigger; direction must agree with the daily setup (long-only).
      let intraday = null;
      if (candles && candles.length >= 2) {
        const pd = candles[candles.length - 2]; // previous day: [d,o,h,l,c,v]
        const pdH = pd[2], pdL = pd[3], pdC = pd[4];
        const rng = pdH - pdL;
        intraday = {
          r3: +(pdC + rng * 1.1 / 4).toFixed(2),
          r4: +(pdC + rng * 1.1 / 2).toFixed(2),
          pivot: +((pdH + pdL + pdC) / 3).toFixed(2),
          s3: +(pdC - rng * 1.1 / 4).toFixed(2),
          // execution rule text shown in Terminal
          plan: 'Long above R3 with volume; add/partial at R4. Intraday SL below S3. ' +
                'If price opens above R4, wait for a retest of R3 to enter — do not chase.',
        };
      }

      // Candle-structure stop: use the RECENT swing low from the last 10
      // candles (the low of the pullback that launched the move), floored at
      // 1×ATR below the latest low, capped so risk never exceeds 4% of close.
      // The old min(support30, low−ATR) put stops 6-11% away — structurally
      // meaningful only for the 30-bar swing, not the entry setup.
      let stopLoss;
      let stopBasis;
      if (candles && candles.length >= 12) {
        const recent = candles.slice(-10);
        const swingLow = Math.min(...recent.map(c => c[3]));
        const atrFloor = low - i.atr14;
        const raw = Math.min(swingLow - i.atr14 * 0.25, Math.max(swingLow, atrFloor));
        // risk cap: never wider than 4% of close; if the candle structure is
        // wider than that, fall back to 2×ATR below close
        const maxRisk = r.close * 0.04;
        if (r.close - raw > maxRisk) {
          stopLoss = +(r.close - Math.min(2 * i.atr14, maxRisk)).toFixed(2);
          stopBasis = '2xATR (structure too wide)';
        } else {
          stopLoss = +raw.toFixed(2);
          stopBasis = '10-bar swing low';
        }
      } else {
        stopLoss = +(low - i.atr14).toFixed(2);
        stopBasis = 'low - ATR';
      }
      const risk = Math.max(r.close - stopLoss, i.atr14 * 0.5);
      rows.push({
        symbol: r.symbol,
        engine: r.winningEngine,
        score: r.engineRate,
        close: +r.close.toFixed(2),
        entry: +zone.toFixed(2),
        stopLoss,
        stopBasis,
        target1: +(r.close + risk * 1.5).toFixed(2),
        target2: +(r.close + risk * 2.5).toFixed(2),
        rsi: i.rsi14,
        adx: i.adx14,
        volRatio: +i.volRatio.toFixed(2),
        confirm: {
          framesPassed: confirmCount,
          extAtr: frames?.f5?.ext ?? null,
          rsVsNifty: frames?.f2?.rs ?? null,
          volAtPrice: f9.upperShare ?? null,
          niftyDir: f8?.direction ?? null,
        },
        intraday,
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

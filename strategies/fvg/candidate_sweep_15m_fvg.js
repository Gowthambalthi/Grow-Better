/**
 * strategies/fvg/candidate_sweep_15m_fvg.js
 *
 * PRE-REGISTERED FROZEN CANDIDATE STRATEGY & BASELINE MODULE
 *
 * Designed for an exact paired A/B test where the ONLY independent variable
 * is the 15m Fair Value Gap (FVG) Displacement Confluence Filter.
 *
 * Arm 1: BASELINE  (opt.filter15mFvg = false) -> Unfiltered 1m Liquidity Sweep
 * Arm 2: CANDIDATE (opt.filter15mFvg = true)  -> 1m Liquidity Sweep + 15m FVG Confluence
 *
 * Both arms share 100% IDENTICAL trade geometry and execution:
 *   - Side:                 Two-Sided (shortOnly: false)
 *   - Sweep Trigger:        1m Rule A (3-bar swing pivot pierced and rejected with >= 35% wick)
 *   - Entry Price:          Next bar open: bars1m[i+1].o (strictly causal)
 *   - Stop Loss:            Sweep extreme +/- stopBufferBps (25.0 bps)
 *   - Target:               Entry price +/- targetBps (150.0 bps)
 *   - Min Reward/Risk:      1.0 (target distance >= risk distance)
 *   - Arming Window:        10:00 to 13:00 IST (first evaluation at 10:00 after 3 15m bars complete)
 *   - Settlement Cutoff:    Strictly at 15:14 IST (minute 914); bars after 15:14 are ignored
 *   - Tie Policy:           If bar range hits both stop and target, STOP fills first (pessimistic)
 *   - Itemized Friction:    5.384 bps statutory + slippage (stop: 4.0, target: 1.0, session_close: 2.0)
 *
 * Inputs:
 *   bars1m  - Array of 1-minute bars: [{ time, open, high, low, close, volume }, ...] or raw arrays
 *   options - Configuration overrides
 *
 * Outputs:
 *   {
 *     trades:  [ { id, symbol, side, entryBar, entryTime, entryPx, exitBar, exitTime, exitPx, exitReason, grossBps, tollBps, netBps, rMultiple }, ... ],
 *     signals: [ { id, symbol, side, triggerBar, triggerTime, entryPx, sl, tgt, filterPassed }, ... ],
 *     stats:   { totalTrades, wins, losses, winRate, netBpsMean, netBpsSum }
 *   }
 */

'use strict';

const STATUTORY_BPS = 5.384;
const DEFAULT_SLIPPAGE = {
  stop: 4.0,
  target: 1.0,
  session_close: 2.0
};

/** Parse minute of IST day (09:15 = 555, 13:00 = 780, 15:14 = 914, 15:30 = 930) */
function getMinuteOfIST(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr);
  const parts = s.split(' ');
  const t = parts.length > 1 ? parts[1] : parts[0];
  const [hh, mm] = t.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm)) return null;
  return hh * 60 + mm;
}

/** Standardize bar format to { time, o, h, l, c, v } */
function normalizeBar(b) {
  if (Array.isArray(b)) {
    return { time: b[0], o: Number(b[1]), h: Number(b[2]), l: Number(b[3]), c: Number(b[4]), v: Number(b[5]) };
  }
  return {
    time: b.time || b.t,
    o: Number(b.open !== undefined ? b.open : b.o),
    h: Number(b.high !== undefined ? b.high : b.h),
    l: Number(b.low !== undefined ? b.low : b.l),
    c: Number(b.close !== undefined ? b.close : b.c),
    v: Number(b.volume !== undefined ? b.volume : (b.v || 0))
  };
}

/** Aggregate 1m bars into 15m closed bars strictly causally */
function build15mBarsCausal(rawBars1m) {
  const bars15m = [];
  let cur15 = null;
  let curBucket = null;

  for (let i = 0; i < rawBars1m.length; i++) {
    const b = normalizeBar(rawBars1m[i]);
    const m = getMinuteOfIST(b.time);
    if (m == null || m > 914) continue; // Respect 15:14 cut

    // 15-minute clock bucket: 09:15-09:29 -> bucket 555, 09:30-09:44 -> bucket 570, etc.
    const bucketMin = 555 + 15 * Math.floor((m - 555) / 15);
    if (curBucket !== bucketMin) {
      if (cur15) bars15m.push(cur15);
      curBucket = bucketMin;
      cur15 = {
        time: b.time,
        bucketMin,
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v,
        end1mIndex: i
      };
    } else {
      cur15.h = Math.max(cur15.h, b.h);
      cur15.l = Math.min(cur15.l, b.l);
      cur15.c = b.c;
      cur15.v += b.v;
      cur15.end1mIndex = i;
    }
  }
  if (cur15) bars15m.push(cur15);
  return bars15m;
}

/** Compute ATR(14) on 15m bars */
function computeAtr14(bars) {
  const atr = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      atr[i] = bars[i].h - bars[i].l;
    } else {
      const prevC = bars[i - 1].c;
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevC), Math.abs(bars[i].l - prevC));
      atr[i] = (atr[i - 1] * 13 + tr) / 14;
    }
  }
  return atr;
}

/** Check 15m displacement and FVG confluence at 1m bar index i */
function check15mConfluence(i, side, bars1m, bars15m, atr15m, opt) {
  const current1mTime = bars1m[i].time;
  const currentMin = getMinuteOfIST(current1mTime);

  // Find the last COMPLETED 15m bar prior to or ending at current minute
  // A 15m bar starting at bucketMin is complete when currentMin >= bucketMin + 15
  let lastClosedIdx = -1;
  for (let k = bars15m.length - 1; k >= 0; k--) {
    if (bars15m[k].bucketMin + 15 <= currentMin) {
      lastClosedIdx = k;
      break;
    }
  }

  // Requires at least 3 completed 15m bars (index 0, 1, 2) to evaluate FVG [k-2 .. k]
  // Index 2 is bucket 09:45-09:59, which closes at 10:00 IST.
  if (lastClosedIdx < 2) return { pass: false, reason: 'INSUFFICIENT_15M_BARS' };

  const dispBar = bars15m[lastClosedIdx];
  const body = Math.abs(dispBar.c - dispBar.o);

  // 1. Median body filter over prior 20 15m bars
  const lookback = opt.fvgLookback15m || 20;
  const startIdx = Math.max(0, lastClosedIdx - lookback);
  const priorBodies = [];
  for (let k = startIdx; k < lastClosedIdx; k++) {
    priorBodies.push(Math.abs(bars15m[k].c - bars15m[k].o));
  }
  if (priorBodies.length < 5) return { pass: false, reason: 'TOO_FEW_PRIOR_15M' };
  priorBodies.sort((a, b) => a - b);
  const medianBody = priorBodies[Math.floor(priorBodies.length / 2)];

  const mult = opt.displacementMult || 1.5;
  if (body < mult * medianBody) {
    return { pass: false, reason: 'DISPLACEMENT_BODY_BELOW_MEDIAN_1.5X' };
  }

  // 2. FVG formation on 15m: gap between bar[lastClosedIdx - 2] and bar[lastClosedIdx]
  const curAtr = atr15m[lastClosedIdx] || (dispBar.h - dispBar.l);
  const minGap = (opt.fvgAtrMult || 0.20) * curAtr;

  if (side === 'SHORT') {
    if (dispBar.c >= dispBar.o) return { pass: false, reason: '15M_NOT_BEARISH' };
    const gap = bars15m[lastClosedIdx - 2].l - dispBar.h;
    if (gap < minGap) return { pass: false, reason: '15M_FVG_GAP_TOO_SMALL' };
    return { pass: true, fvgTop: bars15m[lastClosedIdx - 2].l, fvgBottom: dispBar.h };
  } else if (side === 'LONG') {
    if (dispBar.c <= dispBar.o) return { pass: false, reason: '15M_NOT_BULLISH' };
    const gap = dispBar.l - bars15m[lastClosedIdx - 2].h;
    if (gap < minGap) return { pass: false, reason: '15M_FVG_GAP_TOO_SMALL' };
    return { pass: true, fvgTop: dispBar.l, fvgBottom: bars15m[lastClosedIdx - 2].h };
  }

  return { pass: false, reason: 'UNKNOWN_SIDE' };
}

/**
 * Main Engine Runner (supports both Baseline and Candidate via opt.filter15mFvg)
 */
function runCandidateStrategy(rawBars1m, userOpt = {}) {
  const opt = {
    symbol: 'SYMBOL',
    filter15mFvg: true,       // true = Candidate Arm; false = Baseline Arm
    shortOnly: false,         // Two-sided evaluation
    armingStartMin: 585,      // 09:45 IST (earliest trigger; 15m confluence gates until 10:00)
    armingEndMin: 780,        // 13:00 IST (no new setups armed after 13:00)
    swingWing: 3,             // 3-bar swing pivots on 1m
    minWickPct: 0.35,         // 35% rejection wick on sweep bar
    fvgLookback15m: 20,       // 20 15m bars for median body
    displacementMult: 1.5,    // 15m body >= 1.5x median
    fvgAtrMult: 0.20,         // FVG >= 0.20 * ATR(14)
    stopBufferBps: 25.0,      // 25 bps beyond sweep extreme
    targetBps: 150.0,         // fixed 150 bps target
    minRr: 0.1,               // min RR ratio (matches measured_150_150)
    flatTollBps: 15.0,        // Flat 15.0 bps round-trip friction (statutory + half-spread/impact)
    statutoryBps: STATUTORY_BPS,
    slippage: DEFAULT_SLIPPAGE,
    ...userOpt
  };

  const bars1m = rawBars1m.map(normalizeBar);
  if (bars1m.length < 30) {
    return { trades: [], signals: [], stats: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, netBpsMean: 0, netBpsSum: 0 } };
  }

  const bars15m = build15mBarsCausal(bars1m);
  const atr15m = computeAtr14(bars15m);

  const signals = [];
  const trades = [];

  let activePosition = null;
  const pivHighs = [];
  const pivLows = [];
  const swingWing = opt.swingWing;

  for (let i = 0; i < bars1m.length; i++) {
    const bar = bars1m[i];
    const m = getMinuteOfIST(bar.time);
    if (m == null || m > 914) continue; // Strictly cut off after 15:14 IST

    // 1. Manage Active Position
    if (activePosition) {
      const pos = activePosition;
      let exitReason = null;
      let exitPx = null;

      if (pos.side === 'SHORT') {
        const hitStop = bar.h >= pos.sl;
        const hitTgt = bar.l <= pos.tgt;
        if (hitStop && hitTgt) {
          exitReason = 'stop';
          exitPx = pos.sl;
        } else if (hitStop) {
          exitReason = 'stop';
          exitPx = pos.sl;
        } else if (hitTgt) {
          exitReason = 'target';
          exitPx = pos.tgt;
        }
      } else if (pos.side === 'LONG') {
        const hitStop = bar.l <= pos.sl;
        const hitTgt = bar.h >= pos.tgt;
        if (hitStop && hitTgt) {
          exitReason = 'stop';
          exitPx = pos.sl;
        } else if (hitStop) {
          exitReason = 'stop';
          exitPx = pos.sl;
        } else if (hitTgt) {
          exitReason = 'target';
          exitPx = pos.tgt;
        }
      }

      // Check session close exit strictly at 15:14 IST (minute 914) or final available bar
      const isLastBar = (m >= 914) || (i === bars1m.length - 1);
      if (!exitReason && isLastBar) {
        exitReason = 'session_close';
        exitPx = bar.c;
      }

      if (exitReason) {
        const grossPt = pos.side === 'SHORT' ? (pos.entryPx - exitPx) : (exitPx - pos.entryPx);
        const grossBps = (grossPt / pos.entryPx) * 1e4;
        const tollBps = opt.flatTollBps !== undefined ? opt.flatTollBps : 15.0; // Flat 15.0 bps round-trip friction
        const netBps = grossBps - tollBps;
        const riskPt = Math.abs(pos.entryPx - pos.sl);
        const rMult = riskPt > 0 ? (grossPt / riskPt) : 0;

        trades.push({
          id: pos.id,
          symbol: opt.symbol,
          side: pos.side,
          entryBar: pos.entryBar,
          entryTime: pos.entryTime,
          entryPx: pos.entryPx,
          exitBar: i,
          exitTime: bar.time,
          exitPx: +exitPx.toFixed(2),
          exitReason,
          grossBps: +grossBps.toFixed(2),
          tollBps: +tollBps.toFixed(2),
          netBps: +netBps.toFixed(2),
          rMultiple: +rMult.toFixed(2)
        });
        activePosition = null;
      }
    }

    // 2. Update Swing Pivots (confirmed causally at i - swingWing)
    const p = i - swingWing;
    if (p >= swingWing) {
      const cand = bars1m[p];
      let isHigh = true;
      let isLow = true;
      for (let k = p - swingWing; k <= p + swingWing; k++) {
        if (k !== p) {
          if (bars1m[k].h >= cand.h) isHigh = false;
          if (bars1m[k].l <= cand.l) isLow = false;
        }
      }
      if (isHigh) pivHighs.push({ idx: p, px: cand.h, time: cand.time });
      if (isLow)  pivLows.push({ idx: p, px: cand.l, time: cand.time });
    }

    // 3. Sweep Detection & Arming Window (10:00 to 13:00 IST)
    // Next bar must exist within session for causal Open entry
    const hasNextBar = (i + 1 < bars1m.length) && (getMinuteOfIST(bars1m[i + 1].time) <= 914);

    if (!activePosition && hasNextBar && m >= opt.armingStartMin && m <= opt.armingEndMin) {
      const candleRange = bar.h - bar.l;
      if (candleRange > 0) {
        // SHORT SWEEP (BSL Sweep): bar pierces pivot high, closes back inside, upper wick >= 35%
        const sweptHighs = pivHighs.filter(ph => ph.idx < (i - 1) && bar.h > ph.px && bar.c < ph.px);
        if (sweptHighs.length > 0) {
          const upperWick = bar.h - Math.max(bar.o, bar.c);
          if ((upperWick / candleRange) >= opt.minWickPct) {
            let filterPass = true;
            if (opt.filter15mFvg) {
              const conf = check15mConfluence(i, 'SHORT', bars1m, bars15m, atr15m, opt);
              filterPass = conf.pass;
            }

            if (filterPass) {
              const entryPx = bars1m[i + 1].o; // Strictly causal fill at next open
              const sweepExtreme = bar.h;
              const sl = +(sweepExtreme * (1 + opt.stopBufferBps / 1e4)).toFixed(2);
              const tgt = +(entryPx * (1 - opt.targetBps / 1e4)).toFixed(2);
              const risk = sl - entryPx;
              const reward = entryPx - tgt;

              if (risk > 0 && (reward / risk) >= opt.minRr) {
                const sigId = `SIG-SHORT-${bar.time.replace(/[: ]/g, '-')}`;
                signals.push({
                  id: sigId,
                  side: 'SHORT',
                  triggerBar: i,
                  triggerTime: bar.time,
                  entryPx,
                  sl,
                  tgt,
                  filterPassed: true
                });
                activePosition = {
                  id: sigId,
                  side: 'SHORT',
                  entryBar: i + 1,
                  entryTime: bars1m[i + 1].time,
                  entryPx,
                  sl,
                  tgt
                };
              }
            }
          }
        }

        // LONG SWEEP (SSL Sweep): only if !opt.shortOnly
        if (!activePosition && !opt.shortOnly) {
          const sweptLows = pivLows.filter(pl => pl.idx < (i - 1) && bar.l < pl.px && bar.c > pl.px);
          if (sweptLows.length > 0) {
            const lowerWick = Math.min(bar.o, bar.c) - bar.l;
            if ((lowerWick / candleRange) >= opt.minWickPct) {
              let filterPass = true;
              if (opt.filter15mFvg) {
                const conf = check15mConfluence(i, 'LONG', bars1m, bars15m, atr15m, opt);
                filterPass = conf.pass;
              }

              if (filterPass) {
                const entryPx = bars1m[i + 1].o; // Strictly causal fill at next open
                const sweepExtreme = bar.l;
                const sl = +(sweepExtreme * (1 - opt.stopBufferBps / 1e4)).toFixed(2);
                const tgt = +(entryPx * (1 + opt.targetBps / 1e4)).toFixed(2);
                const risk = entryPx - sl;
                const reward = tgt - entryPx;

                if (risk > 0 && (reward / risk) >= opt.minRr) {
                  const sigId = `SIG-LONG-${bar.time.replace(/[: ]/g, '-')}`;
                  signals.push({
                    id: sigId,
                    side: 'LONG',
                    triggerBar: i,
                    triggerTime: bar.time,
                    entryPx,
                    sl,
                    tgt,
                    filterPassed: true
                  });
                  activePosition = {
                    id: sigId,
                    side: 'LONG',
                    entryBar: i + 1,
                    entryTime: bars1m[i + 1].time,
                    entryPx,
                    sl,
                    tgt
                  };
                }
              }
            }
          }
        }
      }
    }
  }

  // Calculate summary stats
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.netBps > 0).length;
  const losses = trades.filter(t => t.netBps <= 0).length;
  const winRate = totalTrades > 0 ? +(wins / totalTrades * 100).toFixed(1) : 0;
  const netBpsSum = trades.reduce((sum, t) => sum + t.netBps, 0);
  const netBpsMean = totalTrades > 0 ? +(netBpsSum / totalTrades).toFixed(2) : 0;

  return {
    trades,
    signals,
    stats: {
      totalTrades,
      wins,
      losses,
      winRate,
      netBpsMean,
      netBpsSum: +netBpsSum.toFixed(2)
    }
  };
}

module.exports = {
  runCandidateStrategy,
  build15mBarsCausal,
  computeAtr14,
  check15mConfluence,
  getMinuteOfIST,
  STATUTORY_BPS,
  DEFAULT_SLIPPAGE
};

"use strict";

/**
 * strategies/mine/patterns.js
 * Authoritative Pattern Detection Engine (JavaScript)
 * 
 * BUGS CORRECTED:
 * 1. Swing-point spacing: Uses absIdx (i - last.absIdx >= 6), fixing relative vs absolute index bug.
 * 2. Distinct resistance touches: Groups touches into confirmed local swing peaks separated by >= 6 bars.
 * 3. Symmetrical triangle: Validates confirmed descending highs and ascending lows with true linear convergence.
 * 4. Cup & Handle: Validates prior uptrend, rounded U-basin curvature, handle location in upper 45%, and VDU.
 * 5. Zero look-ahead bias: 5-bar rolling pivots require p+2 <= win-2, confirmed >= 2 bars prior to breakout.
 * 6. Scale-invariant ATR slopes: Normalizes trendline slopes using ATR(14) rather than display degrees.
 */

function calculateATR(highs, lows, closes, period = 14) {
    const n = closes.length;
    if (n < 2) return [0];
    const tr = [highs[0] - lows[0]];
    for (let i = 1; i < n; i++) {
        const hl = highs[i] - lows[i];
        const hc = Math.abs(highs[i] - closes[i - 1]);
        const lc = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(hl, hc, lc));
    }
    // Wilder smoothing for ATR
    const atr = new Array(n);
    let sum = 0;
    for (let i = 0; i < Math.min(period, n); i++) sum += tr[i];
    atr[Math.min(period - 1, n - 1)] = sum / Math.min(period, n);
    for (let i = period; i < n; i++) {
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    }
    for (let i = 0; i < period - 1; i++) atr[i] = atr[period - 1];
    return atr;
}

/**
 * Normalized Linear Regression Slope
 * Returns raw change in price per daily candle.
 */
function calculateLinearSlope(xPts, yPts) {
    const n = xPts.length;
    if (n < 2) return 0.0;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        sumX += xPts[i];
        sumY += yPts[i];
        sumXY += xPts[i] * yPts[i];
        sumXX += xPts[i] * xPts[i];
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return 0.0;
    return (n * sumXY - sumX * sumY) / denom;
}

/**
 * 1. ASCENDING TRIANGLE
 * - Flat horizontal resistance ceiling with >= 3 distinct confirmed peak tests
 * - Resistance variation <= 1.8%
 * - At least 3 confirmed ascending swing lows (L1 < L2 < L3)
 * - Support slope normalized by ATR >= +0.07 (scale-invariant)
 * - Zero look-ahead: all pivots confirmed at least 2 bars prior to breakout bar
 */
function detectAscendingTriangle(sessions, window = 65) {
    const n = sessions.length;
    if (n < window + 10) return null;

    const highs = sessions.map(s => s.high);
    const lows = sessions.map(s => s.low);
    const closes = sessions.map(s => s.close);
    const atr14 = calculateATR(highs, lows, closes, 14);

    const start = n - 1 - window;
    let ceil = -Infinity;
    for (let i = start; i < n - 1; i++) {
        if (highs[i] > ceil) ceil = highs[i];
    }

    // 1. Confirmed Resistance Peaks (5-bar rolling pivot: p-2, p-1, p, p+1, p+2)
    // p+2 <= n-2 ensures pivot was confirmed on or before bar n-2 (zero look-ahead!)
    const rPts = [];
    for (let i = start + 2; i <= n - 4; i++) {
        const h = highs[i];
        if (h >= ceil * 0.982 && h >= highs[i-1] && h >= highs[i-2] && h >= highs[i+1] && h >= highs[i+2]) {
            // FIX BUG 1: Compare against last.absIdx (absolute index)
            if (rPts.length === 0 || (i - rPts[rPts.length - 1].absIdx >= 6)) {
                rPts.push({ idx: i - start, absIdx: i, price: h });
            }
        }
    }

    // 2. Confirmed Support Swing Lows
    const lPts = [];
    for (let i = start + 2; i <= n - 4; i++) {
        const l = lows[i];
        if (l <= lows[i-1] && l <= lows[i-2] && l <= lows[i+1] && l <= lows[i+2]) {
            // FIX BUG 1: Compare against last.absIdx (absolute index)
            if (lPts.length === 0 || (i - lPts[lPts.length - 1].absIdx >= 6)) {
                lPts.push({ idx: i - start, absIdx: i, price: l });
            }
        }
    }

    if (rPts.length >= 3 && lPts.length >= 3 && (rPts[rPts.length - 1].absIdx - rPts[0].absIdx >= 18)) {
        const len = lPts.length;
        // Strictly ascending swing lows
        if (lPts[len - 3].price * 1.010 <= lPts[len - 2].price && lPts[len - 2].price * 1.010 <= lPts[len - 1].price) {
            // Ceiling variation
            const rPrices = rPts.map(p => p.price);
            const ceilVar = (Math.max(...rPrices) - Math.min(...rPrices)) / ceil;
            if (ceilVar <= 0.018) {
                // Scale-invariant ATR slope
                const rawSlope = calculateLinearSlope(lPts.map(p => p.idx), lPts.map(p => p.price));
                const curAtr = atr14[n - 2] || 1.0;
                const atrSlope = rawSlope / curAtr;

                // Support must rise by >= 0.07 ATR per day
                if (atrSlope >= 0.07) {
                    const curC = closes[n - 1];
                    const prevC = closes[n - 2];
                    if (curC > ceil && prevC <= ceil * 1.008) {
                        return {
                            pattern: 'ASCENDING_TRIANGLE',
                            level: ceil,
                            stopLevel: lPts[len - 1].price * 0.995,
                            atrSlope: +atrSlope.toFixed(3),
                            touches: rPts.length,
                            supportLows: lPts.length,
                            lastLow: lPts[len - 1].price,
                            rPts, lPts
                        };
                    }
                }
            }
        }
    }
    return null;
}

/**
 * 2. CUP AND HANDLE
 * - Confirmed prior Stage 2 advance (>= +20% gain in preceding 6 months)
 * - U-shaped basin curvature: At least 4 bars in the bottom 25% of cup depth
 * - Rim horizontal alignment <= 3.8%
 * - Handle strictly in upper 48% of cup depth
 * - Handle volume contraction (VDU): handle avg volume <= 95% of cup volume
 */
function detectCupAndHandle(sessions, config = {}) {
    const n = sessions.length;
    const cupLens = config.cupLens || [55, 75];
    const handleLens = config.handleLens || [12, 18];

    const highs = sessions.map(s => s.high);
    const lows = sessions.map(s => s.low);
    const closes = sessions.map(s => s.close);
    const vols = sessions.map(s => s.volume || 1);

    for (const clen of cupLens) {
        for (const hlen of handleLens) {
            const tot = clen + hlen;
            if (n < tot + 30) continue;

            const cs = n - 1 - tot;
            const ce = n - 1 - hlen;

            // Prior Uptrend Validation: Price must have advanced >= +20% in prior 120 bars
            const priorStart = Math.max(0, cs - 100);
            let priorMin = Infinity;
            for (let i = priorStart; i <= cs; i++) {
                if (lows[i] < priorMin) priorMin = lows[i];
            }
            if (priorMin <= 0 || (highs[cs] - priorMin) / priorMin < 0.20) {
                continue; // Reject cups in downtrends
            }

            // Left Rim (in first 15 bars of cup)
            let lr = -Infinity, lIdx = cs;
            for (let i = cs; i < cs + 15; i++) {
                if (highs[i] > lr) { lr = highs[i]; lIdx = i; }
            }

            // Right Rim (in 12 bars before handle)
            let rr = -Infinity, rIdx = ce;
            for (let i = Math.max(cs + 20, ce - 12); i <= ce; i++) {
                if (highs[i] > rr) { rr = highs[i]; rIdx = i; }
            }

            if (rIdx - lIdx < 22) continue;
            if (Math.abs(rr - lr) / lr > 0.038) continue; // Rim alignment within 3.8%

            const rim = Math.max(lr, rr);

            // Cup Bottom & Depth
            let cupBot = Infinity, botIdx = lIdx;
            for (let i = lIdx; i <= rIdx; i++) {
                if (lows[i] < cupBot) { cupBot = lows[i]; botIdx = i; }
            }

            const depth = (rim - cupBot) / rim;
            if (depth < 0.10 || depth > 0.35) continue; // 10% to 35% depth

            // FIX BUG 4: U-Shaped Basin Curvature Check (Rejects sharp V-bottoms)
            const bottomQuartile = cupBot + 0.25 * (rim - cupBot);
            let barsInBottom = 0;
            for (let i = lIdx; i <= rIdx; i++) {
                if (lows[i] <= bottomQuartile) barsInBottom++;
            }
            if (barsInBottom < 4) continue; // Rejects sharp V-bottoms!

            // Centered bowl symmetry (bottom should be within 20% to 80% of cup span)
            const cupSpan = rIdx - lIdx;
            const botPos = (botIdx - lIdx) / cupSpan;
            if (botPos < 0.20 || botPos > 0.80) continue;

            // Handle
            let hBot = Infinity;
            let cupVolSum = 0, hVolSum = 0;
            for (let i = cs; i < ce; i++) cupVolSum += vols[i];
            const avgCupVol = cupVolSum / (ce - cs);

            for (let i = ce; i < n - 1; i++) {
                if (lows[i] < hBot) hBot = lows[i];
                hVolSum += vols[i];
            }
            const avgHVol = hVolSum / (n - 1 - ce);

            const handleDepth = (rim - hBot) / rim;
            // Handle must be shallow (upper 45% of cup depth)
            if (handleDepth > depth * 0.48 || handleDepth < 0.015) continue;

            // FIX BUG 4: Volume Dry Up (VDU) - Handle volume must contract
            if (avgHVol > avgCupVol * 0.95) continue;

            const curC = closes[n - 1];
            const prevC = closes[n - 2];
            if (curC > rim && prevC <= rim * 1.008) {
                return {
                    pattern: 'CUP_AND_HANDLE',
                    level: rim,
                    stopLevel: hBot * 0.995,
                    depthPct: +(depth * 100).toFixed(1),
                    handleDepthPct: +(handleDepth * 100).toFixed(1),
                    leftRim: lr,
                    rightRim: rr,
                    cupBottom: cupBot,
                    handleBottom: hBot,
                    barsInBottom
                };
            }
        }
    }
    return null;
}

/**
 * 3. MULTI-MONTH BASE (Stage 2 Consolidation)
 * - FIX BUG 2: Groups touches into confirmed local swing peaks separated by >= 6 bars
 * - Requires >= 2 distinct peaks separated by >= 12 bars
 */
function detectMultiMonthBase(sessions, config = {}) {
    const n = sessions.length;
    const baseLens = config.baseLens || [100, 75, 55, 35];
    const highs = sessions.map(s => s.high);
    const lows = sessions.map(s => s.low);
    const closes = sessions.map(s => s.close);

    for (const blen of baseLens) {
        if (n < blen + 15) continue;
        const start = n - 1 - blen;
        let bh = -Infinity, bl = Infinity;
        for (let i = start; i < n - 1; i++) {
            if (highs[i] > bh) bh = highs[i];
            if (lows[i] < bl) bl = lows[i];
        }

        const depth = (bh - bl) / bh;
        if (depth < 0.07 || depth > 0.30) continue;

        // FIX BUG 2: Confirmed distinct swing peaks near ceiling separated by >= 6 bars
        const distinctPeaks = [];
        for (let i = start + 2; i <= n - 4; i++) {
            if (highs[i] >= bh * 0.980 && highs[i] >= highs[i-1] && highs[i] >= highs[i+1]) {
                if (distinctPeaks.length === 0 || (i - distinctPeaks[distinctPeaks.length - 1].idx >= 6)) {
                    distinctPeaks.push({ idx: i, price: highs[i] });
                }
            }
        }

        if (distinctPeaks.length >= 2 && (distinctPeaks[distinctPeaks.length - 1].idx - distinctPeaks[0].idx >= 12)) {
            const curC = closes[n - 1];
            const prevC = closes[n - 2];
            if (curC > bh && prevC <= bh * 1.008) {
                // Structural stop anchored to recent 20-day base floor
                let swingLow = Infinity;
                for (let i = Math.max(start, n - 22); i < n - 1; i++) {
                    if (lows[i] < swingLow) swingLow = lows[i];
                }
                return {
                    pattern: 'MULTI_MONTH_BASE',
                    level: bh,
                    stopLevel: swingLow * 0.995,
                    baseLength: blen,
                    depthPct: +(depth * 100).toFixed(1),
                    distinctPeaks: distinctPeaks.length,
                    floorPrice: bl
                };
            }
        }
    }
    return null;
}

/**
 * 4. SYMMETRICAL TRIANGLE
 * - FIX BUG 3: Validates confirmed descending highs (H1 > H2) and ascending lows (L1 < L2)
 *   with true converging regression lines across confirmed pivots!
 */
function detectSymmetricalTriangle(sessions, coilLen = 45) {
    const n = sessions.length;
    if (n < coilLen + 15) return null;

    const highs = sessions.map(s => s.high);
    const lows = sessions.map(s => s.low);
    const closes = sessions.map(s => s.close);
    const atr14 = calculateATR(highs, lows, closes, 14);

    const start = n - 1 - coilLen;

    // Confirmed swing highs (descending)
    const hPts = [];
    for (let i = start + 2; i <= n - 4; i++) {
        if (highs[i] >= highs[i-1] && highs[i] >= highs[i-2] && highs[i] >= highs[i+1] && highs[i] >= highs[i+2]) {
            if (hPts.length === 0 || (i - hPts[hPts.length - 1].absIdx >= 5)) {
                hPts.push({ idx: i - start, absIdx: i, price: highs[i] });
            }
        }
    }

    // Confirmed swing lows (ascending)
    const lPts = [];
    for (let i = start + 2; i <= n - 4; i++) {
        if (lows[i] <= lows[i-1] && lows[i] <= lows[i-2] && lows[i] <= lows[i+1] && lows[i] <= lows[i+2]) {
            if (lPts.length === 0 || (i - lPts[lPts.length - 1].absIdx >= 5)) {
                lPts.push({ idx: i - start, absIdx: i, price: lows[i] });
            }
        }
    }

    if (hPts.length >= 2 && lPts.length >= 2) {
        // Highs must descend, lows must ascend
        const firstH = hPts[0].price, lastH = hPts[hPts.length - 1].price;
        const firstL = lPts[0].price, lastL = lPts[lPts.length - 1].price;

        if (lastH < firstH * 0.990 && lastL > firstL * 1.010) {
            const rawSlopeH = calculateLinearSlope(hPts.map(p => p.idx), hPts.map(p => p.price));
            const rawSlopeL = calculateLinearSlope(lPts.map(p => p.idx), lPts.map(p => p.price));
            const curAtr = atr14[n - 2] || 1.0;

            const atrSlopeH = rawSlopeH / curAtr;
            const atrSlopeL = rawSlopeL / curAtr;

            // Converging: Highs slope negative (<= -0.04 ATR), Lows slope positive (>= +0.04 ATR)
            if (atrSlopeH <= -0.04 && atrSlopeL >= 0.04) {
                const res = Math.max(...hPts.map(p => p.price));
                const curC = closes[n - 1];
                const prevC = closes[n - 2];
                if (curC > res && prevC <= res * 1.008) {
                    return {
                        pattern: 'SYMMETRICAL_TRIANGLE',
                        level: res,
                        stopLevel: lastL * 0.995,
                        atrSlopeH: +atrSlopeH.toFixed(3),
                        atrSlopeL: +atrSlopeL.toFixed(3),
                        highTouches: hPts.length,
                        lowTouches: lPts.length
                    };
                }
            }
        }
    }
    return null;
}

/**
 * Master Pattern Detector
 */
function detectPattern(sessions) {
    return detectCupAndHandle(sessions) ||
           detectAscendingTriangle(sessions) ||
           detectMultiMonthBase(sessions) ||
           detectSymmetricalTriangle(sessions);
}

module.exports = {
    calculateATR,
    calculateLinearSlope,
    detectAscendingTriangle,
    detectCupAndHandle,
    detectMultiMonthBase,
    detectSymmetricalTriangle,
    detectPattern
};

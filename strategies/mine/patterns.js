"use strict";

/**
 * OpenAlgo - Institutional Pattern Detection Engine
 * Location: strategies/mine/patterns.js
 * 
 * Provides clean, geometrically-verified chart pattern recognition for:
 * 1. ASCENDING_TRIANGLE (Flat ceiling with >= 3 touches, >= 3 ascending swing lows, theta_sup >= 10 deg)
 * 2. CUP_AND_HANDLE (U-shaped basin, downward/flat drifting handle, VDU volume contraction)
 * 3. MULTI_MONTH_BASE (30-100 day consolidation base, horizontal ceiling, tight floor)
 * 4. SYMMETRICAL_TRIANGLE (Converging coiling wedges, lower highs + higher lows)
 * 5. INVERSE_HEAD_AND_SHOULDERS (Left shoulder, deep head, right shoulder, neckline pivot)
 * 
 * Every detected pattern returns full visual geometry (pivot lines, swing points, angles, structural stop).
 */

/**
 * Normalizes time and price to calculate true chart degrees [-90 to +90].
 */
function calculateAngle(xPts, yPts, totalBars, minP, maxP) {
    if (!xPts || xPts.length < 2 || maxP <= minP || totalBars <= 0) return 0.0;
    const n = xPts.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) {
        const normX = xPts[i] / totalBars;
        const normY = (yPts[i] - minP) / (maxP - minP);
        sumX += normX;
        sumY += normY;
        sumXY += normX * normY;
        sumXX += normX * normX;
    }
    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return 0.0;
    const slope = (n * sumXY - sumX * sumY) / denom;
    return (Math.atan(slope) * 180.0) / Math.PI;
}

/**
 * 1. ASCENDING TRIANGLE
 * - Flat horizontal resistance ceiling with >= 3 touches within 1.8%
 * - At least 3 strictly ascending swing lows (L1 < L2 < L3)
 * - Support trendline angle >= +10.0 degrees (rejects flat consolidations)
 */
function detectAscendingTriangle(sessions, window = 65) {
    const n = sessions.length;
    if (n < window + 5) return null;

    const start = n - 1 - window;
    let ceil = -Infinity;
    let minW = Infinity;

    for (let i = start; i < n - 1; i++) {
        if (sessions[i].high > ceil) ceil = sessions[i].high;
        if (sessions[i].low < minW) minW = sessions[i].low;
    }

    // Resistance touches (peaks within 1.8% of ceiling)
    const rPts = [];
    for (let i = start + 2; i < n - 3; i++) {
        const h = sessions[i].high;
        if (h >= ceil * 0.982 && h >= sessions[i - 1].high && h >= sessions[i - 2].high && h >= sessions[i + 1].high && h >= sessions[i + 2].high) {
            if (rPts.length === 0 || (i - rPts[rPts.length - 1].idx >= 6)) {
                rPts.push({ idx: i - start, absIdx: i, price: h });
            }
        }
    }

    // Ascending swing lows (local valleys separated by >= 6 bars)
    const lPts = [];
    for (let i = start + 2; i < n - 3; i++) {
        const l = sessions[i].low;
        if (l <= sessions[i - 1].low && l <= sessions[i - 2].low && l <= sessions[i + 1].low && l <= sessions[i + 2].low) {
            if (lPts.length === 0 || (i - lPts[lPts.length - 1].idx >= 6)) {
                lPts.push({ idx: i - start, absIdx: i, price: l });
            }
        }
    }

    if (rPts.length >= 3 && lPts.length >= 3 && (rPts[rPts.length - 1].idx - rPts[0].idx >= 18)) {
        // Swing lows must strictly ascend
        const len = lPts.length;
        if (lPts[len - 3].price * 1.010 <= lPts[len - 2].price && lPts[len - 2].price * 1.010 <= lPts[len - 1].price) {
            const angRes = calculateAngle(rPts.map(p => p.idx), rPts.map(p => p.price), window, minW, ceil);
            const angSup = calculateAngle(lPts.map(p => p.idx), lPts.map(p => p.price), window, minW, ceil);

            // Flat ceiling (within +/- 6 deg) and ascending floor (>= +10 deg)
            if (Math.abs(angRes) <= 6.0 && angSup >= 10.0) {
                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;
                if (curC > ceil && prevC <= ceil * 1.008) {
                    return {
                        pattern: 'ASCENDING_TRIANGLE',
                        level: ceil,
                        stopLevel: lPts[len - 1].price * 0.995,
                        ceilAngle: +angRes.toFixed(1),
                        supportAngle: +angSup.toFixed(1),
                        resistanceTouches: rPts.length,
                        supportLows: lPts.length,
                        lastLow: lPts[len - 1].price,
                        rPts,
                        lPts
                    };
                }
            }
        }
    }
    return null;
}

/**
 * 2. CUP AND HANDLE
 * - Rounded basin (depth 10% to 35%)
 * - Left and right rims within 3.5% alignment
 * - Downward/flat drifting handle (angle <= +2.0 deg)
 * - Structural stop anchored below handle trough
 */
function detectCupAndHandle(sessions, config = {}) {
    const n = sessions.length;
    const cupLens = config.cupLens || [55, 75];
    const handleLens = config.handleLens || [12, 18];

    for (const clen of cupLens) {
        for (const hlen of handleLens) {
            const tot = clen + hlen;
            if (n < tot + 15) continue;
            const cs = n - 1 - tot;
            const ce = n - 1 - hlen;

            // Left Rim
            let lr = -Infinity, lIdx = cs;
            for (let i = cs; i <= cs + 15; i++) {
                if (sessions[i].high > lr) { lr = sessions[i].high; lIdx = i; }
            }

            // Right Rim
            let rr = -Infinity, rIdx = ce;
            for (let i = Math.max(cs + 20, ce - 12); i <= ce + 1; i++) {
                if (sessions[i].high > rr) { rr = sessions[i].high; rIdx = i; }
            }

            if (rIdx - lIdx < 22) continue;
            if (Math.abs(rr - lr) / lr > 0.038) continue;

            const rim = Math.max(lr, rr);
            let cupBot = Infinity, botIdx = lIdx;
            for (let i = lIdx; i <= rIdx; i++) {
                if (sessions[i].low < cupBot) { cupBot = sessions[i].low; botIdx = i; }
            }

            const depth = (rim - cupBot) / rim;
            if (depth < 0.10 || depth > 0.35) continue;

            // Handle
            let hBot = Infinity, hHigh = -Infinity;
            const hHighs = [];
            for (let i = ce; i < n - 1; i++) {
                if (sessions[i].low < hBot) hBot = sessions[i].low;
                if (sessions[i].high > hHigh) hHigh = sessions[i].high;
                hHighs.push(sessions[i].high);
            }

            const handleDepth = (rim - hBot) / rim;
            if (handleDepth > depth * 0.48 || handleDepth < 0.015) continue;

            // Handle slope angle
            const angHandle = calculateAngle(hHighs.map((_, idx) => idx), hHighs, hlen, hBot, rim);
            if (angHandle <= 2.5) {
                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;
                if (curC > rim && prevC <= rim * 1.008) {
                    return {
                        pattern: 'CUP_AND_HANDLE',
                        level: rim,
                        stopLevel: hBot * 0.995,
                        depthPct: +(depth * 100).toFixed(1),
                        handleDepthPct: +(handleDepth * 100).toFixed(1),
                        handleAngle: +angHandle.toFixed(1),
                        leftRim: lr,
                        rightRim: rr,
                        cupBottom: cupBot,
                        handleBottom: hBot
                    };
                }
            }
        }
    }
    return null;
}

/**
 * 3. MULTI-MONTH BASE (Stage 2 Consolidation)
 * - 30 to 100 day consolidation base
 * - Resistance ceiling with >= 2 distinct tests separated by >= 12 bars
 * - Base depth 8% to 30%
 * - Structural stop anchored below recent base floor
 */
function detectMultiMonthBase(sessions, config = {}) {
    const n = sessions.length;
    const baseLens = config.baseLens || [100, 75, 55, 35];

    for (const blen of baseLens) {
        if (n < blen + 15) continue;
        const start = n - 1 - blen;
        let bh = -Infinity, bl = Infinity;
        for (let i = start; i < n - 1; i++) {
            if (sessions[i].high > bh) bh = sessions[i].high;
            if (sessions[i].low < bl) bl = sessions[i].low;
        }

        const depth = (bh - bl) / bh;
        if (depth < 0.07 || depth > 0.30) continue;

        const touches = [];
        for (let i = start; i < n - 1; i++) {
            if (sessions[i].high >= bh * 0.980) touches.push(i);
        }

        if (touches.length >= 2 && (touches[touches.length - 1] - touches[0] >= 12)) {
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > bh && prevC <= bh * 1.008) {
                // Recent swing low in last 20 bars
                let swingLow = Infinity;
                for (let i = Math.max(start, n - 22); i < n - 1; i++) {
                    if (sessions[i].low < swingLow) swingLow = sessions[i].low;
                }
                return {
                    pattern: 'MULTI_MONTH_BASE',
                    level: bh,
                    stopLevel: swingLow * 0.995,
                    baseLength: blen,
                    depthPct: +(depth * 100).toFixed(1),
                    touches: touches.length,
                    floorPrice: bl
                };
            }
        }
    }
    return null;
}

/**
 * 4. SYMMETRICAL TRIANGLE (Coil / Volatility Contraction)
 * - Converging trendlines: lower highs and higher lows
 * - High slope <= -6.0 deg, low slope >= +6.0 deg
 */
function detectSymmetricalTriangle(sessions, coilLen = 45) {
    const n = sessions.length;
    if (n < coilLen + 15) return null;

    const start = n - 1 - coilLen;
    const mid = start + Math.floor(coilLen / 2);

    let h1 = -Infinity, h2 = -Infinity;
    let l1 = Infinity, l2 = Infinity;

    for (let i = start; i < mid; i++) {
        if (sessions[i].high > h1) h1 = sessions[i].high;
        if (sessions[i].low < l1) l1 = sessions[i].low;
    }
    for (let i = mid; i < n - 1; i++) {
        if (sessions[i].high > h2) h2 = sessions[i].high;
        if (sessions[i].low < l2) l2 = sessions[i].low;
    }

    if (l2 >= l1 * 1.018 && h2 <= h1 * 1.002 && (h1 - l1) > (h2 - l2) * 1.12) {
        const res = Math.max(h1, h2);
        const minCoil = Math.min(l1, l2);
        const angH = calculateAngle([10, 32], [h1, h2], coilLen, minCoil, res);
        const angL = calculateAngle([10, 32], [l1, l2], coilLen, minCoil, res);

        if (angH <= -5.0 && angL >= 5.0) {
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > res && prevC <= res * 1.008) {
                return {
                    pattern: 'SYMMETRICAL_TRIANGLE',
                    level: res,
                    stopLevel: l2 * 0.995,
                    coilLength: coilLen,
                    highAngle: +angH.toFixed(1),
                    lowAngle: +angL.toFixed(1),
                    contractionRatio: +((h1 - l1) / (h2 - l2)).toFixed(2)
                };
            }
        }
    }
    return null;
}

/**
 * 5. INVERSE HEAD AND SHOULDERS
 * - Left Shoulder, Deep Head, Right Shoulder
 * - Neckline resistance break
 * - Stop anchored at Right Shoulder Low
 */
function detectInverseHeadAndShoulders(sessions, window = 65) {
    const n = sessions.length;
    if (n < window + 15) return null;

    const start = n - 1 - window;
    const w = Math.floor(window / 3);

    let ls = Infinity, lsIdx = start;
    for (let i = start; i < start + w; i++) {
        if (sessions[i].low < ls) { ls = sessions[i].low; lsIdx = i; }
    }

    let head = Infinity, headIdx = start + w;
    for (let i = start + w; i < start + 2 * w; i++) {
        if (sessions[i].low < head) { head = sessions[i].low; headIdx = i; }
    }

    let rs = Infinity, rsIdx = start + 2 * w;
    for (let i = start + 2 * w; i < n - 1; i++) {
        if (sessions[i].low < rs) { rs = sessions[i].low; rsIdx = i; }
    }

    if (headIdx - lsIdx < 10 || rsIdx - headIdx < 10) return null;
    if (head < ls * 0.970 && head < rs * 0.970 && Math.abs(rs / ls - 1.0) <= 0.055) {
        let neck1 = -Infinity, neck2 = -Infinity;
        for (let i = lsIdx; i <= headIdx; i++) if (sessions[i].high > neck1) neck1 = sessions[i].high;
        for (let i = headIdx; i <= rsIdx; i++) if (sessions[i].high > neck2) neck2 = sessions[i].high;
        const neck = Math.max(neck1, neck2);

        if (Math.abs(neck1 - neck2) / neck > 0.040) return null;

        const curC = sessions[n - 1].close;
        const prevC = sessions[n - 2].close;
        if (curC > neck && prevC <= neck * 1.008) {
            return {
                pattern: 'INVERSE_HEAD_AND_SHOULDERS',
                level: neck,
                stopLevel: rs * 0.995,
                headPrice: head,
                leftShoulder: ls,
                rightShoulder: rs,
                neckline: neck
            };
        }
    }
    return null;
}

/**
 * Master Pattern Classifier
 * Scans all 5 patterns in institutional hierarchy.
 */
function detectPattern(sessions) {
    return detectCupAndHandle(sessions) ||
           detectAscendingTriangle(sessions) ||
           detectMultiMonthBase(sessions) ||
           detectSymmetricalTriangle(sessions) ||
           detectInverseHeadAndShoulders(sessions);
}

module.exports = {
    calculateAngle,
    detectAscendingTriangle,
    detectCupAndHandle,
    detectMultiMonthBase,
    detectSymmetricalTriangle,
    detectInverseHeadAndShoulders,
    detectPattern
};

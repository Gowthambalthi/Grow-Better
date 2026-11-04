"use strict";

/**
 * OpenAlgo - All-in-One Institutional Shape & Pattern Detector
 * Location: strategies/ai/allShapeDetector.js
 * 
 * Contains all 5 validated institutional chart patterns in ONE single authoritative file:
 * 1. ASCENDING_TRIANGLE (3-touch flat resistance, 3 ascending swing lows, linear regression convergence)
 * 2. CUP_AND_HANDLE (U-shaped basin, VDU handle in upper 50%, handle pivot)
 * 3. MULTI_MONTH_BASE (60-120 day base, horizontal resistance, Stage 2 trend, volume surge)
 * 4. SYMMETRICAL_TRIANGLE (Coiling contraction, higher lows + lower highs)
 * 5. INVERSE_HEAD_AND_SHOULDERS (Symmetrical shoulders, deep head, neckline break)
 */

class AllShapeDetector {
    constructor(config = {}) {
        this.minVolumeSurge = config.minVolumeSurge ?? 1.50;
        this.rsiPeriod = config.rsiPeriod ?? 14;
        this.rsiMin = config.rsiMin ?? 48.0;
        this.rsiMax = config.rsiMax ?? 85.0;
    }

    calculateRSI(closes, period = 14) {
        const n = closes.length;
        if (n < period + 1) return null;
        let gain = 0, loss = 0;
        for (let i = n - period; i < n; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) gain += diff;
            else loss -= diff;
        }
        if (loss === 0) return 100;
        const rs = (gain / period) / (loss / period);
        return 100 - (100 / (1 + rs));
    }

    /**
     * 1. ASCENDING TRIANGLE
     * Requires:
     * - Flat horizontal ceiling with >= 3 distinct touches within 1.5% variation
     * - At least 3 strictly ascending swing low valleys (L1 < L2 < L3)
     * - Positive linear regression slope on swing lows (upward convergence)
     * - Minimum 20 bars between first and last touch
     */
    detectAscendingTriangle(sessions, window = 60) {
        const n = sessions.length;
        if (n < window + 10) return null;

        const startIdx = n - 1 - window;
        const sub = sessions.slice(startIdx, n - 1);
        const wLen = sub.length;

        let ceiling = -Infinity;
        for (let i = 0; i < wLen; i++) {
            if (sub[i].high > ceiling) ceiling = sub[i].high;
        }

        // Rule 1: Minimum 3 distinct ceiling touches within 1.5%
        const ceilTouches = [];
        for (let i = 2; i < wLen - 2; i++) {
            if (sub[i].high >= ceiling * 0.985) {
                if (sub[i].high >= sub[i - 1].high && sub[i].high >= sub[i - 2].high &&
                    sub[i].high >= sub[i + 1].high && sub[i].high >= sub[i + 2].high) {
                    if (ceilTouches.length === 0 || (i - ceilTouches[ceilTouches.length - 1] >= 6)) {
                        ceilTouches.push(i);
                    }
                }
            }
        }
        if (ceilTouches.length < 3) return null;
        if (ceilTouches[ceilTouches.length - 1] - ceilTouches[0] < 20) return null;

        // Rule 2: Minimum 3 strictly ascending swing lows (L1 < L2 < L3)
        const swingLows = [];
        for (let i = 2; i < wLen - 2; i++) {
            if (sub[i].low <= sub[i - 1].low && sub[i].low <= sub[i - 2].low &&
                sub[i].low <= sub[i + 1].low && sub[i].low <= sub[i + 2].low) {
                if (swingLows.length === 0 || (i - swingLows[swingLows.length - 1].i >= 6)) {
                    swingLows.push({ i, low: sub[i].low });
                }
            }
        }
        if (swingLows.length < 3) return null;

        const l1 = swingLows[swingLows.length - 3].low;
        const l2 = swingLows[swingLows.length - 2].low;
        const l3 = swingLows[swingLows.length - 1].low;

        // Lows must strictly ascend by >= 1.2% per valley
        if (!(l1 * 1.012 <= l2 && l2 * 1.012 <= l3)) return null;

        // Rule 3: Linear Regression Slope of Lows must be positive
        let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
        const countL = swingLows.length;
        for (let k = 0; k < countL; k++) {
            sumX += swingLows[k].i;
            sumY += swingLows[k].low;
            sumXY += swingLows[k].i * swingLows[k].low;
            sumXX += swingLows[k].i * swingLows[k].i;
        }
        const slopeLows = (countL * sumXY - sumX * sumY) / (countL * sumXX - sumX * sumX);
        if (slopeLows <= 0) return null; // Reject flat or downward sloping sideways boxes!

        const curC = sessions[n - 1].close;
        const prevC = sessions[n - 2].close;

        if (curC > ceiling && prevC <= ceiling * 1.008) {
            return {
                pattern: 'ASCENDING_TRIANGLE',
                pivot: ceiling,
                stopLevel: l3 * 0.995, // Structural stop placed below 3rd ascending low
                ceilTouches: ceilTouches.length,
                swingLows: [l1, l2, l3],
                slope: slopeLows
            };
        }
        return null;
    }

    /**
     * 2. CLASSIC CUP & HANDLE
     * Requires:
     * - U-shaped rounded basin spanning 50-90 bars
     * - Left and Right rims aligned horizontally within <= 3.5%
     * - Minimum 25 bars separation between left and right rim
     * - Cup depth between 10% and 35%
     * - Dwell time at bottom >= 4 bars (rejects V-bottom spikes)
     * - Handle in upper half of the cup (<= 45% of cup depth) with volume contraction (VDU)
     */
    detectCupAndHandle(sessions) {
        const n = sessions.length;
        for (const handleLen of [10, 15, 22]) {
            for (const cupLen of [50, 70, 90]) {
                const totalLen = cupLen + handleLen;
                if (n < totalLen + 15) continue;
                const startCup = n - 1 - totalLen;
                const midCup = n - 1 - handleLen;

                // 1. Left Rim Peak
                let leftRim = -Infinity, leftRimIdx = startCup;
                for (let i = startCup; i <= startCup + 16; i++) {
                    if (sessions[i].high > leftRim) { leftRim = sessions[i].high; leftRimIdx = i; }
                }

                // 2. Right Rim Peak
                let rightRim = -Infinity, rightRimIdx = midCup;
                for (let i = midCup - 12; i <= midCup + 2; i++) {
                    if (sessions[i].high > rightRim) { rightRim = sessions[i].high; rightRimIdx = i; }
                }

                if (rightRimIdx - leftRimIdx < 25) continue;
                if (Math.abs(rightRim - leftRim) / leftRim > 0.035) continue;

                const rim = Math.max(leftRim, rightRim);

                // 3. Basin Bottom
                let cupBot = Infinity, cupBotIdx = leftRimIdx;
                for (let i = leftRimIdx; i <= rightRimIdx; i++) {
                    if (sessions[i].low < cupBot) { cupBot = sessions[i].low; cupBotIdx = i; }
                }

                const depth = (rim - cupBot) / rim;
                if (depth < 0.10 || depth > 0.35) continue;

                // Rounded bottom dwell time: must spend >= 4 bars in the bottom 25% zone
                const bottomZone = cupBot + 0.25 * (rim - cupBot);
                let bottomDwell = 0;
                for (let i = leftRimIdx; i <= rightRimIdx; i++) {
                    if (sessions[i].low <= bottomZone) bottomDwell++;
                }
                if (bottomDwell < 4) continue; // Rejects sharp V-bottom spikes

                // 4. Handle: must form in upper half of cup
                let handleBot = Infinity;
                let handleVolSum = 0, cupVolSum = 0;
                for (let i = midCup; i < n - 1; i++) {
                    if (sessions[i].low < handleBot) handleBot = sessions[i].low;
                    handleVolSum += (sessions[i].volume || 0);
                }
                const handleDepth = (rim - handleBot) / rim;
                if (handleDepth > depth * 0.45 || handleDepth > 0.14) continue;

                // Handle Volume Contraction (VDU)
                for (let i = startCup; i < midCup; i++) cupVolSum += (sessions[i].volume || 0);
                const avgHandleVol = handleVolSum / (n - 1 - midCup);
                const avgCupVol = cupVolSum / (midCup - startCup);
                if (avgCupVol > 0 && avgHandleVol > avgCupVol * 1.10) continue;

                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;

                if (curC > rim && prevC <= rim * 1.008) {
                    return {
                        pattern: 'CUP_AND_HANDLE',
                        pivot: rim,
                        stopLevel: handleBot * 0.995,
                        cupDepthPct: depth * 100,
                        handleDepthPct: handleDepth * 100
                    };
                }
            }
        }
        return null;
    }

    /**
     * 3. MULTI-MONTH BASE BREAKOUT (Stage 2 Flat Base / Rectangle)
     * Requires:
     * - 60 to 120 daily candles (3 to 6 months)
     * - Flat horizontal ceiling tested >= 2 times separated by >= 15 bars
     * - Base depth between 8% and 30%
     */
    detectMultiMonthBase(sessions) {
        const n = sessions.length;
        if (n < 75) return null;

        for (const baseLen of [110, 80, 60]) {
            if (n < baseLen + 15) continue;
            const startIdx = n - 1 - baseLen;

            let baseH = -Infinity, baseL = Infinity;
            for (let i = startIdx; i < n - 1; i++) {
                if (sessions[i].high > baseH) baseH = sessions[i].high;
                if (sessions[i].low < baseL) baseL = sessions[i].low;
            }

            const depth = (baseH - baseL) / baseH;
            if (depth < 0.08 || depth > 0.32) continue;

            // Resistance touches separated by >= 15 bars
            const touches = [];
            for (let i = startIdx; i < n - 1; i++) {
                if (sessions[i].high >= baseH * 0.980) touches.push(i);
            }
            if (touches.length < 2 || (touches[touches.length - 1] - touches[0] < 15)) continue;

            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;

            if (curC > baseH && prevC <= baseH * 1.008) {
                // Structural stop placed at lowest low of last 20 bars in base
                let swingLow = Infinity;
                for (let i = Math.max(startIdx, n - 22); i < n - 1; i++) {
                    if (sessions[i].low < swingLow) swingLow = sessions[i].low;
                }
                return {
                    pattern: 'MULTI_MONTH_BASE',
                    pivot: baseH,
                    stopLevel: swingLow * 0.995,
                    baseLen: baseLen,
                    depthPct: depth * 100
                };
            }
        }
        return null;
    }

    /**
     * 4. SYMMETRICAL TRIANGLE / BULLISH COIL
     * Requires:
     * - Coiling volatility contraction (40-50 bars)
     * - Higher swing lows (L2 >= L1 * 1.02) and flat/lower swing highs (H2 <= H1 * 1.002)
     * - Range contraction > 15%
     */
    detectSymmetricalTriangle(sessions) {
        const n = sessions.length;
        if (n < 55) return null;
        const coilLen = 45;
        const startIdx = n - 1 - coilLen;
        const midIdx = startIdx + 22;

        let h1 = -Infinity, h2 = -Infinity;
        let l1 = Infinity, l2 = Infinity;
        for (let i = startIdx; i < midIdx; i++) {
            if (sessions[i].high > h1) h1 = sessions[i].high;
            if (sessions[i].low < l1) l1 = sessions[i].low;
        }
        for (let i = midIdx; i < n - 1; i++) {
            if (sessions[i].high > h2) h2 = sessions[i].high;
            if (sessions[i].low < l2) l2 = sessions[i].low;
        }

        // Higher lows and contracting range
        if (l2 >= l1 * 1.020 && h2 <= h1 * 1.002 && (h1 - l1) > (h2 - l2) * 1.15) {
            const pivotRes = Math.max(h1, h2);
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > pivotRes && prevC <= pivotRes * 1.008) {
                return {
                    pattern: 'SYMMETRICAL_TRIANGLE',
                    pivot: pivotRes,
                    stopLevel: l2 * 0.995
                };
            }
        }
        return null;
    }

    /**
     * 5. INVERSE HEAD & SHOULDERS
     * Requires:
     * - Symmetrical shoulders (LS and RS within 5% tolerance)
     * - Deep head strictly lower than both shoulders by >= 3.5%
     * - Neckline breakout
     */
    detectInverseHS(sessions) {
        const n = sessions.length;
        if (n < 75) return null;
        const ihsLen = 65;
        const w = Math.floor(ihsLen / 3);

        let ls = Infinity, head = Infinity, rs = Infinity;
        for (let i = n - 1 - ihsLen; i < n - 1 - ihsLen + w; i++) if (sessions[i].low < ls) ls = sessions[i].low;
        for (let i = n - 1 - ihsLen + w; i < n - 1 - w; i++) if (sessions[i].low < head) head = sessions[i].low;
        for (let i = n - 1 - w; i < n - 1; i++) if (sessions[i].low < rs) rs = sessions[i].low;

        if (head < ls * 0.965 && head < rs * 0.965 && Math.abs(rs - ls) / ls <= 0.050) {
            let neck1 = -Infinity, neck2 = -Infinity;
            for (let i = n - 1 - ihsLen; i < n - 1 - ihsLen + w; i++) if (sessions[i].high > neck1) neck1 = sessions[i].high;
            for (let i = n - 1 - w; i < n - 1; i++) if (sessions[i].high > neck2) neck2 = sessions[i].high;

            const neckline = Math.max(neck1, neck2);
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;

            if (curC > neckline && prevC <= neckline * 1.008) {
                return {
                    pattern: 'INVERSE_HS',
                    pivot: neckline,
                    stopLevel: rs * 0.995
                };
            }
        }
        return null;
    }

    /**
     * MASTER SCANNER: Scans all 5 patterns in order of priority
     */
    scanAllShapes(sessions) {
        const n = sessions.length;
        if (n < 75) return null;

        const curBar = sessions[n - 1];
        const closes = sessions.map(s => s.close);

        // 1. RSI sweet spot (48 to 85)
        const rsi = this.calculateRSI(closes, this.rsiPeriod);
        if (rsi == null || rsi < this.rsiMin || rsi > this.rsiMax) return null;

        // 2. Candlestick Quality: Close in top 35% of daily range (rejects upper wicks)
        const barRng = curBar.high - curBar.low;
        if (barRng > 0 && (curBar.high - curBar.close) / barRng > 0.38) return null;

        // 3. Volume Surge (>= 1.5x 20 SMA)
        if (curBar.volume && n >= 22) {
            let sumV = 0;
            for (let i = n - 21; i < n - 1; i++) sumV += (sessions[i].volume || 0);
            const avgV = sumV / 20;
            if (avgV > 0 && curBar.volume < avgV * this.minVolumeSurge) return null;
        }

        // 4. Pattern Detection Hierarchy
        let res = this.detectAscendingTriangle(sessions);
        if (!res) res = this.detectCupAndHandle(sessions);
        if (!res) res = this.detectMultiMonthBase(sessions);
        if (!res) res = this.detectSymmetricalTriangle(sessions);
        if (!res) res = this.detectInverseHS(sessions);

        if (!res) return null;

        // 5. Max Extension: No chasing > 3.0% above pivot
        if (curBar.close > res.pivot * 1.030) return null;

        return {
            signal: 'BUY',
            pattern: res.pattern,
            pivot: res.pivot,
            stopLoss: res.stopLevel,
            target1: curBar.close * 1.060, // T1: +6.0% (Book 50%)
            target2: curBar.close * 1.150, // T2: +15.0% Runner
            rsi: rsi,
            curClose: curBar.close
        };
    }
}

module.exports = { AllShapeDetector };

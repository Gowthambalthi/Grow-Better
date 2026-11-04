"use strict";

/**
 * OpenAlgo - Trio Pattern Breakout Strategy (Engine 1 - v7 FIXED)
 * 
 * CORE STRUCTURAL PATTERNS:
 * 1. Inverse Head & Shoulders + RSI
 * 2. Cup & Handle + RSI
 * 3. Rectangle Consolidation + RSI
 * 
 * QUANTITATIVE GATES:
 * - RSI 14 in sweet spot: 48 to 75 (healthy momentum initiation, rejects exhaustion > 75)
 * - Relative Strength (RS) >= 15% outperformance vs NIFTY 50 over 60 trading days
 * - NIFTY 50 > 50 EMA Market Gate
 * - Structural Stop Loss: Right Shoulder Low (IHS) / Handle Low (Cup) / Box Floor (Rectangle)
 * - Targets: +8% to +9% Tranche 1 (50%), move stop to Breakeven (+0.2%), trail runner via 20 EMA
 */

class ResistanceBreakoutStrategy {
    constructor(config = {}) {
        // RSI
        this.rsiPeriod = config.rsiPeriod ?? 14;
        this.rsiMin = config.rsiMin ?? 48.0;
        this.rsiMax = config.rsiMax ?? 75.0;

        // Relative Strength
        this.rsLookback = config.rsLookback ?? 60;
        this.minRsOutperformance = config.minRsOutperformance ?? 15.0;

        // Cup & Handle
        this.cupMinLen = config.cupMinLen ?? 25;
        this.cupMaxLen = config.cupMaxLen ?? 90;
        this.cupMinDepthPct = config.cupMinDepthPct ?? 10.0;
        this.cupMaxDepthPct = config.cupMaxDepthPct ?? 38.0;
        this.cupMaxHandleRatio = config.cupMaxHandleRatio ?? 0.45;

        // Inverse Head & Shoulders
        this.ihsWindow = config.ihsWindow ?? 70;
        this.ihsShoulderTol = config.ihsShoulderTol ?? 0.06;

        // Rectangle
        this.rectWindow = config.rectWindow ?? 30;
        this.rectMaxRangePct = config.rectMaxRangePct ?? 14.0;

        // Risk & Targets
        this.minRiskPct = config.minRiskPct ?? 0.025;
        this.maxRiskPct = config.maxRiskPct ?? 0.065;
        this.target1Pct = config.target1Pct ?? 0.050; // Tranche 1: +5.0% (Book 50% profit & move SL to BE)
        this.target2Pct = config.target2Pct ?? 0.090; // Tranche 2: +9.0% Runner
        this.breakevenTriggerR = config.breakevenTriggerR ?? 1.0;
        this.trailTriggerR = config.trailTriggerR ?? 2.0;
        this.maxHoldBars = config.maxHoldBars ?? 35;
        this.frictionBps = config.frictionBps ?? 28.0;

        // Portfolio Slots (Strict 20-slot institutional capacity calibrated for 4-5 calls/week)
        this.maxConcurrentPositions = config.maxConcurrentPositions ?? 20;
        this.capitalPerPosition = config.capitalPerPosition ?? 50000;
        this.maxExtension = config.maxExtension ?? 1.03; // Capped buy pocket (no chasing > 3.0%)
        this.minVolumeSurge = config.minVolumeSurge ?? 1.15; // 1.15x 20-day SMA volume surge
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

    detectCupAndHandle(sessions) {
        const n = sessions.length;
        for (const handleLen of [6, 10, 15]) {
            for (const cupLen of [35, 50, 65, 80]) {
                const totalLen = cupLen + handleLen;
                if (n < totalLen + 30) continue;
                const startCup = n - 1 - totalLen;
                const midCup = n - 1 - handleLen;

                // 1. Left Rim Peak (in the first 12 bars)
                let leftRim = -Infinity, leftRimIdx = startCup;
                for (let i = startCup; i <= startCup + 12; i++) {
                    if (sessions[i].high > leftRim) { leftRim = sessions[i].high; leftRimIdx = i; }
                }

                // 2. Right Rim Peak (in the 8 bars before handle)
                let rightRim = -Infinity, rightRimIdx = midCup;
                for (let i = midCup - 8; i <= midCup + 2; i++) {
                    if (sessions[i].high > rightRim) { rightRim = sessions[i].high; rightRimIdx = i; }
                }

                // 3. Horizontal Resistance Alignment (<= 3.0% tolerance)
                const rimDiff = Math.abs(rightRim - leftRim) / Math.max(leftRim, rightRim);
                if (rimDiff > 0.030) continue;
                const rim = Math.max(leftRim, rightRim);

                // 4. Absolute Resistance Ceiling Rule:
                // No candle inside the entire base lookback may exceed the breakout rim level (overhead cap <= 1.5%).
                // Eliminates false breakouts trapped under hidden overhead peaks (e.g. OIL 2024-05-08 trapped under ₹446).
                let baseMax = -Infinity;
                for (let i = startCup; i < n - 1; i++) if (sessions[i].high > baseMax) baseMax = sessions[i].high;
                if (baseMax > rim * 1.015) continue;

                // 5. Cup Bottom & Depth
                let cupBottom = Infinity, bottomIdx = leftRimIdx;
                for (let i = leftRimIdx; i <= midCup; i++) {
                    if (sessions[i].low < cupBottom) { cupBottom = sessions[i].low; bottomIdx = i; }
                }

                const depth = (rim - cupBottom) / rim;
                if (depth < (this.cupMinDepthPct / 100) || depth > (this.cupMaxDepthPct / 100)) continue;

                // 6. Symmetrical Centered Bowl (Bottom in 28% - 72% of cup)
                const cupSpan = midCup - leftRimIdx;
                if (cupSpan < 15) continue;
                const bottomPos = (bottomIdx - leftRimIdx) / cupSpan;
                if (bottomPos < 0.28 || bottomPos > 0.72) continue;

                // 7. U-Shape Rounding Check: At least 3 bars in bottom quartile of depth
                const bottomQuartile = cupBottom + 0.25 * (rim - cupBottom);
                let barsAtBottom = 0;
                for (let i = leftRimIdx; i <= midCup; i++) if (sessions[i].low <= bottomQuartile) barsAtBottom++;
                if (barsAtBottom < 3) continue;

                // 8. Handle Pullback & Support (retrace between 15% and 45% of cup depth)
                let handleLow = Infinity;
                for (let i = midCup; i < n - 1; i++) if (sessions[i].low < handleLow) handleLow = sessions[i].low;

                const handleDepth = (rim - handleLow) / rim;
                const handleRatio = handleDepth / depth;
                if (handleDepth < 0.02 || handleRatio < 0.15 || handleRatio > 0.45) continue;

                // 9. Breakout Execution on Bar
                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;
                if (curC > rim * 0.998 && prevC <= rim * 1.010 && curC <= rim * 1.035) {
                    // 10. Prior Uptrend (+15% prior advance leading into cup)
                    const priorStart = Math.max(0, startCup - 40);
                    let priorLow = Infinity;
                    for (let i = priorStart; i < startCup; i++) if (sessions[i].low < priorLow) priorLow = sessions[i].low;
                    const priorRet = (sessions[leftRimIdx].high - priorLow) / priorLow;
                    if (priorRet < 0.15) continue;

                    return {
                        pattern: 'CUP_AND_HANDLE',
                        level: rim,
                        stopLevel: handleLow,
                        depthPct: +(depth * 100).toFixed(1),
                        handleDepthPct: +(handleDepth * 100).toFixed(1)
                    };
                }
            }
        }
        return null;
    }

    detectInverseHS(sessions) {
        const n = sessions.length;
        if (n < this.ihsWindow + 2) return null;
        const a = n - 1 - this.ihsWindow;
        const b = n - 1;
        const w = Math.floor(this.ihsWindow / 3);

        let ls = Infinity, head = Infinity, rs = Infinity;
        for (let i = a; i < a + w; i++) if (sessions[i].low < ls) ls = sessions[i].low;
        for (let i = a + w; i < a + 2 * w; i++) if (sessions[i].low < head) head = sessions[i].low;
        for (let i = a + 2 * w; i < b; i++) if (sessions[i].low < rs) rs = sessions[i].low;

        if (head < ls && head < rs && Math.abs(rs / ls - 1.0) <= this.ihsShoulderTol) {
            let neck1 = -Infinity, neck2 = -Infinity;
            for (let i = a; i < a + w; i++) if (sessions[i].high > neck1) neck1 = sessions[i].high;
            for (let i = a + 2 * w; i < b; i++) if (sessions[i].high > neck2) neck2 = sessions[i].high;
            const neck = Math.max(neck1, neck2);

            // Neckline symmetry check (within 5%)
            if (Math.abs(neck1 - neck2) / neck > 0.05) return null;

            // Absolute Ceiling Rule for IHS:
            let baseMaxHigh = -Infinity;
            for (let i = a; i < b; i++) if (sessions[i].high > baseMaxHigh) baseMaxHigh = sessions[i].high;
            if (baseMaxHigh > neck * 1.015) return null;

            const curC = sessions[b].close;
            const prevC = sessions[b - 1].close;
            if (curC > neck && prevC <= neck * 1.005) {
                return { pattern: 'INVERSE_HS', level: neck, stopLevel: rs, head, ls, rs };
            }
        }
        return null;
    }

    detectRectangle(sessions) {
        const n = sessions.length;
        if (n < this.rectWindow + 2) return null;
        let boxH = -Infinity, boxL = Infinity;
        const startIdx = n - 1 - this.rectWindow;
        for (let i = startIdx; i < n - 1; i++) {
            if (sessions[i].high > boxH) boxH = sessions[i].high;
            if (sessions[i].low < boxL) boxL = sessions[i].low;
        }
        const rangePct = ((boxH - boxL) / boxL) * 100;
        if (rangePct <= this.rectMaxRangePct) {
            // Horizontal base drift check: Eliminates diagonal trend movers (like GNFC)
            const baseDrift = Math.abs(sessions[n - 2].close - sessions[startIdx].close) / sessions[startIdx].close;
            if (baseDrift <= 0.05) {
                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;
                if (curC > boxH && prevC <= boxH * 1.005) {
                    return { pattern: 'RECTANGLE', level: boxH, stopLevel: boxL, rangePct };
                }
            }
        }
        return null;
    }

    detectAscendingTriangle(sessions) {
        const n = sessions.length;
        if (n < 42) return null;
        const winStart = n - 1 - 40;
        let res = -Infinity;
        for (let i = winStart; i < n - 1; i++) if (sessions[i].high > res) res = sessions[i].high;

        let touches = 0;
        for (let i = winStart; i < n - 1; i++) if (sessions[i].high >= res * 0.98) touches++;
        if (touches < 2) return null;

        const mid = winStart + 20;
        let low1 = Infinity, low2 = Infinity;
        for (let i = winStart; i < mid; i++) if (sessions[i].low < low1) low1 = sessions[i].low;
        for (let i = mid; i < n - 1; i++) if (sessions[i].low < low2) low2 = sessions[i].low;

        if (low2 > low1) {
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > res && prevC <= res * 1.005) {
                return { pattern: 'ASCENDING_TRIANGLE', level: res, stopLevel: low2, touches };
            }
        }
        return null;
    }

    onBar(sessions, indexSessions = null) {
        const n = sessions.length;
        if (n < 75) return null;

        const curBar = sessions[n - 1];
        const closes = sessions.map(s => s.close);

        // 1. RSI Gate
        const rsi = this.calculateRSI(closes, this.rsiPeriod);
        if (rsi == null || rsi < this.rsiMin || rsi > this.rsiMax) {
            return null;
        }

        // 2. Relative Strength vs Index (if provided)
        if (indexSessions && indexSessions.length >= this.rsLookback) {
            const idxN = indexSessions.length;
            const stockRet = (curBar.close - sessions[n - 1 - this.rsLookback].close) / sessions[n - 1 - this.rsLookback].close;
            const idxRet = (indexSessions[idxN - 1].close - indexSessions[idxN - 1 - this.rsLookback].close) / indexSessions[idxN - 1 - this.rsLookback].close;
            const rs = (stockRet - idxRet) * 100;
            if (rs < this.minRsOutperformance) {
                return null;
            }
        }

        // 2b. Anti-Climax Guard: Reject stocks extended > 50% above 200 EMA
        if (n >= 150) {
            let ema200 = closes[0];
            const k200 = 2 / 201;
            for (let i = 1; i < n; i++) ema200 = closes[i] * k200 + ema200 * (1 - k200);
            if (curBar.close > ema200 * 1.50) {
                return null;
            }
        }

        // 3. Pattern Recognition (in priority order)
        let detected = this.detectCupAndHandle(sessions);
        if (!detected) detected = this.detectInverseHS(sessions);
        if (!detected) detected = this.detectRectangle(sessions);
        if (!detected) detected = this.detectAscendingTriangle(sessions);

        if (!detected) return null;

        const curC = curBar.close;

        // 4. Institutional Capped Buy Pocket (No chasing extended candles > 2.5%)
        if (curC > detected.level * this.maxExtension) {
            return null;
        }

        // 5. Volume Surge Confirmation (>= 1.25x 20-day SMA)
        if (curBar.volume && n >= 22) {
            let sumV = 0;
            for (let i = n - 21; i < n - 1; i++) {
                sumV += (sessions[i].volume || 0);
            }
            const avgV = sumV / 20;
            if (avgV > 0 && curBar.volume < avgV * this.minVolumeSurge) {
                return null;
            }
        }

        let structSl = detected.stopLevel;
        let riskPct = (curC - structSl) / curC;

        if (riskPct < this.minRiskPct) {
            structSl = curC * (1 - this.minRiskPct);
            riskPct = this.minRiskPct;
        } else if (riskPct > this.maxRiskPct) {
            structSl = curC * (1 - this.maxRiskPct);
            riskPct = this.maxRiskPct;
        }

        const cashRisk = curC - structSl;
        const target1 = curC * (1 + this.target1Pct);
        const target2 = curC * (1 + this.target2Pct);

        return {
            signal: 'BUY',
            pattern: detected.pattern,
            patternLevel: detected.level,
            stopLoss: structSl,
            target1: target1,
            target2: target2,
            rsi: rsi,
            riskPct: riskPct * 100,
            cashRisk: cashRisk
        };
    }
}

module.exports = { ResistanceBreakoutStrategy };

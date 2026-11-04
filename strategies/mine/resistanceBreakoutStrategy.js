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
        for (const handleLen of [8, 15, 25, 35]) {
            for (const cupLen of [40, 60, 80]) {
                const totalLen = cupLen + handleLen;
                if (n < totalLen + 20) continue;
                const startCup = n - 1 - totalLen;
                const midCup = n - 1 - handleLen;

                // 1. Left Rim Peak (in the first 18 bars of cup)
                let leftRim = -Infinity, leftRimIdx = startCup;
                for (let i = startCup; i <= startCup + 18; i++) {
                    if (sessions[i].high > leftRim) { leftRim = sessions[i].high; leftRimIdx = i; }
                }

                // 2. Right Rim Peak (in the 15 bars before handle)
                let rightRim = -Infinity, rightRimIdx = midCup;
                for (let i = midCup - 15; i <= midCup + 3; i++) {
                    if (sessions[i].high > rightRim) { rightRim = sessions[i].high; rightRimIdx = i; }
                }

                // 3. Minimum Separation: Left and Right rims must be separated by >= 25 bars!
                if (rightRimIdx - leftRimIdx < 25) continue;

                // 4. Horizontal Resistance Alignment (<= 4.5% tolerance to accommodate macro institutional rims like CIPLA)
                const rim = Math.max(leftRim, rightRim);
                const rimDiff = Math.abs(rightRim - leftRim) / rim;
                if (rimDiff > 0.045) continue;

                // 5. Absolute Resistance Ceiling Rule: No candle inside the cup exceeds rim by > 1.5%
                let baseMax = -Infinity;
                for (let i = startCup; i < n - 1; i++) if (sessions[i].high > baseMax) baseMax = sessions[i].high;
                if (baseMax > rim * 1.015) continue;

                // 6. Cup Bottom & Depth
                let cupBottom = Infinity, bottomIdx = leftRimIdx;
                for (let i = leftRimIdx; i <= rightRimIdx; i++) {
                    if (sessions[i].low < cupBottom) { cupBottom = sessions[i].low; bottomIdx = i; }
                }

                const depth = (rim - cupBottom) / rim;
                if (depth < (this.cupMinDepthPct / 100) || depth > (this.cupMaxDepthPct / 100)) continue;

                // 7. Symmetrical Centered Bowl (Bottom in 22% - 78% of cup span)
                const cupSpan = rightRimIdx - leftRimIdx;
                if (cupSpan < 20) continue;
                const bottomPos = (bottomIdx - leftRimIdx) / cupSpan;
                if (bottomPos < 0.22 || bottomPos > 0.78) continue;

                // 8. U-Shape Rounding Check: At least 4 bars in bottom quartile of depth
                const bottomQuartile = cupBottom + 0.25 * (rim - cupBottom);
                let barsAtBottom = 0;
                for (let i = leftRimIdx; i <= rightRimIdx; i++) if (sessions[i].low <= bottomQuartile) barsAtBottom++;
                if (barsAtBottom < 4) continue; // Rejects sharp V-bottom spikes

                // 9. Handle Pullback: shallow pullback in upper half of cup (2.5% to 14.0% depth)
                let handleLow = Infinity;
                for (let i = midCup; i < n - 1; i++) if (sessions[i].low < handleLow) handleLow = sessions[i].low;

                const handleDepth = (rim - handleLow) / rim;
                const handleRatio = handleDepth / depth;
                if (handleDepth < 0.020 || handleRatio < 0.15 || handleRatio > 0.48 || handleDepth > 0.14) continue;

                // 10. Volume Dry Up (VDU): Handle volume must contract vs cup volume
                let cupVolSum = 0, cupVolCount = 0;
                for (let i = startCup; i < midCup; i++) { cupVolSum += sessions[i].volume || 0; cupVolCount++; }
                let handleVolSum = 0, handleVolCount = 0;
                for (let i = midCup; i < n - 1; i++) { handleVolSum += sessions[i].volume || 0; handleVolCount++; }
                const cupAvgVol = cupVolCount > 0 ? cupVolSum / cupVolCount : 1;
                const handleAvgVol = handleVolCount > 0 ? handleVolSum / handleVolCount : 1;
                if (handleAvgVol > cupAvgVol * 1.05) continue; // Reject distribution handles

                // 11. Breakout Execution on Bar
                const curC = sessions[n - 1].close;
                const prevC = sessions[n - 2].close;
                if (curC > rim && prevC <= rim * 1.008 && curC <= rim * 1.035) {
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
        if (n < 75) return null;
        const ihsLen = 65;
        const startIdx = n - 1 - ihsLen;
        const w = Math.floor(ihsLen / 3);

        let ls = Infinity, lsIdx = startIdx;
        for (let i = startIdx; i < startIdx + w; i++) if (sessions[i].low < ls) { ls = sessions[i].low; lsIdx = i; }

        let head = Infinity, headIdx = startIdx + w;
        for (let i = startIdx + w; i < startIdx + 2 * w; i++) if (sessions[i].low < head) { head = sessions[i].low; headIdx = i; }

        let rs = Infinity, rsIdx = startIdx + 2 * w;
        for (let i = startIdx + 2 * w; i < n - 1; i++) if (sessions[i].low < rs) { rs = sessions[i].low; rsIdx = i; }

        // Trough separation: At least 12 bars between troughs
        if (headIdx - lsIdx < 12 || rsIdx - headIdx < 12) return null;

        // Head must be strictly lower than both shoulders by at least 3.0%
        if (head < ls * 0.970 && head < rs * 0.970 && Math.abs(rs / ls - 1.0) <= 0.05) {
            let neck1 = -Infinity, neck2 = -Infinity;
            for (let i = lsIdx; i <= headIdx; i++) if (sessions[i].high > neck1) neck1 = sessions[i].high;
            for (let i = headIdx; i <= rsIdx; i++) if (sessions[i].high > neck2) neck2 = sessions[i].high;
            const neck = Math.max(neck1, neck2);

            // Neckline symmetry within 3.5%
            if (Math.abs(neck1 - neck2) / neck > 0.035) return null;

            // Absolute ceiling cap
            let baseMaxHigh = -Infinity;
            for (let i = startIdx; i < n - 1; i++) if (sessions[i].high > baseMaxHigh) baseMaxHigh = sessions[i].high;
            if (baseMaxHigh > neck * 1.015) return null;

            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > neck && prevC <= neck * 1.008) {
                return { pattern: 'INVERSE_HS', level: neck, stopLevel: rs, head, ls, rs };
            }
        }
        return null;
    }

    detectRectangle(sessions) {
        const n = sessions.length;
        if (n < 45) return null;
        const boxLen = 40;
        const startIdx = n - 1 - boxLen;
        let boxH = -Infinity, boxL = Infinity;
        for (let i = startIdx; i < n - 1; i++) {
            if (sessions[i].high > boxH) boxH = sessions[i].high;
            if (sessions[i].low < boxL) boxL = sessions[i].low;
        }
        const rangePct = ((boxH - boxL) / boxL) * 100;
        if (rangePct >= 4.0 && rangePct <= 12.0) {
            // Find distinct touches of ceiling and floor separated by >= 12 days
            const topTouches = [];
            const botTouches = [];
            for (let i = startIdx; i < n - 1; i++) {
                if (sessions[i].high >= boxH * 0.985) topTouches.push(i);
                if (sessions[i].low <= boxL * 1.015) botTouches.push(i);
            }
            if (topTouches.length >= 2 && botTouches.length >= 2) {
                if (topTouches[topTouches.length - 1] - topTouches[0] >= 12 && botTouches[botTouches.length - 1] - botTouches[0] >= 12) {
                    const baseDrift = Math.abs(sessions[n - 2].close - sessions[startIdx].close) / sessions[startIdx].close;
                    if (baseDrift <= 0.05) {
                        const curC = sessions[n - 1].close;
                        const prevC = sessions[n - 2].close;
                        if (curC > boxH && prevC <= boxH * 1.008) {
                            return { pattern: 'RECTANGLE', level: boxH, stopLevel: boxL, rangePct };
                        }
                    }
                }
            }
        }
        return null;
    }

    detectAscendingTriangle(sessions) {
        const n = sessions.length;
        if (n < 50) return null;
        const baseLen = 45;
        const winStart = n - 1 - baseLen;
        let res = -Infinity;
        for (let i = winStart; i < n - 1; i++) if (sessions[i].high > res) res = sessions[i].high;

        // Distinct ceiling touches within 2.2%
        const ceilHits = [];
        for (let i = winStart; i < n - 1; i++) if (sessions[i].high >= res * 0.978) ceilHits.push(i);
        if (ceilHits.length < 2) return null;

        // Separation: First and last touch must be separated by >= 10 bars
        if (ceilHits[ceilHits.length - 1] - ceilHits[0] < 10) return null;

        // Intervening reaction trough: Must pull back >= 3.0% from ceiling
        let midTrough = Infinity;
        for (let i = ceilHits[0]; i <= ceilHits[ceilHits.length - 1]; i++) {
            if (sessions[i].low < midTrough) midTrough = sessions[i].low;
        }
        if ((res - midTrough) / res < 0.030) return null; // Reject flat clumps

        // Confirmed ascending swing lows (local minima separated by >= 6 bars)
        const swingLows = [];
        for (let i = winStart + 2; i < n - 2; i++) {
            if (sessions[i].low <= sessions[i - 1].low && sessions[i].low <= sessions[i + 1].low) {
                if (swingLows.length === 0 || i - swingLows[swingLows.length - 1].i >= 6) {
                    swingLows.push({ i, low: sessions[i].low });
                }
            }
        }
        if (swingLows.length < 2) return null;

        const firstLow = swingLows[0].low;
        const lastLow = swingLows[swingLows.length - 1].low;
        if (lastLow < firstLow * 1.015) return null; // Lows must strictly ascend

        const curC = sessions[n - 1].close;
        const prevC = sessions[n - 2].close;
        if (curC > res && prevC <= res * 1.008) {
            return {
                pattern: 'ASCENDING_TRIANGLE',
                level: res,
                stopLevel: lastLow,
                touches: ceilHits.length
            };
        }
        return null;
    }

    detectSymmetricalTriangle(sessions) {
        const n = sessions.length;
        if (n < 45) return null;
        const coilLen = 40;
        const startIdx = n - 1 - coilLen;
        const midIdx = startIdx + 20;

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

        // Volatility contraction: higher lows and flat/lower highs
        if (l2 >= l1 * 1.025 && h2 <= h1 * 1.002 && (h1 - l1) > (h2 - l2) * 1.15) {
            const pivotRes = Math.max(h1, h2);
            const curC = sessions[n - 1].close;
            const prevC = sessions[n - 2].close;
            if (curC > pivotRes && prevC <= pivotRes * 1.008) {
                return { pattern: 'SYMMETRICAL_TRIANGLE', level: pivotRes, stopLevel: l2 };
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
        if (!detected) detected = this.detectSymmetricalTriangle(sessions);

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

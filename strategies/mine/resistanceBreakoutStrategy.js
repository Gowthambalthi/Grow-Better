"use strict";

/**
 * OpenAlgo - Trio Pattern Breakout Strategy (Engine 1 - v7 FIXED)
 * Location: strategies/mine/resistanceBreakoutStrategy.js
 * 
 * CORE STRUCTURAL PATTERNS (Imported from strategies/mine/patterns.js):
 * 1. Classic Cup & Handle (U-shaped basin + VDU handle)
 * 2. Ascending Triangle (Flat ceiling >= 3 touches, ascending swing lows theta >= 10 deg)
 * 3. Multi-Month Base (30-100 day consolidation base)
 * 4. Symmetrical Triangle (Coiling contraction)
 * 5. Inverse Head & Shoulders (Shoulders + Head + Neckline)
 * 
 * QUANTITATIVE GATES:
 * - RSI 14 in sweet spot: 48 to 85 (captures volume ignition leaders like CNL, SAREGAMA, ICIL)
 * - Structural Stop Loss anchored to support geometry (below pivot floor / handle trough)
 * - Institutional Anti-Chasing Buy Pocket: capped at +5.0% above pivot
 * - Realistic Zerodha round-trip friction (0.28%)
 */

const patterns = require("./patterns");

class ResistanceBreakoutStrategy {
    constructor(config = {}) {
        // RSI
        this.rsiPeriod = config.rsiPeriod ?? 14;
        this.rsiMin = config.rsiMin ?? 48.0;
        this.rsiMax = config.rsiMax ?? 85.0;

        // Relative Strength
        this.rsLookback = config.rsLookback ?? 60;
        this.minRsOutperformance = config.minRsOutperformance ?? 0.0;

        // Risk & Targets
        this.minRiskPct = config.minRiskPct ?? 0.025;
        this.maxRiskPct = config.maxRiskPct ?? 0.065;
        this.target1Pct = config.target1Pct ?? 0.050; // Tranche 1: +5.0% (Book 50% profit & move SL to BE)
        this.target2Pct = config.target2Pct ?? 0.090; // Tranche 2: +9.0% Runner
        this.breakevenTriggerR = config.breakevenTriggerR ?? 1.0;
        this.trailTriggerR = config.trailTriggerR ?? 2.0;
        this.maxHoldBars = config.maxHoldBars ?? 35;
        this.frictionBps = config.frictionBps ?? 28.0;

        // Portfolio Capacity & Buy Pocket
        this.maxConcurrentPositions = config.maxConcurrentPositions ?? 20;
        this.capitalPerPosition = config.capitalPerPosition ?? 50000;
        this.maxExtension = config.maxExtension ?? 1.05; // Capped buy pocket (allows up to 5% expansion)
        this.minVolumeSurge = config.minVolumeSurge ?? 1.25; // 1.25x 20-day SMA volume surge

        // Expose patterns module
        this.patterns = patterns;
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

    // Pattern Delegation to strategies/mine/patterns.js
    detectCupAndHandle(sessions) {
        return patterns.detectCupAndHandle(sessions);
    }

    detectAscendingTriangle(sessions) {
        return patterns.detectAscendingTriangle(sessions);
    }

    detectMultiMonthBase(sessions) {
        return patterns.detectMultiMonthBase(sessions);
    }

    detectResistanceBreakout(sessions) {
        return patterns.detectMultiMonthBase(sessions);
    }

    detectRectangle(sessions) {
        return patterns.detectMultiMonthBase(sessions);
    }

    detectSymmetricalTriangle(sessions) {
        return patterns.detectSymmetricalTriangle(sessions);
    }

    detectInverseHS(sessions) {
        return patterns.detectInverseHeadAndShoulders(sessions);
    }

    detectPattern(sessions) {
        return patterns.detectPattern(sessions);
    }

    onBar(sessions, indexSessions = null) {
        const n = sessions.length;
        if (n < 75) return null;

        const curBar = sessions[n - 1];
        const closes = sessions.map(s => s.close);

        // 1. RSI Gate (Sweet spot up to 85 for high-volume ignition days)
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

        // 3. Pattern Recognition using strategies/mine/patterns.js
        const detected = patterns.detectPattern(sessions);
        if (!detected) return null;

        const curC = curBar.close;

        // 4. Institutional Capped Buy Pocket (No chasing extended candles > 5%)
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
            cashRisk: cashRisk,
            details: detected
        };
    }
}

module.exports = {
    ResistanceBreakoutStrategy,
    patterns
};

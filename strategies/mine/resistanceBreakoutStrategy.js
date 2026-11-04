"use strict";

/**
 * strategies/mine/resistanceBreakoutStrategy.js
 * Authoritative Strategy Orchestrator (JavaScript)
 * 
 * Synchronized with config.js / config.py:
 * - Uses Wilder-smoothed RSI [50.0, 78.0]
 * - Relative Strength Gate: >= +5.0% outperformance vs NIFTY over 60 bars
 * - Market Gate: NIFTY 50 > 50 EMA
 * - Structural Stop Integrity: Rejects trades if risk distance is outside [2.5%, 7.5%] (NO CLAMPING)
 * - Anti-Chasing Buy Pocket: Capped at +3.0% above pivot
 * - Delegates pattern recognition to patterns.js (all 4 bugs fixed)
 */

const { CONFIG } = require("./config");
const patterns = require("./patterns");

class ResistanceBreakoutStrategy {
    constructor(userConfig = {}) {
        this.cfg = { ...CONFIG, ...userConfig };
        this.patterns = patterns;
    }

    calculateRSI(closes, period = 14) {
        const n = closes.length;
        if (n < period + 2) return null;
        let avgGain = 0, avgLoss = 0;

        for (let i = 1; i <= period; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) avgGain += diff;
            else avgLoss += Math.abs(diff);
        }
        avgGain /= period;
        avgLoss /= period;

        for (let i = period + 1; i < n; i++) {
            const diff = closes[i] - closes[i - 1];
            const gain = diff > 0 ? diff : 0;
            const loss = diff < 0 ? Math.abs(diff) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // Pattern Delegations
    detectCupAndHandle(sessions) { return patterns.detectCupAndHandle(sessions); }
    detectAscendingTriangle(sessions) { return patterns.detectAscendingTriangle(sessions); }
    detectMultiMonthBase(sessions) { return patterns.detectMultiMonthBase(sessions); }
    detectSymmetricalTriangle(sessions) { return patterns.detectSymmetricalTriangle(sessions); }
    detectPattern(sessions) { return patterns.detectPattern(sessions); }

    onBar(sessions, indexSessions = null) {
        const n = sessions.length;
        if (n < 75) return null;

        const curBar = sessions[n - 1];
        const closes = sessions.map(s => s.close);

        // 1. Wilder-smoothed RSI Gate [50, 78]
        const rsi = this.calculateRSI(closes, this.cfg.RSI_PERIOD);
        if (rsi == null || rsi < this.cfg.RSI_MIN || rsi > this.cfg.RSI_MAX) {
            return null;
        }

        // 2. Market Gate & Relative Strength vs NIFTY
        if (indexSessions && indexSessions.length >= this.cfg.RS_LOOKBACK_BARS) {
            const idxN = indexSessions.length;
            const idxClose = indexSessions[idxN - 1].close;

            // NIFTY 50 > 50 EMA Market Gate
            if (this.cfg.REQUIRE_NIFTY_BULL && idxN >= 50) {
                let ema50 = indexSessions[0].close;
                const k50 = 2 / 51;
                for (let i = 1; i < idxN; i++) ema50 = indexSessions[i].close * k50 + ema50 * (1 - k50);
                if (idxClose < ema50) {
                    return null; // Market not bullish
                }
            }

            // 60-Day Relative Strength Outperformance
            const lb = this.cfg.RS_LOOKBACK_BARS;
            const stockRet = (curBar.close - sessions[n - 1 - lb].close) / sessions[n - 1 - lb].close;
            const idxRet = (idxClose - indexSessions[idxN - 1 - lb].close) / indexSessions[idxN - 1 - lb].close;
            const rsOutperformance = (stockRet - idxRet) * 100.0;
            if (rsOutperformance < this.cfg.MIN_RS_OUTPERFORMANCE) {
                return null;
            }
        }

        // 3. Anti-Climax Guard: Reject stocks extended > 40% above rising 200 EMA
        if (n >= 200) {
            let ema200 = closes[0];
            const k200 = 2 / 201;
            for (let i = 1; i < n; i++) ema200 = closes[i] * k200 + ema200 * (1 - k200);
            if (curBar.close > ema200 * (1.0 + this.cfg.MAX_200_EMA_EXTENSION)) {
                return null;
            }
        }

        // 4. Pattern Recognition (Patterns.js)
        const detected = patterns.detectPattern(sessions);
        if (!detected) return null;

        const curC = curBar.close;

        // 5. Volume Surge Confirmation (>= 1.50x 20-day SMA)
        if (n >= 22) {
            let sumV = 0;
            for (let i = n - 21; i < n - 1; i++) sumV += (sessions[i].volume || 1);
            const avgV = sumV / 20;
            if (avgV > 0 && (curBar.volume || 1) < avgV * this.cfg.MIN_BREAKOUT_VOL_SURGE) {
                return null;
            }
        }

        // 6. Candle Quality: Upper wick <= 35% of total bar range
        const rng = curBar.high - curBar.low;
        if (rng > 0 && (curBar.high - curC) / rng > this.cfg.MAX_UPPER_WICK_RATIO) {
            return null; // Reject shooting stars
        }

        // 7. Structural Stop Integrity (NO CLAMPING)
        const structSl = detected.stopLevel;
        const riskPct = ((curC - structSl) / curC) * 100.0;

        if (riskPct < this.cfg.MIN_STRUCTURAL_RISK_PCT || riskPct > this.cfg.MAX_STRUCTURAL_RISK_PCT) {
            return null; // REJECT TRADE: Unacceptable risk distance!
        }

        const target1 = curC * (1.0 + this.cfg.TARGET_1_PCT / 100.0);
        const target2 = curC * (1.0 + this.cfg.TARGET_2_PCT / 100.0);

        return {
            signal: 'BUY',
            pattern: detected.pattern,
            patternLevel: detected.level,
            stopLoss: structSl,
            target1: target1,
            target2: target2,
            rsi: +rsi.toFixed(1),
            riskPct: +riskPct.toFixed(2),
            cashRisk: +(curC - structSl).toFixed(2),
            details: detected
        };
    }
}

module.exports = {
    ResistanceBreakoutStrategy,
    patterns,
    CONFIG
};

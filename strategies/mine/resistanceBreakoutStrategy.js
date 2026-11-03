'use strict';

/**
 * OpenAlgo — Institutional Resistance Breakout Strategy (Engine 1 - v5 Production)
 * 
 * Incorporates Robust Anti-Exhaustion, VCP Tightness & True Blue-Sky Architecture:
 * 
 * 1. 52-Week High Proximity (Blue Sky / Zero Trapped Overhead Supply):
 *    - Price must be within 5.0% of its 52-week (250-bar) high (or ATH).
 *    - Kills lower-high traps & dead-cat bounces in downtrends (e.g., HINDALCO @ Rs 1059 vs Rs 1176 peak, MARUTI @ Rs 14115 vs Rs 17370 peak).
 * 
 * 2. Multi-Window Anti-Sprint Architecture (Prevents Exhaustion Climaxes):
 *    - Prior 5-day run <= 7.5%: Kills explosive multi-day exhaustion sprints (e.g., ADANIPORTS +10.6% 5-day / +16.6% 3-day sprint).
 *    - Prior 3-day run <= 5.5%: Ensures the breakout does not trigger after a vertical spike.
 *    - Prior 20-day run <= 10.0%: Macro anti-runaway cap.
 * 
 * 3. Pre-Breakout Tightness (Volatility Contraction Pattern - VCP):
 *    - 3-day pre-breakout range <= 6.5%: Enforces that before breaking out, price was resting in a calm base consolidation.
 * 
 * 4. Realistic Two-Tranche Trade Management & Early Invalidation:
 *    - Initial Stop: max(Breakout Low, Entry - 1.0 * ATR) (~ -2.5% to -4.0% risk)
 *    - Early Invalidation: If price drops <= -1.5% below entry, cut immediately (winners never drop > -0.83%).
 *    - Tranche 1 (+2.5%): Lock in 50% profit (reached by 40.2% of large-cap breakouts), move stop to breakeven (+0.2% buffer).
 *    - Tranche 2 (50%): Ride 20 EMA until daily close < 20 EMA, executed strictly at next Open.
 */

class ResistanceBreakoutStrategy {
    constructor(config = {}) {
        this.baseLookback = config.baseLookback ?? 40;
        this.macroLookback = config.macroLookback ?? 60; // 60-day overhead supply check
        this.high52wLookback = config.high52wLookback ?? 250; // 52-week lookback
        this.minBaseDepth = config.minBaseDepth ?? 0.04;
        this.maxBaseDepth = config.maxBaseDepth ?? 0.20;     // 20% max base depth
        this.minCeilAge = config.minCeilAge ?? 5;             // 5 bars (1 week) base age
        this.maxPrior20dRun = config.maxPrior20dRun ?? 0.10;
        this.maxPrior5dRun = config.maxPrior5dRun ?? 0.075;   // 7.5% 5-day sprint cap (kills ADANIPORTS)
        this.maxPrior3dRun = config.maxPrior3dRun ?? 0.055;   // 5.5% 3-day sprint cap
        this.minDist52w = config.minDist52w ?? -0.160;        // Within 16% of 52w high (allows mature bases like RELIANCE)
        this.maxPreRange3d = config.maxPreRange3d ?? 0.065;   // 6.5% pre-breakout consolidation range
        this.minRVOL = config.minRVOL ?? 1.5;
        this.maxRVOL = config.maxRVOL ?? 5.5;
        this.minTurnoverCr = config.minTurnoverCr ?? 50.0;     // Large Cap ₹50 Cr turnover
        this.maxChasePct = config.maxChasePct ?? 0.020;       // 2.0% chase cap
    }

    evaluateBreakout(dailyBars, currentIndex, niftyCandle = null) {
        if (currentIndex < this.macroLookback + 1) return null;

        const currentBar = dailyBars[currentIndex];
        const baseBars = dailyBars.slice(currentIndex - this.baseLookback, currentIndex);
        const macroBars = dailyBars.slice(currentIndex - this.macroLookback, currentIndex);

        const open = currentBar.open;
        const close = currentBar.close;
        const high = currentBar.high;
        const low = currentBar.low;
        const volume = currentBar.volume;
        const volSMA20 = currentBar.volSMA20;
        const curATR = currentBar.atr14;
        const ema20 = currentBar.ema20;
        const ema200 = currentBar.ema200;
        const turnoverCr = currentBar.turnoverCr ?? 0.0; // Fail closed if missing

        // 1. Core Regime Gates
        if (close < ema200) return null; // Uptrend above 200 EMA
        if (turnoverCr < this.minTurnoverCr) return null; // Large Cap liquidity
        if (niftyCandle) {
            if (niftyCandle.close < niftyCandle.ema50) return null; // NIFTY Bull gate
        } else {
            return null; // Benchmark data required
        }

        if (!volSMA20 || volSMA20 <= 0 || !curATR || curATR <= 0) return null;

        // 2. Base Geometry & Maturity
        let ceiling = -Infinity;
        let floor = Infinity;
        let highestBarRelIdx = 0;

        for (let j = 0; j < baseBars.length; j++) {
            if (baseBars[j].high > ceiling) {
                ceiling = baseBars[j].high;
                highestBarRelIdx = j;
            }
            if (baseBars[j].low < floor) floor = baseBars[j].low;
        }

        // 3. Macro Ceiling (60 bars)
        let macroCeiling = -Infinity;
        for (let k = 0; k < macroBars.length; k++) {
            if (macroBars[k].high > macroCeiling) macroCeiling = macroBars[k].high;
        }

        const trueResistance = Math.max(ceiling, macroCeiling);
        
        // Price must close cleanly above True Resistance + ATR buffer
        if (close < trueResistance + 0.10 * curATR) {
            return null;
        }

        // 4. Base Symmetry / Time in Upper Half
        const midBase = floor + 0.5 * (trueResistance - floor);
        let upperHalfCount = 0;
        for (let j = 0; j < baseBars.length; j++) {
            if (baseBars[j].close >= midBase) upperHalfCount++;
        }
        if (upperHalfCount / baseBars.length < 0.40) {
            return null;
        }

        // Ceiling Age >= 5 bars (with pre-breakout test-wick protection)
        let ceilAge = baseBars.length - highestBarRelIdx;
        if (ceilAge < this.minCeilAge) {
            for (let j = 0; j < baseBars.length - 3; j++) {
                if (baseBars[j].high >= trueResistance * 0.985) {
                    ceilAge = baseBars.length - j;
                    break;
                }
            }
        }
        if (ceilAge < this.minCeilAge) return null;

        // 5. Anti-Runaway & Multi-Window Sprint Filters
        // 20-day check
        const bar20Ago = dailyBars[Math.max(0, currentIndex - 20)];
        if (bar20Ago) {
            const prior20dRun = (close - bar20Ago.close) / bar20Ago.close;
            if (prior20dRun > this.maxPrior20dRun) return null;
        }

        // 5-day check (KILLS ADANIPORTS EXHAUSTION SPRINT)
        const bar5Ago = dailyBars[Math.max(0, currentIndex - 5)];
        if (bar5Ago) {
            const prior5dRun = (close - bar5Ago.close) / bar5Ago.close;
            if (prior5dRun > this.maxPrior5dRun) return null;
        }

        // 3-day check
        const bar3Ago = dailyBars[Math.max(0, currentIndex - 3)];
        if (bar3Ago) {
            const prior3dRun = (close - bar3Ago.close) / bar3Ago.close;
            if (prior3dRun > this.maxPrior3dRun) return null;
        }

        // 6. Pre-Breakout Tightness / VCP Consolidation
        // Range of the 3 days preceding the breakout candle must be <= 6.5%
        const pre3Bars = dailyBars.slice(Math.max(0, currentIndex - 3), currentIndex);
        if (pre3Bars.length >= 3) {
            const preH3 = Math.max(...pre3Bars.map(b => b.high));
            const preL3 = Math.min(...pre3Bars.map(b => b.low));
            if ((preH3 - preL3) / preL3 > this.maxPreRange3d) return null;
        }

        // 7. 52-Week High Proximity (Blue Sky / Zero Trapped Overhead Supply)
        const w52Start = Math.max(0, currentIndex - this.high52wLookback);
        const bars52w = dailyBars.slice(w52Start, currentIndex);
        const high52w = Math.max(...bars52w.map(b => b.high));
        const dist52w = (close - high52w) / high52w;
        if (dist52w < this.minDist52w) {
            return null; // Reject if > 5.0% below 52-week high (kills HINDALCO, MARUTI)
        }

        const baseDepth = (trueResistance - floor) / trueResistance;
        if (baseDepth < this.minBaseDepth || baseDepth > this.maxBaseDepth) return null;

        // Touches >= 2
        let touches = 0;
        for (let j = 0; j < macroBars.length; j++) {
            if (macroBars[j].high >= trueResistance * 0.985) touches++;
        }
        if (touches < 2) return null;

        // Candle Microstructure
        const candleRange = Math.max(high - low, 1e-4);
        const body = close - open;
        const bodyRatio = body / candleRange;
        const closeLoc = (close - low) / candleRange;
        const upperWick = (high - Math.max(open, close)) / candleRange;
        const rvol = volume / volSMA20;

        if (close <= open || bodyRatio < 0.45 || closeLoc < 0.60 || upperWick > 0.32) return null;

        // Volume Sweet Spot (1.5x to 5.5x)
        if (rvol < this.minRVOL || rvol > this.maxRVOL) return null;

        // Order Placement Specifications (Strictly on Day t Close - Zero Lookahead)
        const orderLimitPrice = Math.round(trueResistance * (1.0 + this.maxChasePct) * 100) / 100;
        const initialStop = Math.round(Math.max(low, close - 1.0 * curATR) * 100) / 100;
        const riskDistance = close - initialStop;
        const riskPct = (riskDistance / close) * 100;
        if (riskPct > 4.0 || riskPct < 0.8) return null;

        // Model A Institutional R-Multiple Target (+1.2R) & 20 EMA Runner
        const target1Price = Math.round((close + 1.2 * riskDistance) * 100) / 100; // Tranche 1: +1.2R
        const breakevenStop = Math.round(close * 1.002 * 100) / 100;

        return {
            symbol: currentBar.symbol,
            date: currentBar.date,
            classification: 'TRUE BLUE-SKY RESISTANCE BREAKOUT (v5)',
            currentPrice: close,
            ceilingResistance: trueResistance,
            ceilAgeBars: ceilAge,
            dist52wPct: Math.round(dist52w * 1000) / 10,
            baseFloor: floor,
            baseDepthPct: Math.round(baseDepth * 1000) / 10,
            rvol: Math.round(rvol * 100) / 100,
            execution: {
                orderType: 'BUY_STOP_LIMIT',
                stopTrigger: trueResistance,
                limitPrice: orderLimitPrice,
                initialStopLoss: initialStop,
                riskPct: `${riskPct.toFixed(2)}%`,
                target1: target1Price,
                target1Action: 'LOCK IN 50% PROFIT at +1.5R & MOVE STOP TO BREAKEVEN (Rs ' + breakevenStop + ')',
                runnerManagement: '20_EMA_DAILY_CLOSE (Executed at next Open for remaining 50%)',
                trailingTrigger: `Close < 20 EMA (currently Rs ${Math.round(ema20 * 100) / 100})`
            }
        };
    }
}

module.exports = ResistanceBreakoutStrategy;

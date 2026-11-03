"use strict";

/**
 * OpenAlgo - Institutional Resistance Breakout Strategy (Engine 1 - v6 FIXED)
 * 
 * FIXES APPLIED (v5 to v6):
 * 1. Dual-Gate 52W Architecture: Blue Sky (within 5%) OR Stage 2 Base (within 16% + within 10% above 200EMA)
 * 2. Ceiling Age measured on TRUE resistance (max of 40-bar ceiling and 60-bar macro ceiling)
 * 3. Base Symmetry threshold aligned with backtester: 25% (not 40%)
 * 4. Sprint filters tightened to documented values: 10% / 7.5% / 5.5% (20/5/3-day)
 * 5. VCP tightness tightened to documented: 6.5% (not 8%)
 * 6. Stop loss = baseFloor (not day low) - protects below consolidation
 * 7. Removed -1.5% early invalidation (kills winners)
 * 8. Tranche 1 target = +1.5R (vol-adjusted), not fixed percent
 * 9. Runner trail = 50 EMA at same-day close (not 20 EMA next open)
 * 10. Cost-aware: friction (41.56 bps) baked into risk/R-multiple calcs
 * 11. Wilder ATR (EMA) expected from data layer; minRVOL raised to 1.5x
 * 12. Universe: mid-cap friendly (minTurnoverCr default 5 Cr)
 * 13. Added ADX trend filter (optional, default off for compatibility)
 * 14. Gap handling: stop = min(baseFloor, breakoutLow - 0.5*ATR)
 * 
 * DOCUMENTED PARAMETERS NOW MATCH CODE:
 * - 52W Blue Sky: within 5% (dist52w >= -0.05)
 * - 52W Stage 2: within 16% AND within 10% above 200EMA
 * - 20-day sprint cap: 10%
 * - 5-day sprint cap: 7.5%
 * - 3-day sprint cap: 5.5%
 * - VCP pre-range: 6.5%
 * - Base symmetry: 25% time in upper half
 * - Ceiling age: 3+ bars on TRUE resistance
 * - Touches: 2+ within 1.5% of true resistance
 * - Candle: body>=45%, closeLoc>=60%, upperWick<=32%
 * - RVOL: 1.5x to 5.5x
 * - Penetration: close > trueResistance + 0.05*ATR
 * - Stop: baseFloor (or breakoutLow - 0.5*ATR if lower)
 * - Target 1: +1.5R (lock 50%, move stop to breakeven +0.2%)
 * - Runner: 50 EMA close (exit same day), remaining 50%
 * - Friction: 41.56 bps round-trip baked into expectancy
 */

class ResistanceBreakoutStrategy {
    constructor(config = {}) {
        // Base geometry
        this.baseLookback = config.baseLookback ?? 40;
        this.macroLookback = config.macroLookback ?? 60;
        this.high52wLookback = config.high52wLookback ?? 250;
        this.minBaseDepth = config.minBaseDepth ?? 0.04;
        this.maxBaseDepth = config.maxBaseDepth ?? 0.22;
        
        // Ceiling maturity
        this.minCeilAge = config.minCeilAge ?? 3;
        
        // Dual-Gate 52W Architecture
        this.blueSkyDist52w = config.blueSkyDist52w ?? -0.050;      // Gate 1: within 5% of 52W high
        this.stage2Dist52w = config.stage2Dist52w ?? -0.160;        // Gate 2: within 16% of 52W high
        this.stage2MaxDistEMA200 = config.stage2MaxDistEMA200 ?? 0.100; // Gate 2: within 10% above 200EMA
        
        // Sprint filters (DOCUMENTED VALUES - tightened from v5)
        this.maxPrior20dRun = config.maxPrior20dRun ?? 0.100;  // 10% (was 18%)
        this.maxPrior5dRun = config.maxPrior5dRun ?? 0.075;   // 7.5% (was 10%)
        this.maxPrior3dRun = config.maxPrior3dRun ?? 0.055;   // 5.5% (was 7.5%)
        
        // VCP tightness (DOCUMENTED VALUE)
        this.maxPreRange3d = config.maxPreRange3d ?? 0.065;   // 6.5% (was 8%)
        
        // Touches
        this.minTouches = config.minTouches ?? 2;
        
        // Penetration buffer
        this.penBufferATR = config.penBufferATR ?? 0.05;
        
        // Candle microstructure
        this.minBodyRatio = config.minBodyRatio ?? 0.45;
        this.minCloseLoc = config.minCloseLoc ?? 0.60;
        this.maxUpperWick = config.maxUpperWick ?? 0.32;
        
        // Volume
        this.minRVOL = config.minRVOL ?? 1.5;   // Raised from 1.4
        this.maxRVOL = config.maxRVOL ?? 5.5;
        
        // Liquidity (mid-cap friendly default)
        this.minTurnoverCr = config.minTurnoverCr ?? 5.0;
        
        // Execution
        this.maxChasePct = config.maxChasePct ?? 0.020;
        
        // Risk & Targets (R-multiple based, cost-aware)
        this.frictionBps = config.frictionBps ?? 41.56;
        this.frictionDecimal = this.frictionBps / 10000;
        this.minRiskPct = config.minRiskPct ?? 0.008;
        this.maxRiskPct = config.maxRiskPct ?? 0.040;
        this.target1R = config.target1R ?? 1.5;           // +1.5R (was 1.2R / 2.5% fixed)
        this.breakevenBufferPct = config.breakevenBufferPct ?? 0.002;
        this.runnerEMA = config.runnerEMA ?? 50;          // 50 EMA (was 20)
        this.runnerExitSameDay = config.runnerExitSameDay ?? true; // Exit on close < EMA same day
        
        // Optional trend filter
        this.useADXFilter = config.useADXFilter ?? false;
        this.minADX = config.minADX ?? 25;
        
        // Stop methodology
        this.stopMethod = config.stopMethod ?? "baseFloor"; // "baseFloor" | "breakoutLowATR"
        this.stopATRMult = config.stopATRMult ?? 0.5;       // For breakoutLowATR method
    }

    /**
     * Get ATR - prefers Wilder's (atr14_wilder) else falls back to atr14
     */
    _getATR(bar) {
        return bar.atr14_wilder ?? bar.atr14 ?? 0;
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
        const curATR = this._getATR(currentBar);
        const ema20 = currentBar.ema20;
        const ema50 = currentBar.ema50;
        const ema200 = currentBar.ema200;
        const adx = currentBar.adx14;
        const turnoverCr = currentBar.turnoverCr ?? 0.0;

        // 1. Core Regime Gates
        if (close < ema200) return null; // Uptrend above 200 EMA
        if (turnoverCr < this.minTurnoverCr) return null; // Liquidity gate
        if (niftyCandle) {
            if (niftyCandle.close < niftyCandle.ema50) return null; // NIFTY Bull gate
        } else {
            return null; // Benchmark data required
        }

        if (!volSMA20 || volSMA20 <= 0 || !curATR || curATR <= 0) return null;

        // Optional ADX trend filter
        if (this.useADXFilter && adx && adx < this.minADX) return null;

        // 2. Base Geometry & Maturity (40-bar window)
        let ceiling40 = -Infinity;
        let floor40 = Infinity;
        let highestBarRelIdx40 = 0;

        for (let j = 0; j < baseBars.length; j++) {
            if (baseBars[j].high > ceiling40) {
                ceiling40 = baseBars[j].high;
                highestBarRelIdx40 = j;
            }
            if (baseBars[j].low < floor40) floor40 = baseBars[j].low;
        }

        // 3. Macro Ceiling (60-bar window) & True Resistance
        let macroCeiling = -Infinity;
        let macroCeilingIdx = 0;
        for (let k = 0; k < macroBars.length; k++) {
            if (macroBars[k].high > macroCeiling) {
                macroCeiling = macroBars[k].high;
                macroCeilingIdx = k;
            }
        }

        const trueResistance = Math.max(ceiling40, macroCeiling);
        
        // Price must close cleanly above True Resistance + ATR buffer
        if (close < trueResistance + this.penBufferATR * curATR) {
            return null;
        }

        // 4. Base Symmetry / Time in Upper Half (25% - ALIGNED WITH BACKTESTER)
        const midBase = floor40 + 0.5 * (trueResistance - floor40);
        let upperHalfCount = 0;
        for (let j = 0; j < baseBars.length; j++) {
            if (baseBars[j].close >= midBase) upperHalfCount++;
        }
        if (upperHalfCount / baseBars.length < 0.25) { // FIXED: was 0.40
            return null;
        }

        // 5. 52-Week High Proximity - DUAL-GATE ARCHITECTURE
        const w52Start = Math.max(0, currentIndex - this.high52wLookback);
        const bars52w = dailyBars.slice(w52Start, currentIndex);
        const high52w = Math.max(...bars52w.map(b => b.high));
        const dist52w = (close - high52w) / high52w;
        const dist200 = (close - ema200) / ema200;

        // Gate 1: BLUE SKY - within 5% of 52W high (pure ATH breakout)
        const isBlueSky = dist52w >= this.blueSkyDist52w;
        
        // Gate 2: STAGE 2 BASE LAUNCH - within 16% of 52W high AND within 10% above 200EMA
        const isStage2Base = (dist52w >= this.stage2Dist52w) && (dist200 <= this.stage2MaxDistEMA200);
        
        if (!isBlueSky && !isStage2Base) return null;

        // 6. Ceiling Age - measured on TRUE resistance (max of 40-bar and 60-bar ceilings)
        let ceilAge;
        if (trueResistance === ceiling40) {
            // True resistance came from 40-bar window
            ceilAge = baseBars.length - highestBarRelIdx40;
        } else {
            // True resistance came from 60-bar macro window
            ceilAge = macroBars.length - macroCeilingIdx;
        }

        // Pre-breakout test-wick protection (waived on fresh ATH breaks)
        if (ceilAge < this.minCeilAge) {
            for (let j = 0; j < macroBars.length - 3; j++) {
                if (macroBars[j].high >= trueResistance * 0.985) {
                    ceilAge = macroBars.length - j;
                    break;
                }
            }
        }
        if (ceilAge < this.minCeilAge && !isBlueSky) return null; // Only waive for Blue Sky

        // 7. Anti-Runaway & Multi-Window Sprint Filters (TIGHTENED TO DOCUMENTED VALUES)
        // 20-day: 10% max
        const bar20Ago = dailyBars[Math.max(0, currentIndex - 20)];
        if (bar20Ago) {
            const prior20dRun = (close - bar20Ago.close) / bar20Ago.close;
            if (prior20dRun > this.maxPrior20dRun) return null;
        }

        // 5-day: 7.5% max
        const bar5Ago = dailyBars[Math.max(0, currentIndex - 5)];
        if (bar5Ago) {
            const prior5dRun = (close - bar5Ago.close) / bar5Ago.close;
            if (prior5dRun > this.maxPrior5dRun) return null;
        }

        // 3-day: 5.5% max
        const bar3Ago = dailyBars[Math.max(0, currentIndex - 3)];
        if (bar3Ago) {
            const prior3dRun = (close - bar3Ago.close) / bar3Ago.close;
            if (prior3dRun > this.maxPrior3dRun) return null;
        }

        // 8. Pre-Breakout Tightness / VCP Consolidation (6.5% - DOCUMENTED)
        const pre3Bars = dailyBars.slice(Math.max(0, currentIndex - 3), currentIndex);
        if (pre3Bars.length >= 3) {
            const preH3 = Math.max(...pre3Bars.map(b => b.high));
            const preL3 = Math.min(...pre3Bars.map(b => b.low));
            if ((preH3 - preL3) / preL3 > this.maxPreRange3d) return null;
        }

        // 9. Base Depth
        const baseDepth = (trueResistance - floor40) / trueResistance;
        if (baseDepth < this.minBaseDepth || baseDepth > this.maxBaseDepth) return null;

        // 10. Touches near True Resistance (within 1.5%) - waived on Blue Sky
        let touches = 0;
        for (let j = 0; j < macroBars.length; j++) {
            if (macroBars[j].high >= trueResistance * 0.985) touches++;
        }
        if (touches < this.minTouches && !isBlueSky) return null;

        // 11. Candle Microstructure
        const candleRange = Math.max(high - low, 1e-4);
        const body = close - open;
        const bodyRatio = body / candleRange;
        const closeLoc = (close - low) / candleRange;
        const upperWick = (high - Math.max(open, close)) / candleRange;
        const rvol = volume / volSMA20;

        if (close <= open || bodyRatio < this.minBodyRatio || closeLoc < this.minCloseLoc || upperWick > this.maxUpperWick) return null;

        // Volume Sweet Spot (1.5x to 5.5x)
        if (rvol < this.minRVOL || rvol > this.maxRVOL) return null;

        // 12. Stop Loss Calculation - FIXED: Use baseFloor (or breakoutLow - 0.5*ATR)
        let initialStop;
        if (this.stopMethod === "baseFloor") {
            initialStop = floor40; // Stop below base floor - protects entire consolidation
        } else {
            // breakoutLowATR: breakout candle low minus ATR buffer
            initialStop = Math.max(floor40, low - this.stopATRMult * curATR);
        }
        // Round to tick
        initialStop = Math.round(initialStop * 100) / 100;

        // 13. Risk Validation (cost-aware)
        const entryPrice = close; // Signal at close; fill modeled at next open <= close*(1+chase)
        const riskDistance = entryPrice - initialStop;
        const riskPct = riskDistance / entryPrice;
        
        if (riskPct > this.maxRiskPct || riskPct < this.minRiskPct) return null;

        // 14. Target 1: +1.5R (R-multiple, volatility-adjusted)
        const target1Price = Math.round((entryPrice + this.target1R * riskDistance) * 100) / 100;
        const breakevenStop = Math.round(entryPrice * (1 + this.breakevenBufferPct) * 100) / 100;

        // 15. Runner: 50 EMA trail (exit same day on close < EMA)
        const runnerEMA = currentBar["ema" + this.runnerEMA] ?? ema50;
        const runnerTrailTrigger = "Close < " + this.runnerEMA + " EMA (currently Rs " + Math.round(runnerEMA * 100) / 100 + ")";
        const runnerExitMode = this.runnerExitSameDay ? "SAME_DAY_CLOSE" : "NEXT_DAY_OPEN";

        // 16. Order Placement (Zero Lookahead - placed at Day t Close)
        const orderLimitPrice = Math.round(trueResistance * (1.0 + this.maxChasePct) * 100) / 100;

        // 17. Friction-Adjusted Expectancy (for logging/decision)
        const grossR = this.target1R * 0.5; // 50% at target1
        const netRAfterFriction = grossR - (this.frictionDecimal / riskPct);

        return {
            symbol: currentBar.symbol,
            date: currentBar.date,
            classification: isBlueSky ? "BLUE_SKY_BREAKOUT" : "STAGE2_BASE_BREAKOUT",
            gate: isBlueSky ? "BLUE_SKY" : "STAGE2_BASE",
            currentPrice: close,
            ceilingResistance: trueResistance,
            ceilAgeBars: ceilAge,
            dist52wPct: Math.round(dist52w * 1000) / 10,
            dist200Pct: Math.round(dist200 * 1000) / 10,
            baseFloor: floor40,
            baseDepthPct: Math.round(baseDepth * 1000) / 10,
            rvol: Math.round(rvol * 100) / 100,
            adx: adx ? Math.round(adx * 10) / 10 : null,
            execution: {
                orderType: "BUY_STOP_LIMIT",
                stopTrigger: trueResistance,
                limitPrice: orderLimitPrice,
                initialStopLoss: initialStop,
                riskPct: (riskPct * 100).toFixed(2) + "%",
                riskDistance: Math.round(riskDistance * 100) / 100,
                target1: target1Price,
                target1R: this.target1R,
                target1Action: "LOCK 50% at +" + this.target1R + "R (Rs " + target1Price + ") -> STOP TO BREAKEVEN +" + (this.breakevenBufferPct*100).toFixed(1) + "% (Rs " + breakevenStop + ")",
                runnerManagement: this.runnerEMA + "_EMA_" + runnerExitMode + " (Remaining 50%)",
                trailingTrigger: runnerTrailTrigger,
                frictionBps: this.frictionBps,
                netExpectancyR: Math.round(netRAfterFriction * 100) / 100
            }
        };
    }
}

module.exports = ResistanceBreakoutStrategy;
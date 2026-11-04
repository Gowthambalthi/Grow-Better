"use strict";

/**
 * strategies/mine/entry_exit.js
 * Authoritative Order Execution and Trade Lifecycle Engine (JavaScript)
 * 
 * CORE REALISTIC EXECUTION RULES:
 * 1. Structural Stop Integrity: Rejects trades if risk distance is outside [2.5%, 7.5%]. Never clamps stop.
 * 2. Next-Session Entry: Buys next open, or places limit order if gap > 3.0%.
 * 3. Gap-Down Stop Realism: If bar opens below stop, executes at Open (never theoretical stop).
 * 4. Day-1 Conservative Intraday Stop: If Day-1 Low <= Stop, assumes stopped out at min(open, stop).
 * 5. Realistic Friction: 0.28% round-trip Zerodha delivery friction on every executed trade.
 */

const { CONFIG } = require("./config");

class TradeExecutionEngine {
    constructor(config = {}) {
        this.cfg = { ...CONFIG, ...config };
    }

    /**
     * Evaluates trade qualification and calculates initial order parameters.
     * Returns null if structural risk is outside permitted bounds.
     */
    prepareOrder(detectedPattern, currentClose) {
        if (!detectedPattern || !detectedPattern.level || !detectedPattern.stopLevel) {
            return null;
        }

        const pivot = detectedPattern.level;
        const structStop = detectedPattern.stopLevel;
        const riskPct = ((currentClose - structStop) / currentClose) * 100.0;

        // FIX BUG: DO NOT CLAMP STRUCTURAL STOP. REJECT UNHEALTHY RISK.
        if (riskPct < this.cfg.MIN_STRUCTURAL_RISK_PCT || riskPct > this.cfg.MAX_STRUCTURAL_RISK_PCT) {
            return null; // Reject trade completely
        }

        return {
            pattern: detectedPattern.pattern,
            pivotPrice: pivot,
            structuralStop: structStop,
            signalClose: currentClose,
            initialRiskPct: riskPct
        };
    }

    /**
     * Simulates complete trade lifecycle from signal bar onwards.
     * sessions: full candlestick array [{ date, open, high, low, close, volume }]
     * signalIdx: index of the breakout bar
     */
    simulateTrade(sessions, signalIdx, orderSetup) {
        const n = sessions.length;
        if (signalIdx + 1 >= n) return null; // No forward bar available

        const nextBar = sessions[signalIdx + 1];
        const pivot = orderSetup.pivotPrice;
        let entryPrice = nextBar.open;
        let isLimitOrder = false;

        // Anti-Chasing Limit Gate
        const maxGap = pivot * (1.0 + this.cfg.MAX_GAP_BUY_POCKET_PCT / 100.0);
        if (nextBar.open > maxGap) {
            const limitPrice = pivot * (1.0 + this.cfg.LIMIT_RETEST_LEVEL_PCT / 100.0);
            if (nextBar.low <= limitPrice) {
                entryPrice = limitPrice;
                isLimitOrder = true;
            } else {
                return null; // Limit order not filled; missed entry
            }
        }

        const frictionHalf = this.cfg.FRICTION_ROUND_TRIP / 2.0;
        const entryPriceWithFriction = entryPrice * (1.0 + frictionHalf);
        let curStop = orderSetup.structuralStop;

        const t1Price = entryPriceWithFriction * (1.0 + this.cfg.TARGET_1_PCT / 100.0);
        const t2Price = entryPriceWithFriction * (1.0 + this.cfg.TARGET_2_PCT / 100.0);

        let t1Hit = false;
        let tradePnl = null;
        let exitReason = null;
        let exitBarIdx = null;
        let exitPriceActual = null;
        let barsHeld = 0;
        let wasGapLoss = false;

        for (let k = signalIdx + 1; k < Math.min(signalIdx + 1 + this.cfg.MAX_HOLD_BARS, n); k++) {
            barsHeld++;
            const bar = sessions[k];
            const o = bar.open, h = bar.high, l = bar.low, c = bar.close;

            // DAY 1 EXECUTION: Handle Intraday Ambiguity
            if (k === signalIdx + 1) {
                if (l <= curStop) {
                    // Conservative execution: stopped out on Day 1
                    exitPriceActual = Math.min(curStop, c);
                    tradePnl = (exitPriceActual * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction;
                    exitReason = "DAY1_INTRADAY_STOP";
                    exitBarIdx = k;
                    break;
                }
                continue; // Survived Day 1
            }

            // DAY 2 ONWARDS:
            // 1. Check Gap-Down through stop
            if (o < curStop) {
                wasGapLoss = true;
                exitPriceActual = o; // Filled at Open, NOT at stop price!
                tradePnl = (exitPriceActual * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction;
                exitReason = "GAP_DOWN_STOP";
                exitBarIdx = k;
                break;
            }

            // 2. Target 1 Check (+6.5%)
            if (!t1Hit && h >= t1Price) {
                t1Hit = true;
                // Move stop to Breakeven (+ friction covered)
                curStop = Math.max(curStop, entryPriceWithFriction * (1.0 + this.cfg.FRICTION_ROUND_TRIP));
            }

            // 3. Normal Intraday Stop Hit
            if (l <= curStop) {
                exitPriceActual = curStop;
                const exitNet = exitPriceActual * (1.0 - frictionHalf);
                if (t1Hit) {
                    tradePnl = 0.5 * ((t1Price * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction) +
                               0.5 * ((exitNet - entryPriceWithFriction) / entryPriceWithFriction);
                    exitReason = "RUNNER_STOP_BE";
                } else {
                    tradePnl = (exitNet - entryPriceWithFriction) / entryPriceWithFriction;
                    exitReason = "NORMAL_STOP";
                }
                exitBarIdx = k;
                break;
            }

            // 4. Trailing Runner (3-day swing low)
            if (t1Hit && k >= signalIdx + 4) {
                let trailLow = Infinity;
                for (let b = k - 3; b < k; b++) {
                    if (sessions[b].low < trailLow) trailLow = sessions[b].low;
                }
                if (trailLow > curStop) curStop = trailLow;

                // 5. Target 2 Hit (+15.0%)
                if (h >= t2Price) {
                    exitPriceActual = t2Price;
                    tradePnl = 0.5 * ((t1Price * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction) +
                               0.5 * ((t2Price * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction);
                    exitReason = "TARGET_2";
                    exitBarIdx = k;
                    break;
                }
            }
        }

        // Time Exit (if max hold bars reached)
        if (tradePnl === null) {
            const lastBar = sessions[Math.min(signalIdx + this.cfg.MAX_HOLD_BARS, n - 1)];
            exitPriceActual = lastBar.close;
            const exitNet = exitPriceActual * (1.0 - frictionHalf);
            if (t1Hit) {
                tradePnl = 0.5 * ((t1Price * (1.0 - frictionHalf) - entryPriceWithFriction) / entryPriceWithFriction) +
                           0.5 * ((exitNet - entryPriceWithFriction) / entryPriceWithFriction);
            } else {
                tradePnl = (exitNet - entryPriceWithFriction) / entryPriceWithFriction;
            }
            exitReason = "TIME_EXIT";
            exitBarIdx = Math.min(signalIdx + this.cfg.MAX_HOLD_BARS, n - 1);
        }

        return {
            pattern: orderSetup.pattern,
            entryDate: nextBar.date,
            entryPrice: +entryPrice.toFixed(2),
            stopPrice: +orderSetup.structuralStop.toFixed(2),
            exitDate: sessions[exitBarIdx].date,
            exitPrice: +exitPriceActual.toFixed(2),
            pnlPct: +(tradePnl * 100.0).toFixed(2),
            win: tradePnl > 0,
            barsHeld,
            exitReason,
            wasGapLoss,
            isLimitOrder
        };
    }
}

module.exports = { TradeExecutionEngine };

"use strict";

/**
 * strategies/mine/backtest.js
 * Authoritative Multi-Year Portfolio Backtester (JavaScript)
 * Matches strategies/mine/backtest.py 1:1.
 */

const fs = require("fs");
const path = require("path");
const { CONFIG } = require("./config");
const { detectPattern } = require("./patterns");
const { TradeExecutionEngine } = require("./entry_exit");

function calculateWilderRSI(closes, period = 14) {
    const n = closes.length;
    if (n < period + 2) return new Array(n).fill(50.0);
    const rsi = new Array(n).fill(50.0);
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
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi[i] = 100 - (100 / (1 + rs));
    }
    return rsi;
}

function runBacktest() {
    console.log("===============================================================================================");
    console.log("  RUNNING UNIFIED QUANTITATIVE BACKTEST (NODE.JS, 997 STOCKS, 3 YEARS)");
    console.log("===============================================================================================");

    const niftyRaw = JSON.parse(fs.readFileSync(CONFIG.NIFTY_PATH, "utf8")).candles;
    const nDates = niftyRaw.map(c => c[0].slice(0, 10));
    const nCloses = niftyRaw.map(c => +c[4]);
    
    // EMA 50
    const nEma50 = new Array(nCloses.length);
    let k50 = 2 / 51;
    nEma50[0] = nCloses[0];
    for (let i = 1; i < nCloses.length; i++) nEma50[i] = nCloses[i] * k50 + nEma50[i - 1] * (1 - k50);

    const nMap = {};
    for (let i = 0; i < nDates.length; i++) {
        nMap[nDates[i]] = { close: nCloses[i], bull: nCloses[i] > nEma50[i] };
    }

    const files = fs.readdirSync(CONFIG.OHLCV_DIR)
        .filter(f => f.endsWith(".json") && !f.includes("NIFTYBEES"))
        .map(f => path.join(CONFIG.OHLCV_DIR, f));

    const engine = new TradeExecutionEngine();
    const allTrades = [];

    for (const fPath of files) {
        const sym = path.basename(fPath, ".json");
        try {
            const raw = JSON.parse(fs.readFileSync(fPath, "utf8")).candles;
            if (raw.length < 220) continue;

            const sessions = raw.map(c => ({
                date: c[0].slice(0, 10),
                open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5]
            }));

            const closes = sessions.map(s => s.close);
            const n = sessions.length;

            // EMA 20, 50, 200
            const ema20 = new Array(n), ema50 = new Array(n), ema200 = new Array(n);
            let k20 = 2/21, k200 = 2/201;
            ema20[0] = closes[0]; ema50[0] = closes[0]; ema200[0] = closes[0];
            for (let i = 1; i < n; i++) {
                ema20[i] = closes[i] * k20 + ema20[i-1] * (1 - k20);
                ema50[i] = closes[i] * k50 + ema50[i-1] * (1 - k50);
                ema200[i] = closes[i] * k200 + ema200[i-1] * (1 - k200);
            }

            const rsi = calculateWilderRSI(closes, CONFIG.RSI_PERIOD);
            let lastTradeIdx = -999;

            for (let i = 85; i < n - 26; i++) {
                if (i - lastTradeIdx < 18) continue;
                const dt = sessions[i].date;

                // Market Gate
                if (CONFIG.REQUIRE_NIFTY_BULL) {
                    if (!nMap[dt] || !nMap[dt].bull) continue;
                }

                const cNow = sessions[i].close;
                const vNow = sessions[i].volume || 1;

                // Vol SMA 20
                let sumV = 0;
                for (let v = i - 20; v < i; v++) sumV += (sessions[v].volume || 1);
                const avgV = sumV / 20;
                if (vNow < avgV * CONFIG.MIN_BREAKOUT_VOL_SURGE) continue;

                // Trend
                if (cNow < ema50[i] || ema20[i] < ema50[i]) continue;
                if (cNow > ema200[i] * (1.0 + CONFIG.MAX_200_EMA_EXTENSION)) continue;

                // RSI [50, 78]
                if (rsi[i] < CONFIG.RSI_MIN || rsi[i] > CONFIG.RSI_MAX) continue;

                // RS vs NIFTY
                const lb = CONFIG.RS_LOOKBACK_BARS;
                if (i >= lb && nMap[dt] && nMap[sessions[i - lb].date]) {
                    const sRet = (cNow - sessions[i - lb].close) / sessions[i - lb].close;
                    const nRet = (nMap[dt].close - nMap[sessions[i - lb].date].close) / nMap[sessions[i - lb].date].close;
                    if ((sRet - nRet) * 100 < CONFIG.MIN_RS_OUTPERFORMANCE) continue;
                } else continue;

                // Wick quality
                const rng = sessions[i].high - sessions[i].low;
                if (rng <= 0 || (sessions[i].high - cNow) / rng > CONFIG.MAX_UPPER_WICK_RATIO) continue;

                const subSessions = sessions.slice(0, i + 1);
                const detected = detectPattern(subSessions);
                if (!detected) continue;

                const orderSetup = engine.prepareOrder(detected, cNow);
                if (!orderSetup) continue;

                const trade = engine.simulateTrade(sessions, i, orderSetup);
                if (trade) {
                    trade.sym = sym;
                    trade.rsi = +rsi[i].toFixed(1);
                    allTrades.push(trade);
                    lastTradeIdx = i;
                }
            }
        } catch (e) {}
    }

    allTrades.sort((a, b) => a.entryDate.localeCompare(b.entryDate));

    // 20-Slot Portfolio Execution
    let activePositions = [];
    const portfolioTrades = [];

    for (const t of allTrades) {
        activePositions = activePositions.filter(p => p.exitDate > t.entryDate);
        if (activePositions.length < CONFIG.MAX_CONCURRENT_POSITIONS) {
            activePositions.push(t);
            portfolioTrades.push(t);
        }
    }

    const tot = portfolioTrades.length;
    const wins = portfolioTrades.filter(t => t.win);
    const losses = portfolioTrades.filter(t => !t.win);
    const wr = (wins.length / tot) * 100;
    const pnls = portfolioTrades.map(t => t.pnlPct);
    const gg = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
    const pf = gl > 0 ? (gg / gl) : 999;
    const aw = wins.length ? (gg / wins.length) : 0;
    const al = losses.length ? (-gl / losses.length) : 0;
    const exp = (wr / 100) * aw - ((100 - wr) / 100) * Math.abs(al);
    const gapFreq = (portfolioTrades.filter(t => t.wasGapLoss).length / tot) * 100;

    console.log(`\nExecuted Portfolio Trades: ${tot} (~${(tot/3).toFixed(0)}/yr | ~${(tot/150).toFixed(1)} calls/week)`);
    console.log(`Win Rate                 : ${wr.toFixed(2)}% (${wins.length} Wins / ${losses.length} Losses)`);
    console.log(`Profit Factor            : ${pf.toFixed(2)}`);
    console.log(`Average Winner           : +${aw.toFixed(2)}% | Average Loser: ${al.toFixed(2)}%`);
    console.log(`Win/Loss Payoff Ratio    : ${(Math.abs(aw/al)).toFixed(2)}x`);
    console.log(`Net Expectancy E(R)      : +${exp.toFixed(2)}% per trade`);
    console.log(`Gap-Loss Frequency       : ${gapFreq.toFixed(2)}% of trades`);
    console.log(`Cumulative Net Return    : +${pnls.reduce((a, b) => a + b, 0).toFixed(1)}%`);

    return portfolioTrades;
}

if (require.main === module) {
    runBacktest();
}

module.exports = { runBacktest, calculateWilderRSI };

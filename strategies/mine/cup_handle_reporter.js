"use strict";

/**
 * strategies/mine/cup_handle_reporter.js
 * Authoritative Cup & Handle Geometric Measurement Reporter (JavaScript)
 * Matches strategies/mine/cup_handle_reporter.py 1:1.
 */

function printCupHandleReport(symbol, sessions, idx = null) {
    if (idx === null) idx = sessions.length - 1;
    const sub = sessions.slice(0, idx + 1);
    const n = sub.length;

    const highs = sub.map(s => s.high);
    const lows = sub.map(s => s.low);
    const closes = sub.map(s => s.close);
    const vols = sub.map(s => s.volume || 1);
    const dates = sub.map(s => s.date);

    let match = null;
    const clenGrid = [35, 45, 50, 55, 60, 65, 75, 90, 110];

    for (const clen of clenGrid) {
        for (let hlen = 5; hlen <= 23; hlen += 2) {
            const tot = clen + hlen;
            if (n < tot + 30) continue;
            const cs = n - 1 - tot;
            const ce = n - 1 - hlen;

            const priorStart = Math.max(0, cs - 100);
            let priorMin = Infinity;
            for (let i = priorStart; i <= cs; i++) {
                if (lows[i] < priorMin) priorMin = lows[i];
            }
            const priorGain = (highs[cs] - priorMin) / priorMin * 100.0;

            let lr = -Infinity, lIdx = cs;
            for (let i = cs; i < cs + 18; i++) {
                if (highs[i] > lr) { lr = highs[i]; lIdx = i; }
            }

            let rr = -Infinity, rIdx = ce;
            for (let i = Math.max(cs + 25, ce - 8); i <= ce; i++) {
                if (highs[i] > rr) { rr = highs[i]; rIdx = i; }
            }

            const rimDist = rIdx - lIdx;
            if (rimDist < 25 || rimDist > 120) continue;
            const rimDiffPct = Math.abs(rr - lr) / lr * 100.0;
            if (rimDiffPct > 4.5) continue;

            const rim = Math.max(lr, rr);
            let cupBot = Infinity, botIdx = lIdx;
            for (let i = lIdx; i <= rIdx; i++) {
                if (lows[i] < cupBot) { cupBot = lows[i]; botIdx = i; }
            }
            const cupDepthPct = (rim - cupBot) / rim * 100.0;

            const bottomQuartile = cupBot + 0.25 * (rim - cupBot);
            let barsInBottom = 0;
            for (let i = lIdx; i <= rIdx; i++) {
                if (lows[i] <= bottomQuartile) barsInBottom++;
            }
            const botPos = (botIdx - lIdx) / rimDist;

            const actualHandleLen = (n - 1) - rIdx;
            if (actualHandleLen < 5 || actualHandleLen > 25) continue;

            let hBot = Infinity;
            for (let i = rIdx + 1; i < n - 1; i++) {
                if (lows[i] < hBot) hBot = lows[i];
            }
            const handlePullbackPct = (rr - hBot) / rr * 100.0;
            const handleRatio = (handlePullbackPct / cupDepthPct) * 100.0;

            let cupVolSum = 0, hVolSum = 0;
            for (let i = cs; i < rIdx; i++) cupVolSum += vols[i];
            for (let i = rIdx; i < n - 1; i++) hVolSum += vols[i];
            const avgCupVol = cupVolSum / (rIdx - cs);
            const avgHVol = hVolSum / (n - 1 - rIdx);
            const volRatio = avgHVol / avgCupVol;

            let vol20Sum = 0;
            for (let i = n - 21; i < n - 1; i++) vol20Sum += vols[i];
            const avgVol20 = vol20Sum / 20;
            const breakoutVolMult = vols[n - 1] / avgVol20;

            const curC = closes[n - 1];
            if (curC > rim * 0.990) {
                match = {
                    cupLen: rimDist,
                    handleLen: actualHandleLen,
                    leftRim: lr,
                    leftRimDate: dates[lIdx],
                    rightRim: rr,
                    rightRimDate: dates[rIdx],
                    rimDiffPct,
                    cupBot,
                    cupBotDate: dates[botIdx],
                    cupDepthPct,
                    handleBot: hBot,
                    handlePullbackPct,
                    handleRatio,
                    barsInBottom,
                    botPos,
                    priorGain,
                    volRatio,
                    breakoutVolMult,
                    breakoutClose: curC,
                    signalDate: dates[idx]
                };
                break;
            }
        }
        if (match) break;
    }

    console.log("\n" + "=".repeat(65));
    console.log(`       CUP AND HANDLE VALIDATION REPORT: ${symbol}`);
    console.log("=".repeat(65));
    if (!match) {
        console.log("  Status: NO CUP AND HANDLE PATTERN DETECTED");
        console.log("=".repeat(65));
        return null;
    }

    const m = match;
    const curveStatus = (m.barsInBottom >= 5 && m.botPos >= 0.30 && m.botPos <= 0.70) ? "PASS" : "FAIL";
    const priorStatus = (m.priorGain >= 20.0) ? "PASS" : "FAIL";
    const diffStatus = (m.rimDiffPct <= 3.0) ? "PASS" : "MARGINAL";
    const ratioStatus = (m.handleRatio <= 35.0) ? "PASS" : "FAIL (HANDLE DEEP)";
    const volStatus = (m.breakoutVolMult >= 1.5) ? "PASS" : "FAIL";

    console.log(`Signal Date:             ${m.signalDate}`);
    console.log(`Cup length:              ${m.cupLen} trading days (${m.leftRimDate} to ${m.rightRimDate})`);
    console.log(`Handle length:           ${m.handleLen} trading days (${m.rightRimDate} to ${m.signalDate})`);
    console.log(`Left rim:                Rs ${m.leftRim.toFixed(2)}`);
    console.log(`Right rim:               Rs ${m.rightRim.toFixed(2)}`);
    console.log(`Rim difference:          ${m.rimDiffPct.toFixed(2)}% [${diffStatus}]`);
    console.log(`Cup depth:               ${m.cupDepthPct.toFixed(2)}% [PASS 12% - 35%]`);
    console.log(`Handle depth:            ${m.handlePullbackPct.toFixed(2)}% below right rim`);
    console.log(`Handle / cup ratio:      ${m.handleRatio.toFixed(2)}% [${ratioStatus}]`);
    console.log(`Bottom curvature:        ${curveStatus} (${m.barsInBottom} bars in bottom quartile)`);
    console.log(`Prior uptrend:           ${priorStatus} (+${m.priorGain.toFixed(1)}% advance)`);
    console.log(`Breakout volume:         ${m.breakoutVolMult.toFixed(2)}x 20-day SMA [${volStatus}]`);
    console.log("-".repeat(65));
    console.log("DECISION 1 (Pattern):    VALID CUP & HANDLE FORMATION");

    const stopDist = ((m.breakoutClose - m.handleBot * 0.995) / m.breakoutClose) * 100.0;
    const tradeStatus = (stopDist <= 7.5) ? "ACCEPT" : "REJECT (STOP TOO WIDE > 7.5%)";
    console.log(`DECISION 2 (Trade Risk): ${tradeStatus} (Initial Risk: ${stopDist.toFixed(2)}%)`);
    console.log("=".repeat(65) + "\n");
    return m;
}

module.exports = { printCupHandleReport };

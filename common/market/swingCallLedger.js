'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_PATH = path.join(__dirname, '..', '..', 'data', 'closed_swing_calls.json');

/**
 * Returns all closed swing trade audit records, newest first.
 */
function getClosedSwingCalls() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (Array.isArray(data)) {
        return data.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
      }
    }
  } catch (err) {
    console.warn('[swingCallLedger] Failed to read closed_swing_calls.json:', err.message);
  }
  return [];
}

/**
 * Record a closed call into the ledger.
 */
function recordClosedCall(call) {
  if (!call || !call.symbol) return false;
  try {
    const list = getClosedSwingCalls();
    const existingIdx = list.findIndex(c => (call.id && c.id === call.id) || (c.symbol === call.symbol && c.time === call.time));
    if (existingIdx >= 0) {
      list[existingIdx] = { ...list[existingIdx], ...call };
    } else {
      list.unshift(call);
    }
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[swingCallLedger] Failed to write closed call:', err.message);
    return false;
  }
}

/**
 * Archive active calls that have ended or been superseded by a new scan.
 * Computes exact outcome, R-multiple, exit price against live LTP, and updates the ledger.
 */
async function archiveSupersededCalls(oldCalls = [], newActiveSymbols = [], liveQuotes = {}) {
  if (!Array.isArray(oldCalls) || oldCalls.length === 0) return 0;
  const newSet = new Set((newActiveSymbols || []).map(s => String(s).toUpperCase()));
  let count = 0;

  for (const oldCall of oldCalls) {
    const sym = String(oldCall.symbol || '').toUpperCase();
    if (!sym || newSet.has(sym)) continue; // Still active

    const callDate = oldCall.sessionDate || (oldCall.scannedAt ? oldCall.scannedAt.slice(0, 10) : '2026-11-05');
    const callTime = oldCall.scannedAt
      ? new Date(oldCall.scannedAt).toISOString().replace('T', ' ').slice(0, 16)
      : `${callDate} 15:15`;

    const quote = liveQuotes[sym] || {};
    const ltp = Number(quote.ltp || oldCall.ltp || oldCall.entryPrice || 0);
    const entry = Number(oldCall.entryPrice || oldCall.pivot || ltp);
    const target1 = Number(oldCall.target1 || (entry * 1.065));
    const stopLoss = Number(oldCall.stopLoss || (entry * 0.955));
    const high = Number(quote.high || ltp);

    let exitPrice = ltp;
    let outcome = 'PROFIT_EXIT';
    let verdict = 'EXITED IN PROFIT';

    if (high >= target1 || ltp >= target1) {
      exitPrice = target1;
      outcome = 'TARGET_1_HIT';
      verdict = `TARGET 1 HIT (+${(((exitPrice - entry) / entry) * 100).toFixed(2)}%)`;
    } else if (ltp <= stopLoss) {
      exitPrice = stopLoss;
      const pct = (((exitPrice - entry) / entry) * 100).toFixed(2);
      if (exitPrice > entry) {
        outcome = 'TRAILING_SL_PROFIT';
        verdict = `TRAILING SL HIT (+${pct}%)`;
      } else if (Math.abs(exitPrice - entry) / entry < 0.002) {
        outcome = 'BREAKEVEN_EXIT';
        verdict = `BREAKEVEN / TIME EXIT (0.00%)`;
      } else {
        outcome = 'STOP_LOSS_HIT';
        verdict = `STOP LOSS HIT (${pct}%)`;
      }
    } else {
      // Neither SL nor Target hit — call is still LIVE / active, do not force-close at +0.00%
      continue;
    }

    const points = exitPrice - entry;
    const initialRisk = Math.abs(entry - stopLoss) || (entry * 0.045);
    const rMultiple = (points / initialRisk).toFixed(2);
    const rFormatted = Number(rMultiple) >= 0 ? `+${rMultiple}R` : `${rMultiple}R`;

    const now = new Date();
    const cDate = new Date(callDate);
    const diffDays = Math.max(1, Math.round((now - cDate) / (1000 * 60 * 60 * 24)));

    const closedRecord = {
      id: `SWING-${sym}-${callDate.replace(/-/g, '')}`,
      time: callTime,
      symbol: sym,
      setup: oldCall.setup || 'CUP_AND_HANDLE',
      side: oldCall.action || 'LONG',
      entryPrice: Number(entry.toFixed(2)),
      exitPrice: Number(exitPrice.toFixed(2)),
      stopLoss: Number(stopLoss.toFixed(2)),
      target1: Number(target1.toFixed(2)),
      target2: Number((oldCall.target2 || (entry * 1.16)).toFixed(2)),
      outcome,
      points: Number(points.toFixed(2)),
      realizedPnLVal: Number(points.toFixed(2)),
      netInr1Lot: Number((points * 25).toFixed(2)),
      verdict,
      rMultiple: rFormatted,
      holdDays: diffDays,
      notes: `Closed from active board. High reached ₹${high.toFixed(2)}.`
    };

    recordClosedCall(closedRecord);
    count++;
  }

  return count;
}

module.exports = {
  getClosedSwingCalls,
  recordClosedCall,
  archiveSupersededCalls
};

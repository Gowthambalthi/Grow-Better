'use strict';
/**
 * strategies/orderflow/gateTelemetry.js — L3 GATE TELEMETRY (measure-only).
 *
 * WHY THIS EXISTS. Every gate decision the engines make today is consumed and forgotten:
 * the funnel counts the FIRST failing condition, the console prints the top four, and
 * nothing survives the scan. So the next time a gate question is asked ("is this if/else
 * earning its keep?") the only evidence available is a rerun — and worse, an early
 * short-circuited check HIDES what every later gate would have said about the same
 * candidate, which is precisely the blind spot the gate research
 * (scratch/GATE_RESEARCH_2026-10-17.md, §5 external brief) flagged.
 *
 * THE CONTRACT: this module can ONLY record. It never gates, never filters, never
 * contributes to `funnel`, never throws into the scan (callers wrap it), and its
 * numbers are never read back by a decision path. One JSONL bundle per scan:
 *
 *   {"k":"scan", ist, t, funnel, book:{STATUS: n, ...}}   <- funnel exactly as published,
 *                                                             plus the day's call-status
 *                                                             tally (CANCELLED_EXHAUSTION
 *                                                             churn becomes countable)
 *   {"k":"c", ist, sym, dir:"L"|"S", ref, fails:[...], v:{...}, armed:bool}  <- one line
 *                                                             per EVALUATED candidate: ref
 *                                                             = first failure (funnel
 *                                                             semantics), fails = ALL
 *                                                             failures (overlap analysis),
 *                                                             v = the continuous values the
 *                                                             gates actually read
 *
 * File: <DATA_DIR>/gate_funnel_<day>.jsonl — the same DATA_DIR override the tape uses
 * (GB_ORDERFLOW_DIR), so tests and replay harnesses sandbox themselves automatically.
 * GB_GATE_TELEMETRY=0 disables the write entirely.
 */
const fs = require('fs');
const path = require('path');

/** The failing name a short-circuited if/else would have stopped at — funnel semantics. */
function firstFail(checks) {
  for (const pair of checks) { if (!pair[1]) return pair[0]; }
  return null;
}

/** EVERY failing name, including those masked behind the first failure. */
function failedSet(checks) {
  const out = [];
  for (const pair of checks) { if (!pair[1]) out.push(pair[0]); }
  return out;
}

/** Call-status tally — the churn (ARMED/CANCELLED_EXHAUSTION/...) as a countable object. */
function statusTally(callValues) {
  const tally = {};
  for (const c of callValues) {
    const s = (c && c.status) || 'UNKNOWN';
    tally[s] = (tally[s] || 0) + 1;
  }
  return tally;
}

/**
 * Append one scan's bundle. ONE appendFileSync for the whole bundle (scan line + rows)
 * so a scan costs one syscall, not one per candidate. Returns the file path.
 * Throws only to the caller's catch — telemetry failure must never touch the decision.
 */
function appendScan(dir, day, { ist, funnel, rows, bookStatus }) {
  const lines = [JSON.stringify({ k: 'scan', ist, t: Date.now(), funnel, book: bookStatus || {} })];
  for (const r of rows || []) {
    lines.push(JSON.stringify(Object.assign({ k: 'c', ist }, r)));
  }
  const file = path.join(dir, `gate_funnel_${day}.jsonl`);
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
}

module.exports = { firstFail, failedSet, statusTally, appendScan };
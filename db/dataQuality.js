/**
 * db/dataQuality.js
 *
 * Data Ingestion & Validation Layer
 * ---------------------------------
 * All NAV / AUM / TER / return values entering holdings & scheme_rank
 * computations must pass the validation gates below before use in
 * ICS/FICS calculations.
 *
 * Sources (primary → fallback):
 *   NAV      : AMFI NAVAll.txt → mfapi.in   (cross-checked, see verifyNavCrossSource)
 *   Returns  : computed in-house from NAV history (never ingested)
 *   AUM      : AMC factsheet / RTA → AMFI AAUM report (cross-check only)
 *   TER      : AMC factsheet → AMFI/SEBI disclosure (with effective month)
 *
 * A record failing any gate is written to data_quality_flags and excluded
 * from scoring until cleared. Nothing is silently dropped or ingested.
 */
'use strict';

const path = require('path');
const fs = require('fs');

let db; // injected via init(db)

function init(dbHandle) { db = dbHandle; ensureTables(); }

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS data_quality_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schemeId TEXT NOT NULL,
      field TEXT NOT NULL,              -- 'nav' | 'aum' | 'ter' | 'return_1Y' | ...
      gate TEXT NOT NULL,               -- 'G1'...'G7'
      rawValue TEXT,
      source TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'open',   -- open | auto_resolved | manually_cleared
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      resolvedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dqf_scheme ON data_quality_flags(schemeId);
    CREATE INDEX IF NOT EXISTS idx_dqf_status ON data_quality_flags(status);
    CREATE TABLE IF NOT EXISTS source_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schemeId TEXT,
      field TEXT NOT NULL,
      source TEXT NOT NULL,             -- 'amfi_navall' | 'mfapi' | 'amc_factsheet' | ...
      ok INTEGER NOT NULL,
      latencyMs INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_srclog_field ON source_log(field, createdAt);
  `);
}

/* ------------------------------------------------------------------ *
 * Gate definitions
 * ------------------------------------------------------------------ */

const GATES = {
  // G1 — AUM ceiling: largest Indian schemes ~₹80-100k Cr; 3L Cr is a parse error
  G1_AUM_CEILING: { gate: 'G1', field: 'aum',
    test: (v) => v == null || v <= 300000,
    msg: (v) => `AUM ₹${v} Cr exceeds plausible ceiling (₹3,00,000 Cr)` },

  // G3 — return plausibility, per category (configurable)
  G3_RETURN_BOUNDS: { gate: 'G3', field: 'return_1Y',
    // category regex -> [min, max] for 1Y return (%)
    bounds: [
      { re: /gold|silver|commodit/,           min: -40, max: 150 },
      { re: /small|mid/,                      min: -60, max: 150 },
      { re: /index|large|nifty|sensex|etf/,   min: -50, max: 100 },
      { fallback: true,                       min: -60, max: 200 },
    ],
    test: (v, cat) => {
      if (v == null) return true;
      const b = pickBounds(cat);
      return v >= b.min && v <= b.max;
    },
    msg: (v, cat) => { const b = pickBounds(cat); return `1Y return ${v}% outside [${b.min}, ${b.max}] for category "${cat}"`; } },

  // G5 — change-in-AUM % suppression for tiny bases
  G5_AUM_PCT_SUPPRESS: { gate: 'G5', field: 'aum_change_pct',
    minBaseCr: 5,
    test: (baseAum) => baseAum == null || baseAum >= 5 },

  // G6 — cross-period consistency: 1M annualized vs stated 1Y (>3x drift = flag)
  G6_CROSS_PERIOD: { gate: 'G6', field: 'return_1Y',
    test: (r1m, r1y) => {
      if (r1m == null || r1y == null) return true;
      const annualized = (Math.pow(1 + r1m / 100, 12) - 1) * 100;
      // compare on a common footing; allow negatives to be wildly different without flag
      if (annualized < 0 || r1y < 0) return true;
      return annualized <= r1y * 3 + 20;   // tolerance so a hot month isn't flagged
    },
    msg: (r1m, r1y) => `1M annualized (${((Math.pow(1 + r1m / 100, 12) - 1) * 100).toFixed(1)}%) >3x stated 1Y (${r1y}%)` },

  // G7 — freshness per cadence
  G7_FRESHNESS: { gate: 'G7',
    cadenceDays: { nav: 4, aum: 40, ter: 40, holdings: 40, return: 4 } },

  // G4 — benchmark delta bands (pp)
  G4_BENCH_DELTA: { gate: 'G4',
    indexBand: 25,   // index / ETF categories
    activeBand: 40,  // active funds
    isIndexCat: (cat) => /index|etf/i.test(cat || '') },
};

function pickBounds(cat) {
  const b = GATES.G3_RETURN_BOUNDS.bounds;
  for (const rule of b) { if (rule.fallback) return rule; if (rule.re.test(cat || '')) return rule; }
  return b[b.length - 1];
}

/* ------------------------------------------------------------------ *
 * Flag storage
 * ------------------------------------------------------------------ */

/** Auto-resolve prior open flags for the same scheme+field+gate on successful re-fetch. */
function autoResolve(schemeId, field, gate) {
  db.prepare(`UPDATE data_quality_flags SET status='auto_resolved', resolvedAt=datetime('now')
              WHERE schemeId=? AND field=? AND gate=? AND status='open'`).run(schemeId, field, gate);
}

function flag(schemeId, field, gate, rawValue, source, message) {
  // dedupe: don't stack identical open flags
  const dup = db.prepare(`SELECT id FROM data_quality_flags
    WHERE schemeId=? AND field=? AND gate=? AND status='open'`).get(schemeId, field, gate);
  if (dup) return;
  db.prepare(`INSERT INTO data_quality_flags (schemeId, field, gate, rawValue, source, message)
              VALUES (?,?,?,?,?,?)`).run(schemeId, field, gate, String(rawValue), source || null, message || null);
}

function clearManually(flagId) {
  db.prepare(`UPDATE data_quality_flags SET status='manually_cleared', resolvedAt=datetime('now') WHERE id=?`).run(flagId);
}

/** Scheme+field pairs currently flagged open — used to exclude from scoring. */
function openFlagMap() {
  const rows = db.prepare(`SELECT schemeId, field FROM data_quality_flags WHERE status='open'`).all();
  const m = {};
  for (const r of rows) { (m[r.schemeId] = m[r.schemeId] || {})[r.field] = true; }
  return m;
}

/* ------------------------------------------------------------------ *
 * Source logging + dual-source NAV
 * ------------------------------------------------------------------ */

function logSource(schemeId, field, source, ok, latencyMs) {
  db.prepare(`INSERT INTO source_log (schemeId, field, source, ok, latencyMs) VALUES (?,?,?,?,?)`)
    .run(schemeId, field, source, ok ? 1 : 0, latencyMs || null);
}

/**
 * Verify a scheme's latest NAV against AMFI NAVAll.txt (primary).
 * Accepts when the primary value matches the stored NAV within 0.5% (AMFI
 * publishes T-1 NAV during the day; a small drift vs mfapi's same value is
 * rounding). Returns {ok, source, message}.
 */
async function verifyNavCrossSource(schemeId, schemeCode, storedNav, storedDate, fetchImpl) {
  const _fetch = fetchImpl || global.fetch;
  // Primary: AMFI NAVAll.txt (single ~10MB file, cached per day)
  const amfi = await getAmfiNavAll(_fetch);
  if (amfi && amfi.byCode && schemeCode && amfi.byCode[schemeCode]) {
    const rec = amfi.byCode[schemeCode];
    logSource(schemeId, 'nav', 'amfi_navall', true, amfi.latencyMs);
    if (Math.abs(rec.nav - storedNav) / storedNav <= 0.005) {
      autoResolve(schemeId, 'nav', 'SRC');
      return { ok: true, source: 'amfi_navall' };
    }
    flag(schemeId, 'nav', 'SRC', storedNav, 'amfi_navall',
      `NAV mismatch: stored ${storedNav} (${storedDate}) vs AMFI ${rec.nav} (${rec.date})`);
    return { ok: false, source: 'amfi_navall', message: 'nav mismatch vs AMFI' };
  }
  // Fallback: mfapi.in latest point
  const t0 = Date.now();
  try {
    const r = await _fetch(`https://api.mfapi.in/mf/${schemeCode}`, { timeout: 8000 });
    const j = await r.json();
    logSource(schemeId, 'nav', 'mfapi', true, Date.now() - t0);
    const latest = j.data && j.data[0];
    if (latest && Math.abs(parseFloat(latest.nav) - storedNav) / storedNav <= 0.005) {
      autoResolve(schemeId, 'nav', 'SRC');
      return { ok: true, source: 'mfapi' };
    }
    flag(schemeId, 'nav', 'SRC', storedNav, 'mfapi', `NAV mismatch vs mfapi: ${latest ? latest.nav : 'none'}`);
    return { ok: false, source: 'mfapi', message: 'nav mismatch vs mfapi' };
  } catch (e) {
    logSource(schemeId, 'nav', 'mfapi', false, Date.now() - t0);
    // Both sources failed → mark unavailable, don't carry stale forward silently
    flag(schemeId, 'nav', 'SRC', storedNav, 'unavailable', 'primary and fallback sources failed: ' + e.message);
    return { ok: false, source: 'none', message: 'both sources unavailable' };
  }
}

let _navAllCache = null; // { day: 'YYYY-MM-DD', byCode: {code: {nav, date}}, latencyMs }
async function getAmfiNavAll(fetchImpl) {
  const _fetch = fetchImpl || global.fetch;
  const today = new Date().toISOString().slice(0, 10);
  if (_navAllCache && _navAllCache.day === today) return _navAllCache;
  const t0 = Date.now();
  try {
    const r = await _fetch('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 30000 });
    const txt = await r.text();
    const byCode = {};
    for (const line of txt.split('\n')) {
      // format: Scheme Code;ISIN Div Payout;ISIN Reinvestment;Scheme Name;Scheme Plan;Scheme Option;NAV;Date
      const p = line.split(';');
      if (p.length < 8) continue;
      const code = p[0].trim();
      const nav = parseFloat(p[6]);
      if (!code || !isFinite(nav)) continue;
      let d = p[7] ? p[7].trim() : '';
      const dm = d.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
      if (dm) {
        const mo = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' }[dm[2]];
        d = dm[3] + '-' + mo + '-' + dm[1].padStart(2, '0');
      }
      byCode[code] = { nav, date: d };
    }
    _navAllCache = { day: today, byCode, latencyMs: Date.now() - t0 };
    return _navAllCache;
  } catch (e) {
    logSource(null, 'nav', 'amfi_navall', false, Date.now() - t0);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Gate runner — call before writing returns/AUM into scoring tables
 * ------------------------------------------------------------------ */

/**
 * Validate a scheme's computed metrics. Any failure flags & returns false
 * for that field so the caller can exclude it from scoring.
 * metrics: { aumCr, returns: {1M,3M,6M,1Y,3Y,5Y}, aumBaseCr, aumChangePct,
 *            navDate, category, schemeCode, benchReturn1Y }
 */
function validateSchemeMetrics(schemeId, m) {
  const results = { valid: true, suppressed: {} };

  // G1 — AUM ceiling
  if (!GATES.G1_AUM_CEILING.test(m.aumCr)) {
    flag(schemeId, 'aum', 'G1', m.aumCr, m.source || null, GATES.G1_AUM_CEILING.msg(m.aumCr));
    results.valid = false; results.excludeAum = true;
  } else { autoResolve(schemeId, 'aum', 'G1'); }

  // G3 — 1Y return bounds by category
  const r1y = m.returns && m.returns['1Y'];
  if (!GATES.G3_RETURN_BOUNDS.test(r1y, m.category)) {
    flag(schemeId, 'return_1Y', 'G3', r1y, null, GATES.G3_RETURN_BOUNDS.msg(r1y, m.category));
    results.valid = false; results.excludeReturns = true;
  } else { autoResolve(schemeId, 'return_1Y', 'G3'); }

  // G4 — benchmark delta (index/ETF only when benchmark return known)
  if (m.benchReturn1Y != null && r1y != null && GATES.G4_BENCH_DELTA.isIndexCat(m.category)) {
    const band = GATES.G4_BENCH_DELTA.indexBand;
    if (Math.abs(r1y - m.benchReturn1Y) > band) {
      flag(schemeId, 'return_1Y', 'G4', r1y, null,
        `index/ETF 1Y return ${r1y}% vs benchmark ${m.benchReturn1Y}% delta ${Math.abs(r1y - m.benchReturn1Y).toFixed(1)}pp > ${band}pp`);
      results.valid = false; results.excludeReturns = true;
    } else { autoResolve(schemeId, 'return_1Y', 'G4'); }
  }

  // G5 — suppress % when base AUM tiny
  if (m.aumChangePct != null && !GATES.G5_AUM_PCT_SUPPRESS.test(m.aumBaseCr)) {
    results.suppressed.aumChangePct = true;   // caller stores absolute Cr, nulls the %
    flag(schemeId, 'aum_change_pct', 'G5', m.aumChangePct, null,
      `suppressed: base AUM ₹${m.aumBaseCr} Cr < ₹${GATES.G5_AUM_PCT_SUPPRESS.minBaseCr} Cr`);
  } else if (m.aumChangePct != null) { autoResolve(schemeId, 'aum_change_pct', 'G5'); }

  // G6 — cross-period consistency
  if (!GATES.G6_CROSS_PERIOD.test(m.returns && m.returns['1M'], r1y)) {
    flag(schemeId, 'return_1Y', 'G6', r1y, null, GATES.G6_CROSS_PERIOD.msg(m.returns['1M'], r1y));
    results.valid = false; results.excludeReturns = true;
  } else { autoResolve(schemeId, 'return_1Y', 'G6'); }

  // G7 — freshness
  if (m.navDate) {
    const ageDays = (Date.now() - new Date(m.navDate + 'T00:00:00').getTime()) / 86400000;
    if (ageDays > GATES.G7_FRESHNESS.cadenceDays.nav) {
      flag(schemeId, 'nav', 'G7', m.navDate, null, `NAV stale: ${Math.round(ageDays)}d old (cadence ${GATES.G7_FRESHNESS.cadenceDays.nav}d)`);
      results.staleNav = true;
    } else { autoResolve(schemeId, 'nav', 'G7'); }
  }

  return results;
}

/** Daily reconciliation: recompute stored returns from NAV blob, diff vs stored. */
function reconcileReturns(recomputeFn, tolerancePp) {
  const tol = tolerancePp == null ? 0.1 : tolerancePp;
  const schemes = db.prepare(`SELECT id, schemeCode FROM mutual_fund_schemes`).all();
  let drift = 0, recalced = 0, checked = 0;
  for (const s of schemes) {
    const stored = db.prepare(`SELECT period, value FROM mutual_fund_returns WHERE schemeId=?`).all(s.id);
    if (!stored.length) continue;
    const fresh = recomputeFn(s.id);           // map period -> pct
    if (!fresh) continue;
    checked++;
    for (const row of stored) {
      const f = fresh[row.period];
      if (f == null) continue;
      if (Math.abs(f - row.value) > tol) {
        drift++;
        // recalculation, not silent overwrite — recompute pipeline owns the write
        flag(s.id, 'return_' + row.period, 'RECON', row.value, null,
          `drift ${row.value}% → ${f}% exceeds ${tol}pp; queued for recalculation`);
      }
    }
  }
  if (drift) { try { recomputeFn('__recalc_all__'); recalced = 1; } catch (e) {} }
  return { checked, drift, recalced };
}

/** Monthly AMC-level AAUM cross-check. Returns discrepancy list; logs, does not overwrite. */
function crossCheckAumVsAmfi(amcAumMap) {
  // amcAumMap: { amcName: totalAaumCr } from AMFI monthly AAUM report
  const rows = db.prepare(`SELECT s.amc, SUM(a.aum) tot FROM mutual_fund_schemes s
    JOIN mutual_fund_aum a ON a.schemeId = s.id
    WHERE a.aum IS NOT NULL GROUP BY s.amc`).all();
  const out = [];
  for (const r of rows) {
    const amfi = amcAumMap[r.amc];
    if (amfi == null) continue;
    if (r.tot > amfi * 1.10) {   // >10% over AMFI's total = discrepancy
      flag(null, 'aum', 'G2', r.tot, 'amfi_aaum',
        `AMC "${r.amc}" scheme AUM sum ₹${Math.round(r.tot)} Cr > AMFI AAUM ₹${Math.round(amfi)} Cr`);
      out.push({ amc: r.amc, ours: Math.round(r.tot), amfi: Math.round(amfi) });
    }
  }
  return out;
}

module.exports = {
  init, flag, autoResolve, clearManually, openFlagMap,
  validateSchemeMetrics, verifyNavCrossSource, getAmfiNavAll,
  reconcileReturns, crossCheckAumVsAmfi, logSource, GATES,
};

/**
 * common/market/zones.js — Phase 1: Support Zone Detection
 *
 * Task 1.1  Zone clustering   — group pivot lows within a lookback window into
 *             zones where each pivot sits within ±0.5–1×ATR of the zone median.
 * Task 1.2  Touch validation  — a touch counts only if price closed back above
 *             the zone high within 1–3 bars of the touch, by ≥1×ATR.
 * Task 1.3  Invalidation      — reject zones where price closed and stayed
 *             below the zone low for ≥2 consecutive bars after formation
 *             (status: 'broken').
 * Task 1.4  Quality gate      — only zones with valid_touch_count >= 3 pass;
 *             the rest are returned in rejected_zones.
 *
 * Usage:
 *   const { detectSupportZones } = require('./common/market/zones');
 *   const { zones, rejected_zones } = detectSupportZones(candles, {
 *     atrPeriod: 14, pivotLeft: 3, pivotRight: 3,
 *     lookback: 75, zoneAtrMult: 0.75, minValidTouches: 3,
 *   });
 *
 * candles: [[date, open, high, low, close, volume], ...] (same format as data/ohlcv)
 */

const DEFAULTS = {
  atrPeriod: 14,   // ATR length for all ATR-relative thresholds
  pivotLeft: 3,    // bars to the left for pivot-low detection
  pivotRight: 3,   // bars to the right for pivot-low detection
  lookback: 75,    // zone lookback window in bars (spec: 60–90)
  zoneAtrMult: 0.75, // ± ATR multiple a pivot may sit from zone median (spec: 0.5–1)
  minValidTouches: 3, // Task 1.4 quality gate
  bounceBars: 3,   // Task 1.2: close back above zone high within N bars (spec: 1–3)
  bounceAtrMult: 1.0, // Task 1.2: by at least this × ATR above zone high
  breakBars: 2,    // Task 1.3: consecutive closes below zone low that break it
};

// ---------- indicators ----------
function atrSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  out[period] = s / period;
  for (let i = period + 1; i < n; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/**
 * Pivot lows: bar i is a pivot if low[i] is the strict minimum of the
 * window [i-left, i+right]. Returns array of { index, low }.
 */
function pivotLows(candles, left, right) {
  const n = candles.length;
  const pivots = [];
  for (let i = left; i < n - right; i++) {
    const lo = candles[i][3];
    let isPivot = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k !== i && candles[k][3] < lo) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, low: lo });
  }
  return pivots;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- Task 1.1: clustering ----------
/**
 * Greedily cluster pivots (oldest → newest) into zones. A pivot joins the
 * first zone whose median price is within zoneAtrMult×ATR of the pivot low;
 * otherwise it opens a new zone. Zone bounds = min/max of member pivot lows.
 */
function clusterZones(pivots, candles, atrs, opts) {
  const zones = [];
  for (const p of pivots) {
    const atr = atrs[p.index];
    if (atr == null || atr <= 0) continue;
    let placed = false;
    for (const z of zones) {
      const med = median(z.pivotLows);
      if (Math.abs(p.low - med) <= opts.zoneAtrMult * atr) {
        z.pivotLows.push(p.low);
        z.touch_indices.push(p.index);
        z.price_low = Math.min(z.price_low, p.low);
        z.price_high = Math.max(z.price_high, p.low);
        z.formed_at = Math.min(z.formed_at, p.index);
        z.last_touch = Math.max(z.last_touch, p.index);
        placed = true;
        break;
      }
    }
    if (!placed) {
      zones.push({
        pivotLows: [p.low],
        touch_indices: [p.index],
        price_low: p.low,
        price_high: p.low,
        formed_at: p.index,
        last_touch: p.index,
      });
    }
  }
  return zones;
}

// ---------- Task 1.2: touch validation ----------
/**
 * A touch is VALID if within bounceBars bars after the pivot bar, price
 * closes at or above zone_high + bounceAtrMult×ATR(touch bar).
 */
function validateTouches(zone, candles, atrs, opts) {
  const valid = [];
  for (const t of zone.touch_indices) {
    const atr = atrs[t];
    if (atr == null || atr <= 0) continue;
    const threshold = zone.price_high + opts.bounceAtrMult * atr;
    let ok = false;
    for (let k = t + 1; k <= Math.min(t + opts.bounceBars, candles.length - 1); k++) {
      if (candles[k][4] >= threshold) { ok = true; break; } // close
    }
    if (ok) valid.push(t);
  }
  return valid;
}

// ---------- Task 1.3: invalidation ----------
/**
 * Zone is 'broken' if at any point after it formed, price CLOSES below the
 * zone low for breakBars consecutive bars — evaluated CHRONOLOGICALLY against
 * the running zone low (the min of pivot lows seen so far). This prevents
 * breaking bars from being absorbed into the zone and masking the break.
 */
function checkBroken(zone, candles, opts) {
  const pivots = [...zone.touch_indices].sort((a, b) => a - b);
  let runningLow = Infinity;
  let nextPivot = 0;
  let consecutive = 0;
  for (let i = pivots[0]; i < candles.length; i++) {
    // incorporate pivots confirmed by bar i (need pivotRight bars after them)
    while (nextPivot < pivots.length && pivots[nextPivot] + opts.pivotRight <= i) {
      runningLow = Math.min(runningLow, candles[pivots[nextPivot]][3]);
      nextPivot++;
      consecutive = 0; // a fresh touch resets the break count
    }
    if (runningLow < Infinity && candles[i][4] < runningLow) {
      consecutive++;
      if (consecutive >= opts.breakBars) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

// ---------- main ----------
function detectSupportZones(candles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  if (!Array.isArray(candles) || candles.length < opts.lookback + opts.pivotRight + 1) {
    return { zones: [], rejected_zones: [], pivots: [] };
  }

  const atrs = atrSeries(candles, opts.atrPeriod);

  // Only consider pivots inside the lookback window (last `lookback` bars).
  // Pivot indices are shifted into window coordinates so early window bars
  // still have valid ATR (computed over full history, not the window alone).
  const windowStart = candles.length - opts.lookback;
  const allPivots = pivotLows(candles, opts.pivotLeft, opts.pivotRight);
  const pivots = allPivots.filter(p => p.index >= windowStart).map(p => ({ index: p.index, low: p.low }));

  // Task 1.1 — cluster (ATR is looked up at the pivot's absolute index)
  const rawZones = clusterZones(pivots, candles, atrs, opts);

  const zones = [];
  const rejected_zones = [];

  for (const z of rawZones) {
    const zone = {
      price_low: +z.price_low.toFixed(2),
      price_high: +z.price_high.toFixed(2),
      touch_count: z.touch_indices.length,          // raw touch count
      touch_indices: z.touch_indices,
      valid_touch_indices: [],
      valid_touch_count: 0,
      formed_at_bar: z.formed_at,
      formed_at_date: candles[z.formed_at][0],
      last_touch_bar: z.last_touch,
      last_touch_date: candles[z.last_touch][0],
      status: 'active',
      reject_reason: null,
    };

    // Task 1.3 — invalidation first (a broken zone is useless however many touches)
    if (checkBroken(z, candles, opts)) {
      zone.status = 'broken';
      zone.reject_reason = 'price closed below zone low for ' + opts.breakBars + '+ consecutive bars';
      rejected_zones.push(zone);
      continue;
    }

    // Task 1.2 — touch validation
    zone.valid_touch_indices = validateTouches(z, candles, atrs, opts);
    zone.valid_touch_count = zone.valid_touch_indices.length;

    // Task 1.4 — quality gate
    if (zone.valid_touch_count >= opts.minValidTouches) {
      zones.push(zone);
    } else {
      zone.status = 'rejected';
      zone.reject_reason = 'valid_touch_count ' + zone.valid_touch_count + ' < ' + opts.minValidTouches;
      rejected_zones.push(zone);
    }
  }

  zones.sort((a, b) => b.valid_touch_count - a.valid_touch_count || b.price_low - a.price_low);
  return { zones, rejected_zones, pivots };
}

module.exports = { detectSupportZones, pivotLows, atrSeries, DEFAULTS };

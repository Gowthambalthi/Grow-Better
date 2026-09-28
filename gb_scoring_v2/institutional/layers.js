/**
 * gb_scoring_v2/institutional/layers.js — THE LAYERS PROP DESKS ACTUALLY USE.
 *
 * WHY THIS EXISTS. The engine we have ranks on ROC — sub-minute and 1-5-15 minute rate-of-change —
 * and ROC answers "what just moved". Size does not trade that question. It trades three others,
 * and none of them is a momentum indicator:
 *
 *   1. IS TODAY BALANCED OR TRENDING? (Market Profile / TPO.) A session that is building a
 *      balanced range rewards fading its extremes; a session whose value is MIGRATING rewards
 *      following breakouts. This single read decides which of two opposite strategies is correct
 *      for the next six hours, and every retail stack — ours included — treats every day the same
 *      way, which means it is systematically wrong on one of the two kinds of day.
 *   2. IS THIS NAME MOVING MORE THAN THE MARKET? (Relative strength, not absolute.) Institutional
 *      flow rotates by sector and theme, so a name's return MINUS the index's return is the order
 *      flow's fingerprint in the price series. "It went up 2%" says nothing; "it went up 2% while
 *      NIFTY went up 0.2%" is a different stock.
 *   3. WHERE AM I RELATIVE TO YESTERDAY? Prior day high/low/close and prior value area are the
 *      reference frame everyone else is using, which is what makes them decision points rather
 *      than lines.
 *
 * And one thing about WHEN: institutional participation is not uniform through the day. The first
 * hour and the last hour carry real intent; midday is two-way noise. A signal at 11:45 is not the
 * same signal as the same setup at 09:20, and a system that weights them equally is misfiring half
 * its life. The weights in TOD below are MEASURED off this repo's own 1-minute tape rather than
 * assumed (see gb_scoring_v2/institutional/backtest.js), so the time-of-day adjustment is a
 * finding, not an opinion.
 *
 * WHAT IS DELIBERATELY NOT HERE. Iceberg detection and true absorption need trade-by-trade prints
 * and the full order book. This feed is Angel's QUOTE mode: best bid/ask QUANTITY and running
 * total-buy/total-sell quantity, with no per-print size and no book depth beyond the touch. That is
 * enough to see a LEVEL being repeatedly replenished and enough to see size trading without price
 * progress, and the order-flow engine already computes that absorption (orderflow/footprint.js). It
 * is NOT enough to say "there is a hidden 200,000-share order at 1,447.30". Rather than approximate
 * it and call it iceberg detection, this module reads what the tape can actually support and labels
 * the rest as unmeasured.
 *
 * EVERY FUNCTION IS PURE AND TAKES ITS BARS EXPLICITLY. Nothing here reads the clock or a file.
 */

const SESSION_OPEN_MIN = 9 * 60 + 15;      // 09:15
const SESSION_CLOSE_MIN = 15 * 60 + 30;    // 15:30
const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;   // 375

/** minsOf(stamp) — "YYYY-MM-DD HH:mm" -> { day, mins }, or null. */
function minsOf(stamp) {
  const s = String(stamp == null ? '' : stamp);
  if (s.length < 16) return null;
  const hh = Number(s.slice(11, 13));
  const mm = Number(s.slice(14, 16));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return { day: s.slice(0, 10), mins: hh * 60 + mm };
}

/**
 * toRows(bars) — the raw [stamp,o,h,l,c,v] rows into the shape this module works in.
 * Bars that cannot be used are DROPPED (never zero-filled): a fabricated bar is a fabricated
 * profile, and the profile is the input to every level below it.
 */
function toRows(bars) {
  const out = [];
  for (const b of bars || []) {
    const t = minsOf(b[0]);
    if (!t) continue;
    const [o, h, l, c, v] = [b[1], b[2], b[3], b[4], b[5]];
    if (![o, h, l, c, v].every(x => typeof x === 'number' && isFinite(x))) continue;
    if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    out.push({ day: t.day, mins: t.mins, o, h, l, c, v: v || 0, typical: (h + l + c) / 3 });
  }
  out.sort((a, b) => a.mins - b.mins);
  return out;
}

/** sessionsOf(bars) — bars grouped by session, each group in time order. */
function sessionsOf(bars) {
  const map = new Map();
  for (const r of toRows(bars)) {
    let arr = map.get(r.day);
    if (!arr) { arr = []; map.set(r.day, arr); }
    arr.push(r);
  }
  for (const arr of map.values()) arr.sort((a, b) => a.mins - b.mins);
  return map;
}

// ---------------------------------------------------------------------------
// 1. VOLUME PROFILE — the shape of the session, not just its point of control
// ---------------------------------------------------------------------------

/**
 * volumeProfile(rows, opts) — a volume-at-price profile with a 70% value area.
 *
 * The value area is grown from the POC outward one bin at a time, always taking the side with more
 * volume, which is the standard TPO construction. `binCount` is a resolution choice and is
 * DECLARED: too few bins and the POC is an artefact of one outlier print, too many and the profile
 * is noise with a peak in it.
 */
function volumeProfile(rows, opts = {}) {
  const binCount = Math.max(8, opts.binCount || 40);
  if (!rows || rows.length < 10) return null;
  let hi = -Infinity, lo = Infinity, total = 0;
  for (const r of rows) { if (r.h > hi) hi = r.h; if (r.l < lo) lo = r.l; total += r.v; }
  if (!(hi > lo) || total <= 0) return null;
  const binSize = (hi - lo) / binCount;
  const bins = new Array(binCount).fill(0);
  for (const r of rows) {
    if (r.v <= 0) continue;
    const a = Math.min(binCount - 1, Math.max(0, Math.floor((r.l - lo) / binSize)));
    const b = Math.min(binCount - 1, Math.max(0, Math.floor((r.h - lo) / binSize)));
    // THE WHOLE BAR'S VOLUME IS SPREAD ACROSS THE BINS IT TOUCHED, not dumped on one. A one-minute
    // bar that ranges across four bins really did trade in all four, and assigning it all to the
    // open (or to the typical price) manufactures a peak at a price that may not have traded.
    const span = b - a + 1;
    for (let i = a; i <= b; i++) bins[i] += r.v / span;
  }
  // THE POC IS NOT ALWAYS ONE BIN, and taking the argmax is wrong in a way that matters here.
  // A session whose volume is spread evenly across a price band has SEVERAL bins within noise of
  // the peak, and `indexOf(max)` picks the FIRST of them — which biases the POC to the bottom of
  // the band. On a trend day that bias is systematic: it drags the control back toward the middle
  // of the range, the shape read then sees a POC that never moved, and a trend session is reported
  // as BALANCE. That is precisely the mistake this module exists to prevent (it inverts the
  // fade-vs-follow decision), so the peak is taken as the CENTRE of the tied group — the "double
  // distribution" convention. It is symmetric and does not depend on which end of a plateau the
  // scan happens to reach first.
  let peak = 0;
  for (let i = 1; i < binCount; i++) if (bins[i] > bins[peak]) peak = i;
  const tieTol = opts.pocTieTol == null ? 0.02 : opts.pocTieTol;
  const tied = [];
  for (let i = 0; i < binCount; i++) if (bins[i] >= bins[peak] * (1 - tieTol)) tied.push(i);
  const pocIdx = tied.length ? tied[Math.floor((tied.length - 1) / 2)] : peak;
  const target = total * 0.70;
  let loIdx = pocIdx, hiIdx = pocIdx, acc = bins[pocIdx];
  while (acc < target && (loIdx > 0 || hiIdx < binCount - 1)) {
    const down = loIdx > 0 ? bins[loIdx - 1] : -1;
    const up = hiIdx < binCount - 1 ? bins[hiIdx + 1] : -1;
    if (up >= down) { hiIdx++; acc += Math.max(0, up); } else { loIdx--; acc += Math.max(0, down); }
  }
  const at = (i) => lo + (i + 0.5) * binSize;
  return {
    lo, hi, binSize, bins, total, binCount,
    poc: +at(pocIdx).toFixed(4),
    val: +at(loIdx).toFixed(4),
    vah: +at(hiIdx).toFixed(4),
    pocIdx, loIdx, hiIdx,
    // how many bins were within the tie tolerance of the peak: 1 means a single clean control,
    // many means a flat/plateaued profile whose "POC" is a band rather than a price. Reported
    // because a read that rests on a band should be able to say so.
    pocTiedBins: tied.length,
    valueAreaPct: +((acc / total) * 100).toFixed(2),
  };
}

/**
 * profileShape(rows, opts) — balanced rotation or value migration, and how confidently.
 *
 * `oneSidedness`  share of volume in the outer thirds of the range. A trend day puts its business
 *                 at one end; a balanced day puts it in the middle.
 * `pocPos`        where the POC sits in the range, 0 = at the low, 1 = at the high.
 * `migrationPct`  how far the POC MOVED between the first and last third of the session, as a
 *                 fraction of the range. Rotation leaves the POC where it was; a trend drags it.
 * `mode`          TREND_UP / TREND_DOWN / BALANCE, with `direction` +1/-1/0.
 *
 * The three reads are deliberately different questions, and the mode requires them to AGREE:
 * one-sided volume with a migrating POC is a trend; one-sided volume with a stationary POC is a
 * session pinned at an extreme (a gap day), which is not the same trade.
 */
function profileShape(rows, opts = {}) {
  const prof = volumeProfile(rows, opts);
  if (!prof || rows.length < 30) return null;
  const range = prof.hi - prof.lo;
  if (!(range > 0)) return null;

  // outer thirds
  const third = prof.binCount / 3;
  let lowVol = 0, midVol = 0, highVol = 0;
  for (let i = 0; i < prof.binCount; i++) {
    if (i < third) lowVol += prof.bins[i];
    else if (i >= prof.binCount - third) highVol += prof.bins[i];
    else midVol += prof.bins[i];
  }
  const oneSidedness = prof.total > 0 ? Math.max(lowVol, highVol) / prof.total : 0;
  const lean = lowVol > highVol ? -1 : 1;
  const pocPos = (prof.poc - prof.lo) / range;

  // POC migration: first third of the session vs last third
  const cut = Math.max(5, Math.floor(rows.length / 3));
  const p1 = volumeProfile(rows.slice(0, cut), opts);
  const p3 = volumeProfile(rows.slice(rows.length - cut), opts);
  const migrationPct = (p1 && p3 && range > 0) ? (p3.poc - p1.poc) / range : 0;

  let mode = 'BALANCE', direction = 0;
  const trendish = Math.abs(migrationPct) >= (opts.minMigrationPct || 0.25)
    && Math.abs(pocPos - 0.5) * 2 >= (opts.minPocOffset || 0.3);
  if (trendish) {
    direction = migrationPct > 0 ? 1 : -1;
    // The POC's own side must AGREE with the direction of travel. A POC migrating up while sitting
    // in the low third is a session that is still finding value downstairs, not a trend.
    const agrees = (direction > 0 && pocPos > 0.5) || (direction < 0 && pocPos < 0.5);
    mode = agrees ? (direction > 0 ? 'TREND_UP' : 'TREND_DOWN') : 'BALANCE';
    if (!agrees) direction = 0;
  }

  // 0..100 — how strongly the three reads agree, not a probability
  const score = Math.min(100, Math.round(100 * (
    0.45 * Math.min(1, Math.abs(migrationPct) / 0.5)
    + 0.30 * Math.min(1, oneSidedness / 0.6)
    + 0.25 * Math.min(1, Math.abs(pocPos - 0.5) * 2)
  )));

  return {
    mode, direction, score,
    poc: prof.poc, vah: prof.vah, val: prof.val, lo: prof.lo, hi: prof.hi,
    vaWidthPct: +(((prof.vah - prof.val) / prof.poc) * 100).toFixed(4),
    pocPos: +pocPos.toFixed(3),
    oneSidedness: +oneSidedness.toFixed(3),
    lean,
    migrationPct: +migrationPct.toFixed(3),
    profile: prof,
  };
}

// ---------------------------------------------------------------------------
// 2. THE REFERENCE FRAME — prior day levels and the opening range
// ---------------------------------------------------------------------------

/** priorLevels(prevRows) — yesterday's frame, which is what everyone else is trading against. */
function priorLevels(prevRows) {
  if (!prevRows || prevRows.length < 10) return null;
  let hi = -Infinity, lo = Infinity;
  for (const r of prevRows) { if (r.h > hi) hi = r.h; if (r.l < lo) lo = r.l; }
  const prof = volumeProfile(prevRows);
  return {
    pdh: hi, pdl: lo, pdc: prevRows[prevRows.length - 1].c,
    poc: prof ? prof.poc : null, vah: prof ? prof.vah : null, val: prof ? prof.val : null,
    rangePct: +(((hi - lo) / ((hi + lo) / 2)) * 100).toFixed(4),
  };
}

/**
 * openingRange(rows, minutes) — the first N minutes, and whether it held.
 * The opening range is a real reference frame (it is the first price discovery of the session and
 * the first place stops accumulate), which is why it matters whether price is ACCEPTED outside it
 * or merely pokes through. `accepted` requires closes beyond the edge, not touches.
 */
function openingRange(rows, minutes = 30) {
  const end = SESSION_OPEN_MIN + minutes;
  const or = [];
  for (const r of rows) { if (r.mins < end) or.push(r); else break; }
  if (or.length < 5) return null;
  let hi = -Infinity, lo = Infinity;
  for (const r of or) { if (r.h > hi) hi = r.h; if (r.l < lo) lo = r.l; }
  const after = rows.filter(r => r.mins >= end);
  let brokeUp = false, brokeDown = false, acceptedUp = 0, acceptedDown = 0;
  for (const r of after) {
    if (r.c > hi) { brokeUp = true; acceptedUp++; } else acceptedUp = 0;
    if (r.c < lo) { brokeDown = true; acceptedDown++; } else acceptedDown = 0;
  }
  const mid = (hi + lo) / 2;
  return {
    minutes, hi, lo, mid,
    widthPct: mid > 0 ? +(((hi - lo) / mid) * 100).toFixed(4) : null,
    brokeUp, brokeDown,
    acceptedUp: acceptedUp >= 2, acceptedDown: acceptedDown >= 2,
    // A single close beyond the edge that immediately came back is a SWEEP, not a breakout — the
    // distinction the stop-run read depends on.
    sweepUp: brokeUp && !acceptedUp,
    sweepDown: brokeDown && !acceptedDown,
  };
}

/**
 * levelContext(rows, levels, or, opts) — where price is in the frame, and what it just did there.
 * Returns the location read (which strategy family is even plausible) and the two tape events that
 * matter at a level: ACCEPTANCE (closes beyond it, held) and a SWEEP (pierced and reclaimed).
 */
function levelContext(rows, levels, or, opts = {}) {
  if (!rows || !rows.length) return null;
  const last = rows[rows.length - 1].c;
  const out = { last, vsValue: null, vsPoc: null, vsOr: null, abovePdh: null, belowPdl: null, sweep: null, acceptance: null };
  if (levels) {
    if (levels.vah != null && levels.val != null) {
      out.vsValue = last > levels.vah ? 'above' : last < levels.val ? 'below' : 'inside';
    }
    if (levels.poc != null) out.vsPoc = last > levels.poc ? 'above' : 'below';
    out.abovePdh = last > levels.pdh;
    out.belowPdl = last < levels.pdl;
  }
  if (or) {
    out.vsOr = last > or.hi ? 'above' : last < or.lo ? 'below' : 'inside';
    if (or.sweepUp) out.sweep = 'UP';
    else if (or.sweepDown) out.sweep = 'DOWN';
    else if (or.acceptedUp) out.acceptance = 'UP';
    else if (or.acceptedDown) out.acceptance = 'DOWN';
  }
  // A sweep of the PRIOR DAY extreme is the classic liquidity grab: it needs both the pierce and
  // the reclaim, which is why it is read from the closes rather than from the wick.
  const probe = opts.probeBars || 60;
  const tail = rows.slice(-probe);
  if (levels) {
    const piercedAbove = tail.some(r => r.h > levels.pdh);
    const backInside = last < levels.pdh;
    const piercedBelow = tail.some(r => r.l < levels.pdl);
    if (piercedAbove && backInside) out.sweep = out.sweep || 'PDH';
    if (piercedBelow && last > levels.pdl) out.sweep = out.sweep || 'PDL';
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. RELATIVE STRENGTH — return MINUS the market, which is the rotation fingerprint
// ---------------------------------------------------------------------------

/**
 * relativeStrength(symRetPct, niftyRetPct, beta) — how much of this name's move is its own.
 * Beta defaults to 1 and is DECLARED rather than estimated from 20 minutes of tape (a beta fitted
 * on one session is noise wearing a coefficient); when a real beta is available it belongs here.
 * `excess` is the plain difference, which is what a desk means by relative strength.
 */
function relativeStrength(symRetPct, niftyRetPct, beta = 1) {
  if (symRetPct == null || niftyRetPct == null) return null;
  const expected = niftyRetPct * beta;
  const excess = symRetPct - expected;
  return {
    symRetPct: +symRetPct.toFixed(4),
    niftyRetPct: +niftyRetPct.toFixed(4),
    beta,
    expectedPct: +expected.toFixed(4),
    excess: +excess.toFixed(4),
    // A name that moved with the index has NO rotation signal regardless of how far it went.
    strength: excess > 0.35 ? 'LEADING' : excess < -0.35 ? 'LAGGING' : 'INLINE',
  };
}

// ---------------------------------------------------------------------------
// 4. TIME OF DAY — measured weights, not assumed ones
// ---------------------------------------------------------------------------

/**
 * TOD_WEIGHTS_BY_BUCKET — the share of a session's total range that BEGINS in each 30-minute
 * bucket, measured over this repo's own 1-minute tape (data/ohlcv_1m, 21 sessions, ~900 names).
 * Index 0 is 09:15-09:45.
 *
 * These are DECLARED measurements, not a model: they say where the day's travel starts, which is
 * the same question as "when does participation show up". They are used as a MULTIPLIER on
 * confidence, never as a reason to trade, and `measureTodWeights()` below recomputes them from the
 * tape so they cannot drift into folklore.
 */
const TOD_WEIGHTS_BY_BUCKET = [
  // MEASURED, not assumed: these are the median share of a session's total range that still lies
  // ahead of each 30-minute bucket, normalised to the first bucket, over 995 NSE names x 20,396
  // sessions of this repo's own 1-minute tape (gb_scoring_v2/institutional/backtest.js, 2026-09).
  // They decay monotonically from 1.00 at 09:15 to 0.22 at 15:15 — so a signal at midday carries
  // roughly half the runway of the same signal at the open, and the last half hour carries a fifth.
  1.00, 0.837, 0.750, 0.687, 0.637, 0.589, 0.547, 0.505, 0.465, 0.421, 0.373, 0.322, 0.224,
];

/** bucketOf(mins) — which 30-minute bucket a minute-of-day falls in (clamped into the session). */
function bucketOf(mins) {
  const m = Math.max(SESSION_OPEN_MIN, Math.min(SESSION_CLOSE_MIN - 1, mins));
  return Math.min(12, Math.floor((m - SESSION_OPEN_MIN) / 30));
}

/** todWeight(mins, table) — the participation weight at a minute of the session, 0..1. */
function todWeight(mins, table = TOD_WEIGHTS_BY_BUCKET) {
  const w = table[bucketOf(mins)];
  return w == null ? 1 : w;
}

/**
 * measureTodWeights(sessions, opts) — recompute the weights from the tape.
 *
 * For every (session, bucket) it measures the range still AVAILABLE from that bucket's start, as a
 * fraction of the session's total range, then takes the median over sessions. This is the empirical
 * version of "the first hour carries more intent", and it is the number the multiplier above should
 * be replaced with whenever the tape is re-measured.
 */
function measureTodWeights(sessions, opts = {}) {
  const buckets = 13;
  const cols = [];
  for (let i = 0; i < buckets; i++) cols.push([]);
  for (const rows of sessions) {
    if (!rows || rows.length < 60) continue;
    let hi = -Infinity, lo = Infinity;
    for (const r of rows) { if (r.h > hi) hi = r.h; if (r.l < lo) lo = r.l; }
    const totalRange = hi - lo;
    if (!(totalRange > 0)) continue;
    for (let i = 0; i < buckets; i++) {
      const startMin = SESSION_OPEN_MIN + i * 30;
      let idx = -1;
      for (let j = 0; j < rows.length; j++) { if (rows[j].mins >= startMin) { idx = j; break; } }
      if (idx < 0) continue;
      const entry = rows[idx].o;
      if (!(entry > 0)) continue;
      let h2 = -Infinity, l2 = Infinity;
      for (let j = idx; j < rows.length; j++) { if (rows[j].h > h2) h2 = rows[j].h; if (rows[j].l < l2) l2 = rows[j].l; }
      cols[i].push((h2 - l2) / totalRange);
    }
  }
  const median = (arr) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const raw = cols.map(c => median(c));
  const first = raw[0] || 1;
  return raw.map(v => (v == null ? null : +(v / first).toFixed(3)));
}

// ---------------------------------------------------------------------------
// 5. THE COMPOSITE — one read per company, which is what a single table row needs
// ---------------------------------------------------------------------------

/**
 * readInstitutional({ rows, sessionRows, priorRows, niftyRows, niftyPriorRows }, opts) — every
 * layer evaluated for ONE name at ONE moment, plus a single 0..100 `confidence`.
 *
 * The composite is a SUM OF AGREEMENTS, not a weighted average of opinions. Each layer reports a
 * direction (+1/-1/0) and a strength; the confidence rises when the layers agree and stays flat when
 * they do not — there is no compensation, because "very strong trend read" and "very strong
 * mean-reversion read" is not a medium signal, it is a contradiction, and averaging it into the
 * middle is how a stack of layers ends up with no opinion at all.
 */
function readInstitutional(input = {}, opts = {}) {
  const rows = input.rows || [];
  if (rows.length < 30) return null;
  const or = openingRange(rows, opts.orMinutes || 30);
  const levels = input.priorRows && input.priorRows.length ? priorLevels(input.priorRows) : null;
  const shape = profileShape(rows, opts);
  const ctx = levelContext(rows, levels, or, opts);

  const firstOpen = rows[0].o;
  const last = rows[rows.length - 1].c;
  const retPct = firstOpen > 0 ? ((last - firstOpen) / firstOpen) * 100 : null;
  let niftyRetPct = null;
  if (input.niftyRows && input.niftyRows.length) {
    const n0 = input.niftyRows[0].o;
    if (n0 > 0) niftyRetPct = ((input.niftyRows[input.niftyRows.length - 1].c - n0) / n0) * 100;
  }
  const rs = relativeStrength(retPct, niftyRetPct, opts.beta == null ? 1 : opts.beta);

  const parts = [];
  // The profile decides WHICH strategy family this session belongs to.
  if (shape) {
    parts.push({
      layer: 'profile', direction: shape.direction, strength: shape.score,
      why: shape.mode + ' (POC migration ' + shape.migrationPct + ', one-sided ' + shape.oneSidedness
        + ', POC at ' + shape.pocPos + ' of range)',
    });
    // A BALANCED session is a FADE session: its extremes are the trade, so the direction is toward
    // the value area, i.e. opposite wherever price currently sits relative to the POC.
    if (shape.mode === 'BALANCE' && levels) {
      const pos = ctx && ctx.vsPoc ? ctx.vsPoc : null;
      if (pos) parts.push({ layer: 'rotation', direction: pos === 'above' ? -1 : 1, strength: 45, why: 'balanced: rotation back toward value' });
    }
  }
  if (rs) {
    parts.push({
      layer: 'relativeStrength', direction: rs.strength === 'LEADING' ? 1 : rs.strength === 'LAGGING' ? -1 : 0,
      strength: Math.min(90, Math.abs(rs.excess) * 60), why: 'excess ' + rs.excess + '% vs NIFTY',
    });
  }
  if (ctx) {
    if (ctx.acceptance === 'UP') parts.push({ layer: 'acceptance', direction: 1, strength: 55, why: 'accepted above the opening range' });
    if (ctx.acceptance === 'DOWN') parts.push({ layer: 'acceptance', direction: -1, strength: 55, why: 'accepted below the opening range' });
    if (ctx.sweep) parts.push({ layer: 'sweep', direction: 0, strength: 35, why: 'liquidity sweep at ' + ctx.sweep + ' — a grab, not a breakout' });
  }

  const agreeing = parts.filter(p => p.direction !== 0);
  const net = agreeing.reduce((a, p) => a + p.direction * p.strength, 0);
  const gross = agreeing.reduce((a, p) => a + p.strength, 0) || 1;
  const agreement = Math.abs(net) / gross;                     // 0..1, how one-sided the evidence is
  const support = Math.min(1, agreeing.length / 3);            // 0..1, how much evidence there is
  const tod = todWeight(rows[rows.length - 1].mins, opts.todWeights || TOD_WEIGHTS_BY_BUCKET);
  const confidence = Math.round(100 * agreement * support * tod);

  return {
    last, retPct: retPct == null ? null : +retPct.toFixed(3),
    niftyRetPct: niftyRetPct == null ? null : +niftyRetPct.toFixed(3),
    relativeStrength: rs,
    profile: shape ? { mode: shape.mode, direction: shape.direction, score: shape.score, poc: shape.poc, vah: shape.vah, val: shape.val, migrationPct: shape.migrationPct, pocPos: shape.pocPos, oneSidedness: shape.oneSidedness } : null,
    levels,
    openingRange: or,
    context: ctx,
    todWeight: tod,
    bucket: bucketOf(rows[rows.length - 1].mins),
    parts,
    agreement: +agreement.toFixed(3),
    support: +support.toFixed(3),
    confidence,
    // The side the evidence leans to, WITH the reason it is only a lean. 0 direction = NO TRADE,
    // and that is a result, not a failure: a stack whose evidence contradicts itself has no edge to
    // express, and saying so is the only honest output.
    lean: net > 0 ? 1 : net < 0 ? -1 : 0,
    leanReason: agreeing.length ? (agreement >= (opts.minAgreement || 0.5) ? null : 'evidence disagrees (agreement ' + (+agreement.toFixed(2)) + ')') : 'no layer had an opinion',
  };
}

module.exports = {
  SESSION_OPEN_MIN, SESSION_CLOSE_MIN, SESSION_MINUTES,
  TOD_WEIGHTS_BY_BUCKET,
  minsOf, toRows, sessionsOf,
  volumeProfile, profileShape, priorLevels, openingRange, levelContext,
  relativeStrength, bucketOf, todWeight, measureTodWeights,
  readInstitutional,
};

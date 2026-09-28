/**
 * gb_scoring_v2/orderflow/history.js — HISTORY FOR THE FOOTPRINT.
 *
 * The question this answers is "at what price did it go up, and can you tell me that for a day
 * that already finished" — the same ladder and delta the live gate reads, rebuilt from the tape
 * that tickCapture wrote to disk.
 *
 * WHY IT REUSES footprint.js RATHER THAN REBUILDING THE MATH. A reader with its own classifier
 * would be a second engine: the live bar and the historical bar for the same minute could disagree,
 * and the disagreement would be unfalsifiable because both would look authoritative. So the
 * aggressor side comes from footprint.classify, the bucket width from footprint.bucketStep and the
 * bucket key from footprint.bucketOf — the exact functions the gate ran. `rebuild()` is a REPLAY of
 * classification, not a re-implementation of it.
 *
 * STREAMED, NOT LOADED. A session's tick log is large (hundreds of thousands to millions of lines),
 * so the file is read with a streaming reader and every line that is not the requested symbol is
 * rejected BEFORE JSON.parse. `maxLines` bounds the work and sets `truncated` so a partial read can
 * never be presented as a complete day.
 *
 * THE BASIS IS REPORTED PER DAY. The durable log gained `bq`/`sq` just now, so logs written before
 * that can only be classified by the tick rule while a fresh log can use the exchange's own buy/sell
 * counters. `basis` counts which one actually fired, and `depthOnDisk` says whether the stronger
 * basis was even available — otherwise a weaker ladder would silently stand in for a stronger one.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const footprint = require('./footprint');

const DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');
const BAR_MS = 60000;
const DEFAULT_MAX_LINES = 4_000_000;
const DEFAULT_LADDER_MAX = 120;

function dayKey(ts = Date.now()) {
  return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
}

function fileFor(day) {
  return path.join(DIR, 'ticks-' + day + '.jsonl');
}

/** days() — what history exists on disk, newest first, with the size so a huge day is visible. */
function days() {
  try {
    const out = [];
    for (const f of fs.readdirSync(DIR)) {
      const m = /^ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (!m) continue;
      const st = fs.statSync(path.join(DIR, f));
      out.push({ day: m[1], bytes: st.size, mb: +(st.size / 1048576).toFixed(1), modifiedAt: st.mtime.toISOString(), file: f });
    }
    out.sort((a, b) => b.day.localeCompare(a.day));
    return out;
  } catch (_) { return []; }
}

/** A blank bar, same shape the live footprint seals. */
function blankBar(t) {
  return { t, o: null, h: null, l: null, c: null, vol: 0, buy: 0, sell: 0, delta: 0, trades: 0, basis: {} };
}

/**
 * rebuild({ day, symbol, maxLines, ladderMax }) — the day's footprint.
 *
 * With `symbol`: the full ladder, the per-minute bars, cumulative delta, POC/value area and
 * absorption for that one name. Without it: a per-symbol digest (volume, buy, sell, delta, trades,
 * basis) so the page can list the day before drilling into a row.
 */
async function rebuild(opts = {}) {
  const file = fileFor(opts.day || dayKey());
  const want = opts.symbol ? String(opts.symbol).replace(/-EQ$/i, '').toUpperCase() : null;
  const maxLines = opts.maxLines || DEFAULT_MAX_LINES;
  // `!= null`, NOT `||`: 0 is a MEANINGFUL ladderMax ("every level"), and `0 || 120` would have
  // silently returned the capped ladder for a caller that explicitly asked for the whole thing.
  const ladderMax = opts.ladderMax != null ? opts.ladderMax : DEFAULT_LADDER_MAX;
  if (!fs.existsSync(file)) {
    return { ok: false, day: opts.day || dayKey(), error: 'no tick log for that day', days: days() };
  }

  const perSymbol = new Map();   // symbol -> digest (always, so a missing symbol can be reported)
  // PER-SYMBOL CLASSIFIER STATE, ALWAYS KEPT, AND IT IS SMALL. classify needs only the previous
  // tick's {p, bq, sq} and the carried side, so the digest mode can run the REAL classifier for
  // every symbol for a few bytes each, instead of reporting ticks with zero volume. The heavy
  // state (bars, the price ladder) is still built ONLY for the requested symbol.
  const lastRow = new Map();     // symbol -> {p, bq, sq}
  const lastSideBySym = new Map();  // symbol -> carried aggressor side (the tick rule's memory)
  let priceStep = null;
  const barsByBucket = new Map();
  const levels = new Map();
  const basis = {};
  let lines = 0, ticks = 0, matched = 0, truncated = false, depthOnDisk = false;
  let firstTs = null, lastTs = null, badLines = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    lines++;
    if (lines > maxLines) { truncated = true; break; }
    if (!line || line.length < 8) continue;
    // CHEAP PRE-FILTER: reject by the symbol substring before paying for JSON.parse.
    if (want && line.indexOf(want) === -1) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { badLines++; continue; }
    const sym = r.s;
    if (!sym) continue;
    if (want && sym !== want) continue;
    const p = +r.p;
    if (!(p > 0)) continue;
    const ts = +r.t || 0;
    const q = +r.q || 0;
    const bq = +r.bq || 0, sq = +r.sq || 0;
    if (bq > 0 || sq > 0) depthOnDisk = true;

    ticks++;
    if (firstTs == null || ts < firstTs) firstTs = ts;
    if (lastTs == null || ts > lastTs) lastTs = ts;      const d = perSymbol.get(sym) || { symbol: sym, ticks: 0, vol: 0, trades: 0, delta: 0, buy: 0, sell: 0, basis: {}, firstTs: null, lastTs: null };
    d.ticks++;
    if (d.firstTs == null) d.firstTs = ts;
    d.lastTs = ts;
    perSymbol.set(sym, d);

    // THE LIVE CLASSIFIER, for EVERY symbol in every mode. `st.lastSide` is this symbol's own
    // carried side and `prev` its own previous print, exactly as the live footprint calls it.
    const st = { lastSide: lastSideBySym.get(sym) || null };
    const prev = lastRow.get(sym) || null;
    const cls = footprint.classify({ p, q, bq, sq }, prev, st);
    if (st.lastSide) lastSideBySym.set(sym, st.lastSide);
    lastRow.set(sym, { p, bq, sq });

    const w = q > 0 ? q : 1;
    if (cls.side === 'buy') { d.vol += w; d.buy += w; d.delta += w; }
    else if (cls.side === 'sell') { d.vol += w; d.sell += w; d.delta -= w; }
    d.trades++;
    d.basis[cls.basis] = (d.basis[cls.basis] || 0) + 1;
    basis[cls.basis] = (basis[cls.basis] || 0) + 1;

    if (want && sym === want) {
      matched++;
      if (priceStep == null) priceStep = footprint.bucketStep(p);
      const bucket = Math.floor(ts / BAR_MS) * BAR_MS;
      let bar = barsByBucket.get(bucket);
      if (!bar) { bar = blankBar(bucket); barsByBucket.set(bucket, bar); }
      const key = footprint.bucketOf(p, priceStep);
      let lvl = levels.get(key);
      if (!lvl) { lvl = { p: key, b: 0, a: 0 }; levels.set(key, lvl); }
      if (cls.side === 'buy') { lvl.a += w; bar.buy += w; bar.delta += w; }
      else if (cls.side === 'sell') { lvl.b += w; bar.sell += w; bar.delta -= w; }
      bar.o = bar.o == null ? p : bar.o;
      bar.h = bar.h == null ? p : Math.max(bar.h, p);
      bar.l = bar.l == null ? p : Math.min(bar.l, p);
      bar.c = p;
      bar.vol += w;
      bar.trades++;
      bar.basis[cls.basis] = (bar.basis[cls.basis] || 0) + 1;
    }
  }
  rl.close();

  const day = opts.day || dayKey();
  const base = {
    ok: true, day, symbol: want, file: path.basename(file),
    lines, ticks, matched, truncated, maxLines, badLines, depthOnDisk,
    symbols: perSymbol.size,
    firstTs: firstTs ? new Date(firstTs).toISOString() : null,
    lastTs: lastTs ? new Date(lastTs).toISOString() : null,
    window: { from: firstTs, to: lastTs },
  };
  if (!want) {
    const rows = Array.from(perSymbol.values()).sort((a, b) => (b.vol || 0) - (a.vol || 0));
    return Object.assign(base, { lite: true, count: rows.length, items: rows.slice(0, 600) });
  }
  if (!matched) {
    return Object.assign(base, { error: 'symbol not present in that day\'s log', ladder: [], bars: [] });
  }

  // ---- BARS, with the running session delta attached to each one so the page can draw the
  // cumulative line straight from `bars` without re-deriving it.
  const bars = Array.from(barsByBucket.values()).sort((a, b) => a.t - b.t);
  let run = 0;
  for (const b of bars) {
    run += b.delta;
    b.cum = +run.toFixed(2);
    b.delta = +b.delta.toFixed(2);
    b.vol = +b.vol.toFixed(2);
  }

  // ---- LADDER: the price table the whole thing exists for. Kept as the highest-volume levels
  // (a session can trade hundreds of prices), each with its bid×ask executed split and imbalance.
  const allLevels = Array.from(levels.values()).map((v) => {
    const tot = v.a + v.b;
    // IMBALANCE NEEDS BOTH SIDES. A bucket that only ever traded on one side has no ratio to
    // report: `max / 1` produces a number in the hundreds that looks like a huge imbalance and
    // means "nothing traded on the other side". Reported as null so the page can say "not
    // applicable" instead of printing a headline number that is an artifact of the denominator.
    const imb = (v.a > 0 && v.b > 0) ? +((Math.max(v.a, v.b)) / Math.min(v.a, v.b)).toFixed(2) : null;
    return { p: v.p, b: +v.b.toFixed(2), a: +v.a.toFixed(2), tot: +tot.toFixed(2), delta: +(v.a - v.b).toFixed(2), imb };
  });
  const byVol = allLevels.slice().sort((x, y) => y.tot - x.tot);
  // ladderMax <= 0 means ALL levels (the day file is the source of truth, so a caller that wants the
  // whole ladder can have it). The cap exists because a session trades hundreds of prices.
  const keep = ladderMax > 0 ? new Set(byVol.slice(0, ladderMax).map((r) => r.p)) : null;
  const ladder = (keep ? allLevels.filter((r) => keep.has(r.p)) : allLevels.slice()).sort((x, y) => y.p - x.p);
  // THE CAP IS REPORTED AS VOLUME COVERAGE. Capping by level COUNT hides traded volume silently; a
  // page that shows 120 of 150 levels while saying nothing implies the ladder is the whole day.
  const sessionVol = allLevels.reduce((s, r) => s + r.tot, 0);
  const shownVol = ladder.reduce((s, r) => s + r.tot, 0);
  const ladderVolumePct = sessionVol > 0 ? +(shownVol / sessionVol).toFixed(4) : null;
  // the SAME functions the live layer calls — not a second implementation of them
  const levelVals = allLevels.map((r) => ({ p: r.p, b: r.b, a: r.a }));
  const pocOut = footprint.pocFromLevels(levelVals, 0.7);
  const absOut = footprint.absorptionFromLevels(levelVals);

  const last = bars.length ? bars[bars.length - 1] : null;
  const d3 = bars.slice(-3).map((b) => b.delta);
  const collapse = {
    series: d3,
    down: d3.length === 3 && d3[2] > d3[1] && d3[1] > d3[0] && d3[0] < 0,
    up: d3.length === 3 && d3[2] < d3[1] && d3[1] < d3[0] && d3[0] > 0,
    barsUsed: d3.length, barsRequired: 3,
  };

  return Object.assign(base, {
    lite: false,
    priceStep,
    basis,
    digest: perSymbol.get(want) || null,
    bars,
    levels: allLevels.length,
    ladderShown: ladder.length,
    ladderMax,
    ladderVolumePct,
    ladderSessionVol: +sessionVol.toFixed(2),
    ladderShownVol: +shownVol.toFixed(2),
    ladder,
    cumDelta: +run.toFixed(2),
    poc: pocOut,
    absorption: absOut,
    collapse,
    lastBar: last,
    notes: [
      'Rebuilt by REPLAYING footprint.classify over the captured tape — the same classifier the live gate ran, so a historical bar and a live bar for one minute cannot disagree.',
      depthOnDisk
        ? 'The log carries bq/sq, so the exchange-quantity basis ("exchange-qty") was applied ahead of the tick rule. Its SEMANTICS are unverified: read as cumulative traded quantity it is the aggressor side; read as resting bid/ask quantity it is a book-imbalance proxy, not an executed side. `node .freebuff/verify-bqsq.js` decides which on the first captured session — until it returns TRADED-CUMULATIVE, treat these levels as an imbalance proxy.'
        : 'This log predates bq/sq, so only the tick rule (a price-based inference, not an executed side) could be applied. New captures carry the bq/sq pair as well, whose own semantics are still to be verified by verify-bqsq.js.',
      'Ladder shows the ' + ladder.length + ' highest-volume price buckets of ' + allLevels.length + ' traded, covering ' + (ladderVolumePct == null ? 'n/a' : Math.round(ladderVolumePct * 100) + '%') + ' of the session volume; pass ladderMax=0 for all of them.',
    ],
  });
}

// POC and absorption come from footprint.pocFromLevels / absorptionFromLevels — the definitions the
// live layer uses. Nothing is reimplemented here, so a day's POC cannot quietly differ from the
// live POC it is meant to explain.

module.exports = { rebuild, days, dayKey, fileFor, DIR, BAR_MS };

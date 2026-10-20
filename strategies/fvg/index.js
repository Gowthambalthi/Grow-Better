/**
 * strategies/fvg.js — ENGINE 2. Fresh Fair-Value-Gap retest.
 *
 * ---------------------------------------------------------------------------
 * THE RULES, IN ORDER
 * ---------------------------------------------------------------------------
 * A. BUILD THE FRAMES
 *    A Fair Value Gap is a three-candle imbalance, so it only exists on an
 *    aggregated frame. 1-minute bars are bucketed ON THE CLOCK (09:15, 09:20,
 *    …), never as a rolling window, because a rolling window is a bar the live
 *    feed never printed. Two frames are watched: 5m (FG01) and 15m (FG02).
 *
 * B. THE GAP
 *    On three consecutive CLOSED frame candles:
 *      BULLISH  when c1.high < c3.low   ->  zone [c1.high, c3.low]
 *      BEARISH  when c3.high < c1.low   ->  zone [c3.high, c1.low]
 *    The zone must be at least `minGapPct` wide or it is inside the spread.
 *    The zone is registered only on the bar that CLOSED the third candle, so it
 *    cannot be known early — this is the no-look-ahead line for this engine.
 *
 * C. FRESHNESS
 *    A gap is only tradeable the FIRST time price comes back into it. The
 *    first entry into the zone marks it `entered`; a later arrival is either a
 *    different trade entirely or a failed gap. A gap that never trades is
 *    nothing — no signal is manufactured from a zone price never revisited.
 *
 * D. THE RETEST (and the difference between a retest and a failure)
 *    LONG  : a CLOSED 1m bar trades into the zone (low <= zone.high) and closes
 *            back ABOVE the zone's far edge (close > zone.low), keeping at
 *            least `wickRatio` of its own range on the rejection side.
 *    SHORT : mirror.
 *    A bar that closes THROUGH the zone's far edge has not retested the gap, it
 *    has filled it: the zone is retired, not traded.
 *
 * E. LIMITS
 *    A zone expires after `maxZoneAgeBars`; the same symbol cannot signal twice
 *    within `cooldownBars`, nor more than `maxSignalsPerDay` times a day.
 *    The day's move and yesterday's move are RECORDED on every signal and gate
 *    nothing by default — see `blockLongAfterUpDay` in DEFAULTS for why that
 *    filter is measured, unsupported, and shipped off.
 *
 * F. PLAN  (delegated — strategy-core/tradePlanner.js owns every price level)
 *    Stop beyond the zone edge that invalidates the idea, targets from opposing
 *    structure plus one measured-move projection, RR and extension as gates.
 */
'use strict';

const ind = require('../../strategy-core/indicators');
const planner = require('../../strategy-core/tradePlanner');
const marketCore = require('../../strategy-core/market');
const { createSession } = require('../../strategy-core/session');
const { replay } = require('../../strategy-core/replay');
const { T } = ind;

const FRAMES = [
  { tf: 5, setup: 'FG01', label: '5m FVG' },
  { tf: 15, setup: 'FG02', label: '15m FVG' },
];

const DEFAULTS = {
  minGapPct: 0.10,          // B. narrower than this is the spread, not a gap
  maxZoneAgeBars: 180,      // E. a 3-hour-old gap is history
  wickRatio: 0.35,          // D. rejection share of the retest bar's own range
  minVolRatio: 1.0,         // E. a retest on no volume is not participation
  cooldownBars: 10,
  maxSignalsPerDay: 4,
  // HOW OLD A ZONE MUST BE BEFORE IT MAY BE TRADED, in 1-minute bars. A zone is
  // registered on the first bar of the bucket AFTER its candle closed (the gap
  // candle ends at 09:49; the engine first sees it at 09:50), so 0 means "the
  // very next bar may retest it". The rule is a ONE-SHOT: the first touching bar
  // consumes the zone even if its rejection is too weak to trade, so this value
  // decides whether that first touch is the gap's own reaction or a later one.
  // MEASURED ON THE CANONICAL CORPUS (100 symbols · 705 sessions, cost 0.05%,
  // scratch/gb_fvg_age_ab.js):
  //
  //   minZoneAgeBars 1 · 73 trades · netPF 1.940 · +43.6R · FG01 69 trades/+39.1R
  //   minZoneAgeBars 0 · 70 trades · netPF 1.245 · +11.9R · FG01 66 trades/+7.5R
  //
  // The bar immediately after the gap candle closes is a bad entry, not a good
  // one: it touches the zone while the move is still travelling, and under the
  // one-shot rule that touch consumes the zone. So the deferral stays — but it is
  // now a measured constant instead of `age < 1` justified by a comment that was
  // simply wrong about which bar belongs to the candle.
  minZoneAgeBars: 1,
  measuredMoveR: 1.5,       // F. projection target, in ATR, flagged as arithmetic
  confirmMtfTrend: true,    // MTF Confirmation: 15m trend & VWAP alignment
  maxEntryMinute: 14 * 60 + 45,  // 14:45 IST cutoff (captures 2 PM Power Hour momentum)
  powerHourVolRatio: 1.5,   // After 14:00 IST, require >= 1.5x volume surge for high-speed momentum
  // A gap retest can occur deep in the day's range without being "late": the
  // level that matters is the gap itself. Only the range-position ceiling is
  // eased, and only here; every other extension rule is the shared default.
  //
  // THE ATR FLOOR IS WRITTEN OUT HERE BECAUSE IT IS LOAD-BEARING, AND IT USED TO
  // BE INHERITED BY ACCIDENT. `tradePlanner`'s default `minAtrPct` is 0.60%, a
  // floor calibrated against an engine that entered LATE; at one-minute
  // resolution the median ATR% at a decision bar is 0.14% (p90 0.27%), so on the
  // 20-symbol probe 4,031 of the 4,032 retest decisions the gate saw were refused
  // for this one reason. It was never chosen for this engine — it simply fell
  // through — and it is what makes GB01 look like a once-in-ten-sessions event
  // rather than the setup it describes.
  //
  // IT IS KEPT, EXPLICITLY, BECAUSE LOOSENING IT LOSES MONEY. Measured on 120
  // symbols × 154 sessions (data/ohlcv_1m_live, includes the eight live sessions
  // 2026-10-07..16), cost 0.05%, one trade per symbol per day:
  //
  //   floor 0.60 (this) ·  28 trades · netPF 1.65 · +11.5R · exp +0.409R
  //   floor 0.30        · 132 trades · netPF 1.01 ·  +1.3R · exp +0.010R
  //   floor 0.15        · 367 trades · netPF 0.86 · −41.9R · exp −0.114R
  //   floor 0.10        · 404 trades · netPF 0.87 · −42.4R · exp −0.105R
  //
  // So the honest reading is stated on the signal rather than left to be
  // discovered: this engine's positive measurement is a HIGH-VOLATILITY SUBSET of
  // the rule, not the rule. Every larger sample of the same retest is negative,
  // and no one should read +1.65 as "fair-value gaps work".
  planner: { maxRangePosPct: 92, minAtrPct: 0.60 },
  // DAY-CONTEXT GATE — MEASURED, FOUND UNSUPPORTED, SHIPPED OFF.
  //
  // The hypothesis was that a stock already DOWN well on the day, after being UP
  // yesterday, keeps falling because yesterday's buyers were the sellers — i.e. a
  // long into that is a losing long. It is intuitive and it is not what the data
  // says. Measured on 1031 symbols of data/ohlcv_1m_full (301 GB01 trades, cost
  // 0.05%, scratch/gb01_down_after_up_study.js):
  //
  //   LONG, down X% today & prev day UP
  //     X = 0.0%  ·  6 trades · netPF 0.961 · +0.41R   (everything else 1.029)
  //     X = 0.5%  ·  3 trades · 3 of 3 stopped, -3.0R   (everything else 1.047)
  //     X = 1.0%  ·  1 trade  · -1.0R
  //     X >= 1.5% ·  0 trades — the gate becomes a no-op at any real threshold
  //
  // So there is no X to choose: the population is 2.6% of the long book and the
  // whole question rests on 3 trades. Three losses is also what that book
  // produces by chance 27% of the time at its own 35% win rate, so it is not
  // evidence in either direction. The bucket sweep agrees — across 1031 symbols
  // the "down >1% today AND prev up" cell return netPF 1.23 vs 1.28 for its
  // complement, i.e. no separation at all.
  //
  // WHY IT IS STILL CODE. Because the backtest cannot settle it and the live tape
  // can: setupData now records dayChangePct and prevDayPct on EVERY signal, so
  // the question is answered by accumulated live calls without changing a single
  // decision. The gate below is therefore null (off) by default and must be
  // enabled deliberately, as an object:
  //
  //   blockLongAfterUpDay: { dropPct: 0.5, minPrevDayPct: 0 }
  //
  // Do not enable it on the strength of the numbers above. They say "unmeasured",
  // not "good".
  blockLongAfterUpDay: null,
};

/**
 * The day-context numbers, or nulls when they cannot be known yet.
 *
 * `dayChangePct` is measured from TODAY'S FIRST OPEN to the entry price, not from
 * yesterday's close: this is the move the stock has actually made in the session
 * being traded. `prevDayPct` is yesterday's close over the close before it. Both
 * are null rather than zero when a piece is missing — a stock whose history is
 * too short to have a yesterday is not a stock that was flat yesterday, and
 * treating it as one would quietly put it in the wrong bucket.
 */
function dayContext(session, entry) {
  const dayOpen = session.dayOpen;
  const pd = session.prevDay;
  const ppd = session.prevPrevDay;
  const change = (from, to) => (from != null && from > 0 && to != null) ? ((to / from) - 1) * 100 : null;
  return {
    dayChangePct: change(dayOpen, entry),
    prevDayPct: (pd && ppd) ? change(ppd.close, pd.close) : null,
  };
}

// ---------------------------------------------------------------------------
// A. FRAME BUILDING — on the clock, closed buckets only
// ---------------------------------------------------------------------------

function bucketKey(time, minutes) {
  const m = /(\d+):(\d+)/.exec(String(time));
  if (!m) return time;
  const day = String(time).slice(0, 10);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const base = 9 * 60 + 15;                              // NSE opens 09:15 IST
  return day + '#' + Math.floor((mins - base) / minutes);
}

function fold(bars) {
  const first = bars[0], last = bars[bars.length - 1];
  let high = -Infinity, low = Infinity, vol = 0;
  for (const b of bars) {
    if (b[T.HIGH] > high) high = b[T.HIGH];
    if (b[T.LOW] < low) low = b[T.LOW];
    vol += b[T.VOLUME];
  }
  return [last[T.TIME], first[T.OPEN], high, low, last[T.CLOSE], vol];
}

function newFrame(spec) {
  return Object.assign({}, spec, { bars: [], key: null, bucket: [], zones: [] });
}

/**
 * Push one 1m bar into every frame. Returns the frames whose aggregated bar
 * just CLOSED, so the caller knows when a new three-candle window exists.
 */
function advance(frames, bar, index) {
  const closed = [];
  for (const f of frames) {
    const key = bucketKey(bar[T.TIME], f.tf);
    if (f.key == null) f.key = key;
    if (key !== f.key) {
      if (f.bucket.length >= f.tf) { f.bars.push(fold(f.bucket)); closed.push(f); }
      f.key = key;
      f.bucket = [];
    }
    f.bucket.push(bar);
  }
  return closed;
}

/**
 * B. A new gap, if the last three CLOSED frame candles make one. `knownIndex`
 * is the 1m bar at which the third candle closed — the earliest bar this zone
 * can possibly be known on.
 */
function detectGap(f, knownIndex, cfg) {
  const a = f.bars;
  if (a.length < 3) return null;
  const c1 = a[a.length - 3], c2 = a[a.length - 2], c3 = a[a.length - 1];

  let side = null, low = null, high = null;
  if (c1[T.HIGH] < c3[T.LOW]) { side = 'LONG'; low = c1[T.HIGH]; high = c3[T.LOW]; }
  else if (c3[T.HIGH] < c1[T.LOW]) { side = 'SHORT'; low = c3[T.HIGH]; high = c1[T.LOW]; }
  if (!side) return null;

  const gapPct = ((high - low) / low) * 100;
  if (!(gapPct >= cfg.minGapPct)) return null;

  return {
    side, low, high, gapPct,
    tf: f.tf, setup: f.setup, label: f.label,
    mid: (low + high) / 2,
    createdIndex: knownIndex,
    createdTime: a[a.length - 1][T.TIME],
    entered: false,
    middleVolume: c2 ? c2[T.VOLUME] : null,
  };
}

// ---------------------------------------------------------------------------
// D. THE RETEST — one bar, one answer
// ---------------------------------------------------------------------------

/**
 * Decide, for the zone and the bar that just closed, whether this is a retest,
 * a fill, or still nothing. Only a retest returns a setup.
 */
function retest(zone, bar, cfg) {
  const r = bar[T.HIGH] - bar[T.LOW];

  if (zone.side === 'LONG') {
    if (bar[T.LOW] > zone.high) return null;                     // never came back
    if (bar[T.CLOSE] < zone.low) return { dead: 'gap filled' };  // filled, not retested
    const wick = r > 0 ? (bar[T.CLOSE] - bar[T.LOW]) / r : 0;
    if (wick < cfg.wickRatio) return null;                       // weak close, wait
    return { entry: bar[T.CLOSE], invalidation: zone.low, side: 'LONG', wick };
  }

  if (bar[T.HIGH] < zone.low) return null;
  if (bar[T.CLOSE] > zone.high) return { dead: 'gap filled' };
  const wick = r > 0 ? (bar[T.HIGH] - bar[T.CLOSE]) / r : 0;
  if (wick < cfg.wickRatio) return null;
  return { entry: bar[T.CLOSE], invalidation: zone.high, side: 'SHORT', wick };
}

// ---------------------------------------------------------------------------
// THE ENGINE
// ---------------------------------------------------------------------------

/**
 * `evaluate(bars1m, index)` — stateless convenience wrapper, one line, shared
 * with the other two engines (strategy-core/replay.js). O(n²) by construction:
 * for a caller with a full array asking about ONE bar.
 */
function evaluate(bars1m, index, config) { return replay(module.exports, bars1m, index, config); }

/**
 * `createEngine(config)` — one pass, O(bars), and the SAME object a live loop
 * and a backtest both drive.
 */
function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  // The day bookkeeping (day array, extremes, previous day, rolling tail, and the
  // carried VWAP/POC) belongs to the shared tracker — this engine adds only the
  // frames, which are genuinely its own.
  const session = createSession(cfg);
  // Prior closes, when a caller has them: on the live tape the engine is rebuilt
  // every session from today's bars only, so without a seed `prevDay` is null for
  // the whole day. See dayContext() — the numbers are recorded, not acted on.
  if (cfg.priorDayCloses && cfg.priorDayCloses.length) session.seedPriorCloses(cfg.priorDayCloses);
  const frameSpecs = cfg.frames || FRAMES;
  let frames = frameSpecs.map(newFrame);
  let cooldownUntil = -1;
  let signalsToday = 0;

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;
    const d = ind.dayOf(bar);

    const isNewDay = session.onBar(bar);
    if (isNewDay) {
      frames = frameSpecs.map(newFrame);
      cooldownUntil = -1; signalsToday = 0;
    }

    // A. advance every frame; register any gap that just became knowable
    for (const f of advance(frames, bar, index)) {
      const z = detectGap(f, index, cfg);
      if (z) f.zones.push(z);
    }

    const totalZones = frames.reduce((sum, f) => sum + f.zones.length, 0);
    const shouldLog = process.env.GB_FVG_DEBUG === '1';
    if (shouldLog) {
      console.log(`[fvg/debug] ${cfg.symbol || 'SYM'} bar=${bar[T.TIME]} newDay=${isNewDay} cooldownUntil=${cooldownUntil} (idx=${index}) signalsToday=${signalsToday} trackedZones=${totalZones}`);
    }

    if (index < cooldownUntil) return null;
    if (signalsToday >= cfg.maxSignalsPerDay) return null;
    if (cfg.maxEntryMinute != null) {
      const tm = /(\d+):(\d+)/.exec(String(bar[T.TIME]));
      if (tm) {
        const mins = Number(tm[1]) * 60 + Number(tm[2]);
        if (mins > cfg.maxEntryMinute) return null;
      }
    }


    // C/D. walk the zones, newest first, and act only on a genuine retest
    for (const f of frames) {
      for (let zi = f.zones.length - 1; zi >= 0; zi--) {
        const zone = f.zones[zi];
        if (zone.entered) continue;
        // AGE IS COUNTED FROM THE BAR AFTER THE CANDLE CLOSED, NOT FROM THE
        // CANDLE ITSELF. `advance()` registers the zone on the first ONE-MINUTE
        // bar of the next bucket (the gap candle ends at 09:49 and the zone is
        // known at the close of 09:49), so age 0 is the first bar that COULD
        // legally trade it. `minZoneAgeBars` decides whether it may: this was a
        // hardcoded `age < 1` whose comment claimed the creating bar was part of
        // the candle (it is not), so the one-bar deferral was an accident of
        // reasoning that happens to be the better rule — it is now a measured
        // constant instead of a mistake that reads like one.
        const age = index - zone.createdIndex;
        if (age < cfg.minZoneAgeBars) continue;
        if (age > cfg.maxZoneAgeBars) { f.zones.splice(zi, 1); continue; }   // E. expired

        // A zone is a one-shot setup: the first bar that trades into it consumes
        // it, even when that bar does not produce a strong enough rejection.
        // Previously a weak first touch left `entered` false, allowing a later
        // revisit to masquerade as the documented "FIRST RETURN".
        const touched = bar[T.LOW] <= zone.high && bar[T.HIGH] >= zone.low;
        if (!touched) continue;
        zone.entered = true;

        const hit = retest(zone, bar, cfg);
        if (process.env.GB_FVG_DEBUG === '1' && hit) {
          console.log(`[fvg/debug] ${cfg.symbol || 'SYM'} retest touch at ${bar[T.TIME]}: side=${hit.side} entry=${hit.entry} wick=${hit.wick} dead=${hit.dead}`);
        }
        if (!hit || hit.dead) continue;

        const entry = hit.entry;
        const m = marketCore.measure({ session, entry });
        const dayCtx = dayContext(session, entry);
        const volRatio = m.volumeRatio;
        if (process.env.GB_FVG_DEBUG === '1') {
          console.log(`[fvg/debug] ${cfg.symbol || 'SYM'} measure at ${bar[T.TIME]}: vwapDistPct=${m.vwapDistPct != null ? m.vwapDistPct.toFixed(3) + '%' : 'null'}, volRatio=${volRatio != null ? volRatio.toFixed(2) + 'x' : 'null'}, atrPct=${m.atrPct != null ? m.atrPct.toFixed(3) + '%' : 'null'}`);
        }

        if (cfg.confirmMtfTrend) {
          const f15 = frames.find((fr) => fr.tf === 15);
          if (f15 && f15.bars.length >= 2) {
            const last15 = f15.bars[f15.bars.length - 1];
            const prev15 = f15.bars[f15.bars.length - 2];
            const is15mBull = last15[T.CLOSE] > prev15[T.CLOSE] && last15[T.CLOSE] > last15[T.OPEN];
            const is15mBear = last15[T.CLOSE] < prev15[T.CLOSE] && last15[T.CLOSE] < last15[T.OPEN];
            if (is15mBull && hit.side !== 'LONG') continue;
            if (is15mBear && hit.side !== 'SHORT') continue;
          }
          if (m.vwapDistPct != null) {
            if (hit.side === 'LONG' && m.vwapDistPct < 0) continue;
            if (hit.side === 'SHORT' && m.vwapDistPct > 0) continue;
          }
        }

        const structure = [];
        for (const g of frames) for (const z2 of g.zones) if (z2 !== zone) structure.push(z2.side === 'LONG' ? z2.low : z2.high);

        const targetCandidates = marketCore.targets({
          side: hit.side, entry, market: m, structure, measuredMoveR: cfg.measuredMoveR,
        });

        const setupId = 'FVG-' + (bar.symbol || '') + '-' + d + '-' + zone.tf + 'm-' + zone.low.toFixed(2);
        const base = marketCore.signalBase({
          engine: 'FVG', setup: zone.setup, side: hit.side, bar, index, setupId,
          market: m, targetCandidates,
          setupData: {
            timeframe: zone.tf + 'm',
            zoneLow: zone.low, zoneHigh: zone.high, zoneMid: zone.mid,
            gapPct: zone.gapPct, side: hit.side,
            ageBars: age, wickRatio: hit.wick,
            invalidation: hit.invalidation,
            frameLabel: zone.label,
            mtfConfirmed: Boolean(cfg.confirmMtfTrend),
            // RECORDED ON EVERY SIGNAL, GATED BY NOTHING. These are the day's
            // move and yesterday's move, so the day-context question can be
            // answered from live calls instead of from a 3-trade backtest slice.
            dayChangePct: dayCtx.dayChangePct,
            prevDayPct: dayCtx.prevDayPct,
          },
          extra: { invalidationForFill: hit.invalidation },
        });

        const built = planner.plan({
          side: hit.side, entry, invalidation: hit.invalidation,
          targets: targetCandidates, market: m, config: cfg.planner,
        });

        if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });

        // DAY-CONTEXT REFUSAL — only when configured (default null, see DEFAULTS).
        // Refused BEFORE the cooldown is consumed, so the same setup is not
        // silently burned for the next ten bars by a filter that was off.
        const dc = cfg.blockLongAfterUpDay;
        if (dc && hit.side === 'LONG'
          && dayCtx.prevDayPct != null && dayCtx.dayChangePct != null
          && dayCtx.prevDayPct > (dc.minPrevDayPct != null ? dc.minPrevDayPct : 0)
          && dayCtx.dayChangePct <= -(dc.dropPct != null ? dc.dropPct : 0.5)) {
          return Object.assign(base, {
            ok: false, gate: 'DAY_CONTEXT',
            reject: ['long into a stock down ' + dayCtx.dayChangePct.toFixed(2) + '% on a day after +'
              + dayCtx.prevDayPct.toFixed(2) + '%',
              'gate blockLongAfterUpDay dropPct ' + (dc.dropPct != null ? dc.dropPct : 0.5) + '%'],
          });
        }

        if (volRatio != null && volRatio < cfg.minVolRatio) {
          return Object.assign(base, { ok: false, gate: 'VOLUME', reject: ['retest on ' + volRatio.toFixed(2) + '× average volume'] });
        }

        cooldownUntil = index + cfg.cooldownBars;
        signalsToday += 1;

        const withPlan = marketCore.withPlan(base, built, cfg);
        withPlan.reason = [
          zone.label + ' IMBALANCE ' + zone.gapPct.toFixed(2) + '% wide (' + zone.low.toFixed(2) + '–' + zone.high.toFixed(2) + ')',
          'FIRST RETURN into the gap (' + age + ' bar(s) old) — fresh, not a second visit',
          'CLOSE held the far edge ' + hit.invalidation.toFixed(2) + ' (' + (hit.wick * 100).toFixed(0) + '% of range on the rejection side)',
          volRatio != null ? 'VOLUME ' + volRatio.toFixed(2) + '× avg' : 'VOLUME unmeasured',
          'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
          'NOT EXTENDED (VWAP dist ' + (m.vwapDistPct == null ? 'n/a' : m.vwapDistPct.toFixed(2) + '%') + ')',
        ];
        if (cfg.confirmMtfTrend) {
          withPlan.reason.push('MTF CONFIRMED — 15m trend & VWAP aligned with ' + hit.side);
        }
        return withPlan;
      }
    }
    return null;
  }

  return { onBar, cfg, state: () => ({ frames, day: session.day, prevDay: session.prevDay }) };
}

module.exports = {
  id: 'FVG', setup: 'FG01', name: 'FVG / Gap Retest',
  families: [{ setup: 'FG01', label: 'Fresh 5m FVG retest' }, { setup: 'FG02', label: 'Fresh 15m FVG retest' }],
  DEFAULTS, evaluate, createEngine, detectGap, retest, advance,
};

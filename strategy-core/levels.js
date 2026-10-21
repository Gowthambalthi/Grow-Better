/**
 * strategy-core/levels.js — where liquidity actually sits.
 *
 * These are the levels a sweep can raid. All of them come from CLOSED data: the
 * previous session's high/low from completed sessions, the opening range from
 * completed bars, the swings from completed bars. Nothing here can see the bar
 * it is being asked about, which is what keeps the live and replay views of a
 * level identical.
 */
'use strict';

const { T, dayOf } = require('./indicators');

/**
 * Group bars into sessions, in order. Returns [{ day, bars }] — the caller
 * decides which session is "previous", so this never assumes the last one.
 */
function sessions(bars) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const d = dayOf(b);
    if (!cur || cur.day !== d) { cur = { day: d, bars: [] }; out.push(cur); }
    cur.bars.push(b);
  }
  return out;
}

function rangeOf(bars) {
  let high = -Infinity, low = Infinity;
  for (const b of bars) {
    if (b[T.HIGH] > high) high = b[T.HIGH];
    if (b[T.LOW] < low) low = b[T.LOW];
  }
  return { high, low };
}

/**
 * The previous day's high and low, computed from sessions that ENDED before
 * `day`. Returns null when there is no prior session — a missing level must
 * read as missing, never as yesterday's own extreme.
 */
function previousDay(dayBars, day) {
  const prior = dayBars.filter((s) => s.day < day);
  if (!prior.length) return null;
  const last = prior[prior.length - 1];
  return Object.assign({ day: last.day }, rangeOf(last.bars));
}

/**
 * The opening range of `day` up to and including `barIndex`: high/low of the
 * first `minutes` of the session, but ONLY once that window has fully elapsed.
 * Before it elapses this returns null, so the engine cannot trade a range that
 * is still forming.
 */
function openingRange(dayBarsForDay, minutes = 15) {
  const need = minutes;
  if (dayBarsForDay.length < need) return null;
  const slice = dayBarsForDay.slice(0, need);
  return Object.assign({ minutes }, rangeOf(slice));
}

/**
 * Swing highs/lows: a bar whose high is the highest within `wing` bars either
 * side. The wing requires `wing` bars AFTER it, so a swing is only ever
 * confirmed `wing` bars late — the same delay a live system would suffer.
 */
function swings(bars, wing = 3) {
  const highs = [], lows = [];
  for (let i = wing; i < bars.length - wing; i++) {
    let isHigh = true, isLow = true;
    for (let k = i - wing; k <= i + wing; k++) {
      if (k === i) continue;
      if (bars[k][T.HIGH] >= bars[i][T.HIGH]) isHigh = false;
      if (bars[k][T.LOW] <= bars[i][T.LOW]) isLow = false;
    }
    if (isHigh) highs.push({ index: i, time: bars[i][T.TIME], price: bars[i][T.HIGH] });
    if (isLow) lows.push({ index: i, time: bars[i][T.TIME], price: bars[i][T.LOW] });
  }
  return { highs, lows };
}

/**
 * Equal highs/lows: separate swings within `tolerancePct` of each other. Two
 * touches of the same price is the classic liquidity pool a sweep goes after.
 * Kept as a group with the touches, so the reason can name them.
 */
function equalLevels(swingsList, tolerancePct = 0.15) {
  const groups = [];
  const used = new Set();
  const sorted = swingsList.slice().sort((a, b) => a.price - b.price);
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const group = [sorted[i]];
    used.add(i);
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const ref = group[0].price;
      if (!ref) continue;
      if (Math.abs((sorted[j].price / ref) - 1) * 100 <= tolerancePct) { group.push(sorted[j]); used.add(j); }
      else break;
    }
    if (group.length >= 2) {
      const avg = group.reduce((s, g) => s + g.price, 0) / group.length;
      groups.push({ price: avg, touches: group.length, last: group[group.length - 1].time });
    }
  }
  return groups;
}

/**
 * Every level the Liquidity Sweep engine is allowed to consider, for the bar at
 * `index` of `bars1m`. Passing `index` instead of the full array is deliberate:
 * the caller cannot accidentally hand over future bars.
 */
function levelsFor(bars1m, index, opts = {}) {
  const bar = bars1m[index];
  if (!bar) return null;
  const day = dayOf(bar);
  const seen = bars1m.slice(0, index + 1);              // closed bars only
  const dayBars = seen.filter((b) => dayOf(b) === day);
  const rest = seen.filter((b) => dayOf(b) !== day);

  const pd = previousDay(sessions(seen), day);
  const or = openingRange(dayBars, opts.openingRangeMinutes || 15);
  const sw = swings(dayBars, opts.swingWing || 3);

  return {
    day,
    barIndexInDay: dayBars.length - 1,
    previousDayHigh: pd ? pd.high : null,
    previousDayLow: pd ? pd.low : null,
    openingRangeHigh: or ? or.high : null,
    openingRangeLow: or ? or.low : null,
    openingRangeReady: !!or,
    swingHighs: sw.highs,
    swingLows: sw.lows,
    equalHighs: equalLevels(sw.highs, opts.equalTolerancePct || 0.15),
    equalLows: equalLevels(sw.lows, opts.equalTolerancePct || 0.15),
    sessionHigh: dayBars.length ? rangeOf(dayBars).high : null,
    sessionLow: dayBars.length ? rangeOf(dayBars).low : null,
    highOfDay: rest.length ? null : null,               // reserved, never inferred
    dayBars,
    barsBeforeToday: rest.length,
  };
}

module.exports = { sessions, rangeOf, previousDay, openingRange, swings, equalLevels, levelsFor };

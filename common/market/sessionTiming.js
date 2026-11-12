/**
 * common/market/sessionTiming.js
 * Centralized Market Timing & Schedule Rules for Intraday Trading (IST / Indian Standard Time)
 *
 * TIME-OF-DAY INVESTOR MOOD REGIMES:
 * 1. 09:25 - 10:30 AM: MORNING_BREAKOUT_MOOD (Opening Impulse, High Volatility, ORB & Bluechip Expansion)
 * 2. 10:30 - 12:00 PM: INSTITUTIONAL_TREND_MOOD (Institutional Position Accumulation, Clean Trend Pullbacks)
 * 3. 12:00 - 01:30 PM: LUNCH_CHOP_GUARD_MOOD (Low Liquidity Chop Trap, Higher Volume Floor & Fakeout Guard)
 * 4. 01:30 - 03:00 PM: POWER_HOUR_SURGE_MOOD (European Open Impact, Momentum Trend Acceleration)
 * 5. 03:00 - 03:30 PM: SWING_POSITIONING_MOOD (Intraday Cutoff, Multi-day Swing Positioning)
 */

const fs = require('fs');
const path = require('path');

// TRADING HOLIDAYS — days the exchange itself is shut. The close walks below
// must skip them like weekends: after a holiday Monday the last real close is
// FRIDAY 15:30, and news from the holiday Monday morning never moved any
// market, so it stays live instead of vanishing. Calendar curated from the
// official NSE/NYSE circulars (see "source" inside the file); a year missing
// from the file is treated as all-trading-days.
const HOLIDAY_FILE = path.join(__dirname, 'tradingHolidays.json');
let _holidays = null;

function holidayCalendar(country) {
  if (!_holidays) {
    try { _holidays = JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8')); } catch (e) { _holidays = {}; }
  }
  return _holidays[country] || {};
}

function isHoliday(dateStr, country) {
  return !!holidayCalendar(country)[dateStr];
}

const pad2 = (n) => (n < 10 ? '0' : '') + n;
/** IST calendar string of a getISTTime()-shifted Date (its LOCAL fields are IST). */
function istDateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
/** Calendar string of a UTC-fields Date (used by the US walk). */
function utcDateStr(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }

function getISTTime(date = new Date()) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istOffset = 5.5 * 3600000; // IST is UTC+5:30
  return new Date(utc + istOffset);
}

function getInvestorMoodRegime(date = new Date()) {
  const ist = getISTTime(date);
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  const dateStr = istDateStr(ist);
  const holiday = holidayCalendar('india')[dateStr];
  if (day === 0 || day === 6 || holiday) {
    return {
      regimeKey: 'CLOSED',
      label: holiday ? `Market Closed (Holiday: ${holiday})` : 'Market Closed (Weekend)',
      emoji: '🌙',
      volMultiplierReq: 1.0,
      allowIntradayBreakouts: false,
      allowSwingSignals: true,
      description: holiday ? `Exchange closed for ${holiday}. Only daily bar swing & overnight catalyst scans run.` : 'Weekend market closure. Only daily bar swing scans run.',
    };
  }

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeNum = hours * 100 + minutes;

  if (timeNum < 925) {
    return {
      regimeKey: 'OPENING_PREP',
      label: 'Opening Price Discovery & Range Prep',
      emoji: '🌅',
      volMultiplierReq: 2.5,
      allowIntradayBreakouts: false,
      allowSwingSignals: true,
      description: 'Observation & Range Calculation window (09:08 - 09:25 AM).',
    };
  }

  if (timeNum >= 925 && timeNum < 1030) {
    return {
      regimeKey: 'MORNING_BREAKOUT_MOOD',
      label: 'Morning Opening Impulse & ORB Expansion',
      emoji: '🔥',
      volMultiplierReq: 2.5,
      allowIntradayBreakouts: true,
      allowSwingSignals: true,
      bestStrategies: ['ORB_INTRADAY', 'DONCHIAN_SWING', 'GOLDEN_CROSS_SWING', 'SUPERTREND_SWING'],
      description: 'High volatility opening expansion. ORB on Liquid Bluechips given highest weight.',
    };
  }

  if (timeNum >= 1030 && timeNum < 1200) {
    return {
      regimeKey: 'INSTITUTIONAL_TREND_MOOD',
      label: 'Institutional Trend Continuation',
      emoji: '🏛️',
      volMultiplierReq: 2.0,
      allowIntradayBreakouts: true,
      allowSwingSignals: true,
      bestStrategies: ['DONCHIAN_SWING', 'GOLDEN_CROSS_SWING', 'SUPERTREND_SWING', 'ORB_INTRADAY'],
      description: 'Institutional order accumulation. Smooth trend pullbacks & 20-EMA alignment.',
    };
  }

  if (timeNum >= 1200 && timeNum < 1330) {
    return {
      regimeKey: 'LUNCH_CHOP_GUARD_MOOD',
      label: 'Mid-Day Lunch Chop Guard (Strict Fakeout Block)',
      emoji: '⚠️',
      volMultiplierReq: 3.5, // Requires 3.5x volume floor to prevent fakeout traps
      allowIntradayBreakouts: false, // Block speculative micro breakouts in chop zone
      allowSwingSignals: true,
      bestStrategies: ['DONCHIAN_SWING', 'GOLDEN_CROSS_SWING', 'SUPERTREND_SWING'],
      description: 'Low liquidity lunch window. Speculative intraday breakouts blocked to prevent fakeout traps.',
    };
  }

  if (timeNum >= 1330 && timeNum < 1500) {
    return {
      regimeKey: 'POWER_HOUR_SURGE_MOOD',
      label: 'Afternoon European Open & Power Hour Surge',
      emoji: '🚀',
      volMultiplierReq: 2.8,
      allowIntradayBreakouts: true,
      allowSwingSignals: true,
      bestStrategies: ['SUPERTREND_SWING', 'DONCHIAN_SWING', 'GOLDEN_CROSS_SWING', 'ORB_INTRADAY'],
      description: 'European open momentum acceleration. Power Hour trend breakouts with tighter trailing stops.',
    };
  }

  if (timeNum >= 1500 && timeNum < 1530) {
    return {
      regimeKey: 'SWING_POSITIONING_MOOD',
      label: 'Market Closing & Multi-Day Swing Positioning',
      emoji: '📦',
      volMultiplierReq: 1.0,
      allowIntradayBreakouts: false,
      allowSwingSignals: true,
      bestStrategies: ['DONCHIAN_SWING', 'GOLDEN_CROSS_SWING', 'SUPERTREND_SWING'],
      description: 'Intraday signal cutoff. Daily bar swing strategies run for multi-day position holding.',
    };
  }

  return {
    regimeKey: 'CLOSED',
    label: 'Market Closed',
    emoji: '🌙',
    volMultiplierReq: 1.0,
    allowIntradayBreakouts: false,
    allowSwingSignals: true,
    description: 'After-hours market closure.',
  };
}

function getSessionPhase(date = new Date()) {
  const ist = getISTTime(date);
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  const dateStr = istDateStr(ist);
  const holiday = holidayCalendar('india')[dateStr];
  if (day === 0 || day === 6 || holiday) {
    return {
      phase: 'CLOSED',
      isSignalAllowed: false,
      autoSquareOff: false,
      reason: holiday ? `Market Holiday (${holiday})` : 'Weekend'
    };
  }

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeNum = hours * 100 + minutes;

  if (timeNum < 908) {
    return { phase: 'PRE_OPEN', isSignalAllowed: false, autoSquareOff: false, hasPreMarketGapData: false, reason: 'Before observation window (pre 09:08 AM)' };
  }
  if (timeNum >= 908 && timeNum < 920) {
    return {
      phase: 'OBSERVATION',
      isSignalAllowed: false,
      autoSquareOff: false,
      hasPreMarketGapData: true,
      isPreOpenCallWindow: timeNum < 915,
      reason: timeNum < 915
        ? 'Pre-Market Confirmed Discovery (09:08 - 09:15 AM). IEP Gaps & Pre-Open Calls Active for 09:15 Open.'
        : 'Observation window (09:15 - 09:20 AM). Tracking price/vol only.'
    };
  }
  if (timeNum >= 920 && timeNum < 925) {
    return { phase: 'SETTLEMENT', isSignalAllowed: false, autoSquareOff: false, reason: 'Settlement window (09:20 - 09:25 AM). Range calculation.' };
  }
  if (timeNum >= 925 && timeNum < 1500) {
    return { phase: 'ACTIVE_TRADING', isSignalAllowed: true, autoSquareOff: false, reason: 'Active signal window (09:25 AM - 03:00 PM).' };
  }
  if (timeNum >= 1500 && timeNum < 1515) {
    return { phase: 'CUTOFF', isSignalAllowed: false, autoSquareOff: false, reason: 'Cutoff window (3:00 PM - 3:15 PM). No new signals allowed.' };
  }
  if (timeNum >= 1515 && timeNum < 1530) {
    return { phase: 'SQUARE_OFF', isSignalAllowed: false, autoSquareOff: true, reason: 'Auto Square-Off window (3:15 PM - 3:30 PM). All positions closing.' };
  }
  if (timeNum >= 1530) {
    return { phase: 'CLOSED', isSignalAllowed: false, autoSquareOff: false, reason: 'Market closed (after 03:30 PM).' };
  }

  return { phase: 'CLOSED', isSignalAllowed: false, autoSquareOff: false, reason: 'Market closed' };
}

/**
 * THE AFTER-CLOSE BOUNDARY. The most recent 15:30 IST close at or before
 * `date`, skipping weekends. News published BEFORE this instant has already
 * moved the market — the board, the digest and the news feed drop it instead
 * of presenting it as actionable. News at or after it is what can still move
 * the NEXT session: the "market closed yesterday 3:30, news came after that"
 * window the owner asked for.
 *
 * At 16:00 IST today → today 15:30 (today's session already moved). At 09:00
 * IST tomorrow → still today 15:30 (yesterday's post-close + overnight news is
 * the live set). Monday 08:00 → last Friday 15:30 (weekend news kept, Friday
 * intraday dropped).
 *
 * Returns { date, instant, label } — IST calendar date of the close, its epoch
 * milliseconds (15:30 IST == 10:00 UTC; India has no DST), and a display
 * string. The local getters of getISTTime() carry the IST wall clock, so the
 * calendar walk below is timezone-independent.
 */
function lastMarketClose(date = new Date()) {
  const ist = getISTTime(date);
  const probe = new Date(ist.getTime());
  if (ist.getHours() * 100 + ist.getMinutes() < 1530) probe.setDate(probe.getDate() - 1);
  // Weekends AND exchange holidays: no session means no close that day.
  const india = holidayCalendar('india');
  while (probe.getDay() === 0 || probe.getDay() === 6 || india[istDateStr(probe)]) {
    probe.setDate(probe.getDate() - 1);
  }
  const y = probe.getFullYear();
  const m = probe.getMonth();
  const d = probe.getDate();
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const dateStr = y + '-' + pad(m + 1) + '-' + pad(d);
  return {
    date: dateStr,
    instant: Date.UTC(y, m, d, 10, 0, 0),
    label: dateStr + ' 15:30 IST',
  };
}

/**
 * US EQUITIES CLOSE — the other boundary the day turns on. NYSE/Nasdaq regular
 * close is 16:00 ET: 01:30 IST while the US is on EDT (second-Sunday-March →
 * first-Sunday-November), 02:30 IST on EST. That session is the information
 * the Indian day opens on, so a recap keyed to THIS close is the pre-open
 * read. US holidays are treated as sessions (same honesty caveat as NSE
 * weekends-above: only the calendar, not the exchange, is consulted).
 *
 * Returns { instant, date, label } — the close instant, its IST calendar date,
 * and a display string like "2026-10-20 01:30 IST".
 */
function nthSundayUtc(year, month0, nth, hourUtc) {
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const day = 1 + ((7 - firstDow) % 7) + (nth - 1) * 7;
  return Date.UTC(year, month0, day, hourUtc);
}

/** EDT (UTC-4) between 2nd-Sunday-March 02:00 EST and 1st-Sunday-Nov 02:00 EDT; else EST (UTC-5). */
function usEtOffsetMs(instant) {
  const t = instant instanceof Date ? instant.getTime() : Number(instant);
  const y = new Date(t).getUTCFullYear();
  const start = nthSundayUtc(y, 2, 2, 7);  // 02:00 EST == 07:00 UTC
  const end = nthSundayUtc(y, 10, 1, 6);   // 02:00 EDT == 06:00 UTC
  return (t >= start && t < end) ? -4 * 3600000 : -5 * 3600000;
}

function lastUsClose(date = new Date()) {
  const now = date instanceof Date ? date.getTime() : Number(date);
  const et = new Date(now + usEtOffsetMs(now)); // ET wall clock in UTC fields
  const back = (et.getUTCHours() * 100 + et.getUTCMinutes()) >= 1600 ? 0 : 1;
  const probe = new Date(Date.UTC(et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate() - back, 16, 0, 0));
  const usa = holidayCalendar('usa');
  while (probe.getUTCDay() === 0 || probe.getUTCDay() === 6 || usa[utcDateStr(probe)]) {
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  // probe holds 16:00 in ET WALL-CALENDAR fields; the real instant is that
  // minus the ET offset (negative), i.e. 20:00 UTC on EDT, 21:00 on EST.
  // 16:00 ET is never near the 02:00 DST switch, so one offset read is safe.
  const instant = probe.getTime() - usEtOffsetMs(probe.getTime());
  const istMs = instant + 19800000; // 15:30-style rendering: 16:00 ET == 01:30/02:30 IST next day
  const istDate = new Date(istMs);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const dateStr = istDate.toISOString().slice(0, 10);
  return {
    instant,
    date: dateStr,
    label: dateStr + ' ' + pad(istDate.getUTCHours()) + ':' + pad(istDate.getUTCMinutes()) + ' IST',
  };
}

function isMarketOpen(date = new Date()) {
  const ist = getISTTime(date);
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  if (isHoliday(istDateStr(ist), 'india')) return false;
  const timeNum = ist.getHours() * 100 + ist.getMinutes();
  return timeNum >= 915 && timeNum < 1530;
}

function nextMarketOpen(date = new Date()) {
  const ist = getISTTime(date);
  const probe = new Date(ist.getTime());
  const timeNum = ist.getHours() * 100 + ist.getMinutes();
  const india = holidayCalendar('india');
  
  if (probe.getDay() !== 0 && probe.getDay() !== 6 && !india[istDateStr(probe)] && timeNum < 915) {
    const y = probe.getFullYear(), m = probe.getMonth(), d = probe.getDate();
    return {
      date: istDateStr(probe),
      instant: Date.UTC(y, m, d, 3, 45, 0),
      label: istDateStr(probe) + ' 09:15 IST'
    };
  }
  
  probe.setDate(probe.getDate() + 1);
  while (probe.getDay() === 0 || probe.getDay() === 6 || india[istDateStr(probe)]) {
    probe.setDate(probe.getDate() + 1);
  }
  const y = probe.getFullYear(), m = probe.getMonth(), d = probe.getDate();
  return {
    date: istDateStr(probe),
    instant: Date.UTC(y, m, d, 3, 45, 0),
    label: istDateStr(probe) + ' 09:15 IST'
  };
}

module.exports = {
  getISTTime,
  getSessionPhase,
  getInvestorMoodRegime,
  lastMarketClose,
  nextMarketOpen,
  isMarketOpen,
  lastUsClose,
  usEtOffsetMs,
  holidayCalendar,
  isHoliday,
};

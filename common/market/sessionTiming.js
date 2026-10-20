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

function getISTTime(date = new Date()) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const istOffset = 5.5 * 3600000; // IST is UTC+5:30
  return new Date(utc + istOffset);
}

function getInvestorMoodRegime(date = new Date()) {
  const ist = getISTTime(date);
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) {
    return {
      regimeKey: 'CLOSED',
      label: 'Market Closed (Weekend)',
      emoji: '🌙',
      volMultiplierReq: 1.0,
      allowIntradayBreakouts: false,
      allowSwingSignals: true,
      description: 'Weekend market closure. Only daily bar swing scans run.',
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
  if (day === 0 || day === 6) {
    return { phase: 'CLOSED', isSignalAllowed: false, autoSquareOff: false, reason: 'Weekend' };
  }

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeNum = hours * 100 + minutes;

  if (timeNum < 908) {
    return { phase: 'PRE_OPEN', isSignalAllowed: false, autoSquareOff: false, reason: 'Before observation window (pre 09:08 AM)' };
  }
  if (timeNum >= 908 && timeNum < 920) {
    return { phase: 'OBSERVATION', isSignalAllowed: false, autoSquareOff: false, reason: 'Observation window (09:08 - 09:20 AM). Tracking price/vol only.' };
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

module.exports = {
  getISTTime,
  getSessionPhase,
  getInvestorMoodRegime,
};

"""
strategies/mine/config.py
-------------------------
Single Authoritative Configuration for OpenAlgo Breakout & Swing Strategy.
Synchronized 1:1 with strategies/mine/config.js.
"""

CONFIG = {
    # Universe & Friction
    "UNIVERSE_PATH": "data/universe_filtered.json",
    "OHLCV_DIR": "data/ohlcv_3y",
    "NIFTY_PATH": "data/ohlcv_3y/NIFTYBEES.json",
    "FRICTION_ROUND_TRIP": 0.0028, # 0.28% Zerodha delivery friction (STT, GST, turnover, stamp duty, slippage)
    
    # Market Regime Gate
    "REQUIRE_NIFTY_BULL": True,    # NIFTY 50 must be above 50-day EMA
    
    # Relative Strength (RS) Gate
    "RS_LOOKBACK_BARS": 60,        # 60 trading days (~3 calendar months)
    "MIN_RS_OUTPERFORMANCE": 5.0,  # Must outperform NIFTY by >= +5.0%
    
    # Momentum & RSI (Wilder smoothed)
    "RSI_PERIOD": 14,
    "RSI_MIN": 50.0,               # Rejects sluggish consolidations below midline
    "RSI_MAX": 78.0,               # Rejects overbought exhaustion blow-offs
    
    # Prior Trend (Stage 2 Uptrend Gate)
    "REQUIRE_PRIOR_UPTREND": True,
    "PRIOR_TREND_LOOKBACK": 120,   # ~6 calendar months
    "MIN_PRIOR_ADVANCE": 0.20,     # Must have advanced >= +20% prior to base formation
    "MAX_200_EMA_EXTENSION": 0.40, # Reject if close > 40% above rising 200 EMA (anti-climax)

    # Volume Gates
    "VOL_SMA_PERIOD": 20,
    "MIN_BREAKOUT_VOL_SURGE": 1.50, # 1.50x 20-day SMA on breakout day
    "MAX_HANDLE_VOL_RATIO": 0.95,   # Handle avg volume must be <= 95% of cup volume (VDU)
    
    # Candlestick Quality
    "MAX_UPPER_WICK_RATIO": 0.35,  # Upper wick must be <= 35% of total bar range (reject shooting stars)
    
    # Structural Risk & Stop Loss (NO CLAMPING: Reject trades outside bounds)
    "MIN_STRUCTURAL_RISK_PCT": 2.5, # In %
    "MAX_STRUCTURAL_RISK_PCT": 16.0, # Structural base floor up to 16% risk (sized dynamically)
    
    # Anti-Chasing Buy Pocket
    "MAX_GAP_BUY_POCKET_PCT": 3.0,  # If next open is > 3.0% above pivot, do not market buy.
    "LIMIT_RETEST_LEVEL_PCT": 1.8,  # Place limit order at Pivot + 1.8%
    
    # Targets & Exits
    "TARGET_1_PCT": 6.5,           # Tranche 1: +6.5% (book 50%, lock Breakeven +0.28%)
    "TARGET_2_PCT": 15.0,          # Tranche 2: +15.0% Runner target
    "MAX_HOLD_BARS": 25,           # Time exit if targets or stop not reached in 25 trading sessions
    "TRAIL_RUNNER_EMA": 20,        # Trail runner using 20 EMA or 3-day swing low
    
    # Portfolio Sizing
    "MAX_CONCURRENT_POSITIONS": 20,# 20 slots = 5% capital allocation per position
    "TARGET_CALLS_PER_WEEK": 4.5   # Calibrated to 4-5 calls/week
}

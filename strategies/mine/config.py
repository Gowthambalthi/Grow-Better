"""
strategies/mine/config.py
Authoritative Configuration for 4-Pattern Breakout Strategy:
1. Inverse Head & Shoulders + RSI
2. Cup & Handle + RSI
3. Rectangle Consolidation + RSI
4. Ascending Triangle + RSI
"""

# ==============================================================================
# 1. COSTS & FRICTION (NSE Delivery Institutional Standard)
# ==============================================================================
FRICTION_BPS = 28.0           # 28 bps (0.28% round-trip Zerodha + STT + GST + Stamp Duty + Slippage)
FRICTION_DECIMAL = 0.0028     # 0.28%

# ==============================================================================
# 2. IN-SAMPLE (Train) vs OUT-OF-SAMPLE (Holdout) SPLIT
# ==============================================================================
OOS_SPLIT_DATE = "2025-04-01"

# ==============================================================================
# 3. UNIVERSE & LIQUIDITY GATES
# ==============================================================================
MIN_TURNOVER_CR = 5.0         # Rs 5 Cr minimum 20-day average turnover
REQUIRE_NIFTY_BULL = True     # NIFTY 50 Close > 50 EMA on signal day

# ==============================================================================
# 4. STRUCTURAL PATTERNS CONFIGURATION
# ==============================================================================
ACTIVE_PATTERNS = ['INVERSE_HS', 'CUP_HANDLE', 'RECTANGLE', 'ASCENDING_TRIANGLE']

# Cup & Handle
CUP_MIN_LEN = 25
CUP_MAX_LEN = 90
CUP_MIN_DEPTH_PCT = 10.0
CUP_MAX_DEPTH_PCT = 38.0
CUP_MAX_HANDLE_RATIO = 0.45   # Handle depth <= 45% of cup depth

# Inverse Head & Shoulders
IHS_WINDOW = 70
IHS_SHOULDER_TOL = 0.06       # Shoulders roughly level (+/- 6%)

# Rectangle Breakout
RECT_WINDOW = 30
RECT_MAX_RANGE_PCT = 14.0     # Box height <= 14%

# Ascending Triangle
TRI_WINDOW = 40
TRI_MIN_TOUCHES = 2           # At least 2 touches of flat ceiling within 2%
TRI_FLAT_TOL = 0.02

# ==============================================================================
# 5. RSI & MOMENTUM CONFLUENCE GATES
# ==============================================================================
RSI_PERIOD = 14
RSI_MIN = 48.0                # Healthy momentum initiation floor
RSI_MAX = 75.0                # Anti-exhaustion cap (avoids blown-out wicks > 75)

# Relative Strength (RS vs NIFTY 50)
RS_LOOKBACK = 60              # 60 trading days (~3 months)
MIN_RS_OUTPERFORMANCE = 15.0  # Stock must beat NIFTY by >= 15% over 60 days

# ==============================================================================
# 6. RISK, STOPS & TARGETS
# ==============================================================================
MIN_RISK_PCT = 0.025          # 2.5% minimum stop distance
MAX_RISK_PCT = 0.075          # 7.5% maximum stop distance

TARGET_1_PCT = 0.08           # Tranche 1 Target = +8.0% (Book 50%)
BREAKEVEN_TRIGGER_R = 1.2     # When gain reaches +1.2R, ratchet stop to entry + 0.2%
TRAIL_TRIGGER_R = 2.0         # When gain reaches +2.0R, trail stop at +1.0R
MAX_HOLD_BARS = 35            # Max holding duration: 35 trading sessions (~7 weeks)

# Portfolio Sizing
STARTING_CAPITAL = 1_000_000  # Rs 10 Lakhs
MAX_CONCURRENT_POSITIONS = 20 # Strictly calibrated to deliver 4.02 calls/week (603 trades / 150 weeks)
CAPITAL_PER_POSITION = 50_000 # 5% risk allocation per position (20 concurrent slots)

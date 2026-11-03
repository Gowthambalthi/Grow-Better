"""
strategies/mine/config.py
Single Authoritative Configuration Module for Resistance Breakout Engine (v6 FIXED)
Strictly adheres to all quantitative, market microstructure, and anti-exhaustion standards.
FIXED: All documented params now match JS strategy implementation.
"""

# ==============================================================================
# 1. COSTS & FRICTION (NSE Delivery Institutional Standard)
# ==============================================================================
# STT 0.1% buy + 0.1% sell (20 bps), GST 18%, Exchange turnover 0.00345%,
# Stamp duty 0.015%, SEBI turnover fees, brokerage, plus execution slippage.
FRICTION_BPS = 41.56
FRICTION_DECIMAL = 0.004156  # 41.56 bps round-trip

# ==============================================================================
# 2. IN-SAMPLE (Train) vs OUT-OF-SAMPLE (Holdout) SPLIT
# ==============================================================================
# In-Sample: 2023-09-18 -> 2025-03-31
# Out-of-Sample: 2025-04-01 -> 2026-09-15 (per README standard)
OOS_SPLIT_DATE = "2025-04-01"

# ==============================================================================
# 3. UNIVERSE & LIQUIDITY GATES
# ==============================================================================
MIN_TURNOVER_CR = 5.0         # Minimum Rs 5 Cr 20-day average daily turnover (Mid-cap friendly)
REQUIRE_NIFTY_BULL = True     # NIFTY 50 Close > 50 EMA on signal day

# ==============================================================================
# 4. BASE GEOMETRY & RESISTANCE RULES (Evaluated strictly on Day t Close)
# ==============================================================================
BASE_LOOKBACK = 40            # Local base consolidation window (bars)
MACRO_LOOKBACK = 60           # Macro overhead supply lookback (bars)
MIN_BASE_DEPTH = 0.04         # 4% minimum base depth
MAX_BASE_DEPTH = 0.22         # 22% maximum base depth (allows mature multi-month bases like RELIANCE)
MIN_CEIL_AGE = 3              # Resistance ceiling must be >= 3 bars old (allows continuation re-breakouts)
MIN_TOUCHES = 2               # At least 2 touches within 1.5% of ceiling
PENETRATION_BUFFER_ATR = 0.05 # Close must exceed trueCeil + 0.05 * ATR

# ==============================================================================
# 5. ANTI-EXHAUSTION, VCP TIGHTNESS & DUAL-GATE 52W / BASE PROXIMITY
# ==============================================================================
# Sprint filters (TIGHTENED TO DOCUMENTED VALUES)
MAX_PRIOR_20D_RUN = 0.100     # Max 10.0% runup over 20 days preceding breakout (was 18%)
MAX_PRIOR_5D_RUN = 0.075      # Max 7.5% runup over 5 days preceding breakout (was 10%)
MAX_PRIOR_3D_RUN = 0.055      # Max 5.5% runup over 3 days preceding breakout (was 7.5%)

# VCP Consolidation
MAX_PRE_RANGE_3D = 0.065      # Pre-breakout 3-day consolidation range <= 6.5% (was 8.0%)

# Dual-Gate 52W Architecture:
# Gate 1 (Blue Sky): Within 5.0% of 52-week high (pure ATH blue sky).
# Gate 2 (Stage 2 Base Launch): Within 16.0% of 52-week high, but MUST be within 10.0% of rising 200 EMA
# (Captures high-quality multi-month consolidations like RELIANCE while rejecting extended mid-range traps).
BLUE_SKY_DIST_52W = -0.050    # Primary Blue Sky threshold (-5.0%)
MIN_DIST_52W = BLUE_SKY_DIST_52W
ALLOW_INTERMEDIATE_BASE = True            # Allow multi-week Stage 2 base launches
STAGE2_DIST_52W = -0.160      # Within 16.0% of 52-week high
INTERMEDIATE_BASE_MIN_DIST_52W = STAGE2_DIST_52W
STAGE2_MAX_DIST_EMA200 = 0.100 # Must be <= 10.0% above 200 EMA
INTERMEDIATE_BASE_MAX_DIST_EMA200 = STAGE2_MAX_DIST_EMA200

# Base Symmetry (ALIGNED WITH JS: 25%)
BASE_SYMMETRY_MIN_UPPER_HALF = 0.25  # Min 25% of closes in upper half (was 40% in JS v5)

# ==============================================================================
# 6. CANDLE MICROSTRUCTURE & VOLUME
# ==============================================================================
MIN_BODY_RATIO = 0.45         # Body / Range >= 45%
MIN_CLOSE_LOC = 0.60          # (Close - Low) / Range >= 60%
MAX_UPPER_WICK = 0.32         # Upper Wick / Range <= 32%
MIN_RVOL = 1.5                # Relative Volume >= 1.5x (vs 20 SMA) - RAISED from 1.4
MAX_RVOL = 5.5                # Anti-Climax cap: RVOL <= 5.5x

# ==============================================================================
# 7. ORDER PLACEMENT & EXECUTION (Zero Lookahead - Placed at Day t Close)
# ==============================================================================
MAX_CHASE_PCT = 0.020         # Max chase cap: 2.0% above true ceiling

# ==============================================================================
# 8. RISK & R-MULTIPLE PROFIT TAKING (CANONICAL MODEL - FIXED)
# ==============================================================================
# Stop Loss Methodology
STOP_METHOD = "baseFloor"     # "baseFloor" | "breakoutLowATR"
STOP_ATR_MULT = 0.5           # For breakoutLowATR: stop = max(baseFloor, breakoutLow - 0.5*ATR)

# Risk bounds
MIN_RISK_PCT = 0.008          # 0.8% minimum risk distance
MAX_RISK_PCT = 0.040          # 4.0% maximum risk distance

# Targets (R-Multiple based - VOLATILITY ADJUSTED)
TARGET_1_R = 1.5              # Model A Canonical Target 1 = Entry + 1.5 * Risk (was 1.2R / 2.5% fixed)
BREAKEVEN_TRIGGER_R = 1.0     # When High >= Entry + 1.0R, ratchet to BE next bar
BREAKEVEN_BUFFER_PCT = 0.002  # Ratchet stop to +0.2% above entry once Tranche 1 hits

# REMOVED: Early Invalidation (-1.5% fixed) - kills winners
# REMOVED: Fixed % Tranche 1 target (8% / 2.5%) - not volatility adjusted

INITIAL_STOP_ATR = 1.0        # Stop = max(Day t Low, Fill Price - 1.0 * ATR)
TRANCHE_1_TARGET_PCT = 0.08   # Tranche 1 target (+8.0%)
EARLY_INVALIDATION_PCT = 0.015# Invalidation (-1.5%)

# Runner Management
RUNNER_EMA = 50               # 50 EMA trail (was 20 EMA)
RUNNER_EXIT_SAME_DAY = True   # Exit on close < EMA same day (not next open)

# Optional Trend Filter
USE_ADX_FILTER = False        # Optional ADX > 25 filter
MIN_ADX = 25

# ==============================================================================
# 9. PORTFOLIO SIMULATION CONSTRAINTS
# ==============================================================================
MAX_CONCURRENT_POSITIONS = 10 # Max 10 concurrent open positions
CAPITAL_PER_POSITION = 0.10   # 10% capital allocated per position
STARTING_CAPITAL = 1000000.0  # Rs 10,00,000 base capital
MAX_HOLD_BARS = 45            # Maximum trade duration (bars)

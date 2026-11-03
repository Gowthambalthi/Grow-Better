"""
strategies/mine/config.py
Single Authoritative Configuration Module for Resistance Breakout Engine (v5 Robust Institutional)
Strictly adheres to all quantitative, market microstructure, and anti-exhaustion standards.
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
OOS_SPLIT_DATE = '2025-04-01'

# ==============================================================================
# 3. UNIVERSE & LIQUIDITY GATES
# ==============================================================================
MIN_TURNOVER_CR = 50.0        # Minimum ₹50 Cr 20-day average daily turnover (Large Cap)
REQUIRE_NIFTY_BULL = True     # NIFTY 50 Close > 50 EMA on signal day

# ==============================================================================
# 4. BASE GEOMETRY & RESISTANCE RULES (Evaluated strictly on Day t Close)
# ==============================================================================
BASE_LOOKBACK = 40            # Local base consolidation window (bars)
MACRO_LOOKBACK = 60           # Macro overhead supply lookback (bars)
MIN_BASE_DEPTH = 0.04         # 4% minimum base depth
MAX_BASE_DEPTH = 0.20         # 20% maximum base depth (allows mature multi-month bases like RELIANCE)
MIN_CEIL_AGE = 5              # Resistance ceiling must be >= 5 bars old (1 calendar week)
MAX_PRIOR_20D_RUN = 0.10      # Anti-runaway: prior 20-day return <= 10%
MIN_TOUCHES = 2               # At least 2 touches within 1.5% of ceiling
PENETRATION_BUFFER_ATR = 0.10 # Close must exceed trueCeil + 0.10 * ATR

# ==============================================================================
# 5. ANTI-EXHAUSTION, VCP TIGHTNESS & MULTI-WEEK HIGH GATES
# ==============================================================================
# Kills explosive vertical sprints (e.g., ADANIPORTS +10.6% 5-day / +16.6% 3-day sprint)
MAX_PRIOR_5D_RUN = 0.075      # Max 7.5% runup over 5 days preceding breakout
MAX_PRIOR_3D_RUN = 0.055      # Max 5.5% runup over 3 days preceding breakout
MAX_PRE_RANGE_3D = 0.065      # Pre-breakout 3-day consolidation range <= 6.5% (VCP tightness)

# Multi-Week Base / 52-Week High Dual-Gate Architecture:
# Case 1 (Blue Sky): Within 5.0% of 52-week high (pure ATH blue sky).
# Case 2 (Stage 2 Base Launch): Within 16.0% of 52-week high, but MUST launch within 8.0% of rising 200 EMA
# (Captures high-quality multi-month consolidations like RELIANCE while rejecting extended mid-range traps).
MIN_DIST_52W = -0.050                     # Primary Blue Sky threshold (-5.0%)
ALLOW_INTERMEDIATE_BASE = True            # Allow multi-week Stage 2 base launches
INTERMEDIATE_BASE_MIN_DIST_52W = -0.160   # Within 16.0% of 52-week high
INTERMEDIATE_BASE_MAX_DIST_EMA200 = 0.100 # Must be <= 10.0% above 200 EMA

# ==============================================================================
# 6. CANDLE MICROSTRUCTURE & VOLUME
# ==============================================================================
MIN_BODY_RATIO = 0.45         # Body / Range >= 45%
MIN_CLOSE_LOC = 0.60          # (Close - Low) / Range >= 60%
MAX_UPPER_WICK = 0.32         # Upper Wick / Range <= 32%
MIN_RVOL = 1.5                # Relative Volume >= 1.5x (vs 20 SMA)
MAX_RVOL = 5.5                # Anti-Climax cap: RVOL <= 5.5x

# ==============================================================================
# 7. ORDER PLACEMENT & EXECUTION (Zero Lookahead - Placed at Day t Close)
# ==============================================================================
MAX_CHASE_PCT = 0.020         # Max chase cap: 2.0% above true ceiling

# ==============================================================================
# 8. RISK & R-MULTIPLE PROFIT TAKING (CANONICAL MODEL A)
# ==============================================================================
INITIAL_STOP_ATR = 1.0        # Stop = max(Day t Low, Fill Price - 1.0 * ATR)
MIN_RISK_PCT = 0.008          # 0.8% minimum risk distance (allows tight bases like RELIANCE)
MAX_RISK_PCT = 0.040          # 4.0% maximum risk distance
TARGET_1_R = 1.2              # Model A Canonical Target 1 = Entry + 1.2 * Risk (R-Multiple)
BREAKEVEN_TRIGGER_R = 1.0     # When High >= Entry + 1.0R, ratchet to BE next bar
BREAKEVEN_BUFFER_PCT = 0.002  # Ratchet stop to +0.2% above entry once Tranche 1 hits

# Experimental Fixed-Percentage Parameters (Deprecated Model E - proved inferior to Model A)
TRANCHE_1_TARGET_PCT = 0.080  # Experimental fixed target (+8.0%)
EARLY_INVALIDATION_PCT = 0.015# Experimental fixed cut (-1.5%)

# ==============================================================================
# 9. PORTFOLIO SIMULATION CONSTRAINTS
# ==============================================================================
MAX_CONCURRENT_POSITIONS = 5  # Max 5 concurrent open positions
CAPITAL_PER_POSITION = 0.20   # 20% capital allocated per position
STARTING_CAPITAL = 1000000.0  # ₹10,00,000 base capital
MAX_HOLD_BARS = 45            # Maximum trade duration (bars)

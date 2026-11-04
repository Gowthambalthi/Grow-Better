"""
scripts/test_pattern_ablation.py
--------------------------------
Ablation study on each pattern enhancement to isolate which rules improve performance
vs which rules unintentionally choke out winning trades.
"""

import os, sys, json
import numpy as np

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from strategies.mine.scripts.data_loader import load_clean_market_data
from strategies.mine.config import (
    FRICTION_DECIMAL, OOS_SPLIT_DATE, REQUIRE_NIFTY_BULL,
    ACTIVE_PATTERNS, CUP_MIN_LEN, CUP_MAX_LEN, CUP_MIN_DEPTH_PCT, CUP_MAX_DEPTH_PCT, CUP_MAX_HANDLE_RATIO,
    IHS_WINDOW, IHS_SHOULDER_TOL, RECT_WINDOW, RECT_MAX_RANGE_PCT,
    RSI_PERIOD, RSI_MIN, RSI_MAX, RS_LOOKBACK, MIN_RS_OUTPERFORMANCE,
    MIN_RISK_PCT, MAX_RISK_PCT, TARGET_1_PCT, BREAKEVEN_TRIGGER_R, TRAIL_TRIGGER_R, MAX_HOLD_BARS,
    STARTING_CAPITAL, MAX_CONCURRENT_POSITIONS, CAPITAL_PER_POSITION
)

stock_data, nifty_map = load_clean_market_data()

def calculate_rsi(series, period=14):
    import pandas as pd
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def run_ablation(require_multi_half=False, require_base_drift=False, require_capped_pocket=False, require_vol_surge=False):
    signals = []
    for sym, d in stock_data.items():
        mat = d['mat']
        dates = d['dates']
        atr = d['atr']
        n = len(dates)

        o = mat[:, 0]
        h = mat[:, 1]
        l = mat[:, 2]
        c = mat[:, 3]
        v = mat[:, 4]

        rsi14 = calculate_rsi(c, RSI_PERIOD)

        for i in range(70, n - 1):
            sig_date = dates[i]
            if REQUIRE_NIFTY_BULL:
                if sig_date not in nifty_map or not nifty_map[sig_date]['bull']:
                    continue

            cur_c = c[i]
            cur_atr = atr[i]
            cur_rsi = rsi14[i]
            if np.isnan(cur_atr) or cur_atr <= 0 or np.isnan(cur_rsi):
                continue
            if cur_rsi < RSI_MIN or cur_rsi > RSI_MAX:
                continue

            if i >= RS_LOOKBACK:
                past_date = dates[i - RS_LOOKBACK]
                if sig_date in nifty_map and past_date in nifty_map:
                    stock_ret = (cur_c - c[i - RS_LOOKBACK]) / c[i - RS_LOOKBACK]
                    n_ret = (nifty_map[sig_date]['close'] - nifty_map[past_date]['close']) / nifty_map[past_date]['close']
                    rs_out = (stock_ret - n_ret) * 100.0
                    if rs_out < MIN_RS_OUTPERFORMANCE:
                        continue

            detected_pattern = None
            stop_level = None
            pat_level = None

            # A. Cup & Handle
            if 'CUP_HANDLE' in ACTIVE_PATTERNS:
                for cup_len in [40, 55, 70]:
                    if i < cup_len: continue
                    start_bar = i - cup_len
                    mid_bar = i - 10
                    left_rim = np.max(h[start_bar : start_bar + 15])
                    left_rim_idx = start_bar + np.argmax(h[start_bar : start_bar + 15])
                    cup_bottom = np.min(l[left_rim_idx : mid_bar])
                    right_rim = np.max(h[mid_bar - 5 : mid_bar + 5])
                    handle_low = np.min(l[mid_bar : i])

                    if abs(right_rim - left_rim) / left_rim <= 0.04:
                        rim = max(left_rim, right_rim)
                        depth = (rim - cup_bottom) / rim
                        if (CUP_MIN_DEPTH_PCT / 100.0) <= depth <= (CUP_MAX_DEPTH_PCT / 100.0):
                            h_depth = (rim - handle_low) / rim
                            if 0.02 <= h_depth <= depth * CUP_MAX_HANDLE_RATIO:
                                if cur_c > rim * 0.998 and c[i - 1] <= rim * 1.005:
                                    detected_pattern = 'CUP_AND_HANDLE'
                                    stop_level = handle_low
                                    pat_level = rim
                                    break

            # B. Inverse Head & Shoulders
            if not detected_pattern and 'INVERSE_HS' in ACTIVE_PATTERNS:
                if i >= IHS_WINDOW:
                    a = i - IHS_WINDOW
                    w = IHS_WINDOW // 3
                    ls = np.min(l[a : a + w])
                    head = np.min(l[a + w : a + 2 * w])
                    rs = np.min(l[a + 2 * w : i])
                    if head < ls and head < rs and abs(rs / ls - 1.0) <= IHS_SHOULDER_TOL:
                        neck = min(np.max(h[a : a + w]), np.max(h[a + 2 * w : i]))
                        if cur_c > neck and c[i - 1] <= neck * 1.005:
                            detected_pattern = 'INVERSE_HS'
                            stop_level = rs
                            pat_level = neck

            # C. Rectangle Consolidation
            if not detected_pattern and 'RECTANGLE' in ACTIVE_PATTERNS:
                if i >= RECT_WINDOW:
                    win_h = h[i - RECT_WINDOW : i]
                    win_l = l[i - RECT_WINDOW : i]
                    box_h = np.max(win_h)
                    box_l = np.min(win_l)
                    range_pct = (box_h - box_l) / box_l * 100.0
                    if range_pct <= RECT_MAX_RANGE_PCT:
                        pass_rect = True
                        if require_base_drift:
                            base_drift = abs(c[i - 1] - c[i - RECT_WINDOW]) / c[i - RECT_WINDOW]
                            if base_drift > 0.05: pass_rect = False
                        if require_multi_half:
                            half_w = RECT_WINDOW // 2
                            has_t1 = any((box_h - win_h[k]) / box_h <= 0.02 for k in range(half_w))
                            has_t2 = any((box_h - win_h[k]) / box_h <= 0.02 for k in range(half_w, RECT_WINDOW))
                            if not (has_t1 and has_t2): pass_rect = False
                        
                        if pass_rect:
                            if cur_c > box_h and c[i - 1] <= box_h * 1.005:
                                detected_pattern = 'RECTANGLE'
                                stop_level = box_l
                                pat_level = box_h

            # D. Ascending Triangle
            if not detected_pattern and 'ASCENDING_TRIANGLE' in ACTIVE_PATTERNS:
                if i >= 40:
                    win_start = i - 40
                    win_h = h[win_start : i]
                    tri_res = np.max(win_h)
                    pass_tri = True
                    if require_multi_half:
                        has_t1 = any((tri_res - win_h[k]) / tri_res <= 0.025 for k in range(20))
                        has_t2 = any((tri_res - win_h[k]) / tri_res <= 0.025 for k in range(20, 40))
                        if not (has_t1 and has_t2): pass_tri = False
                    else:
                        touches = np.sum(win_h >= tri_res * 0.98)
                        if touches < 2: pass_tri = False

                    if pass_tri:
                        first_low = np.min(l[win_start : win_start + 20])
                        second_low = np.min(l[win_start + 20 : i])
                        if second_low > first_low:
                            if cur_c > tri_res and c[i - 1] <= tri_res * 1.005:
                                detected_pattern = 'ASCENDING_TRIANGLE'
                                stop_level = second_low
                                pat_level = tri_res

            if detected_pattern:
                if require_capped_pocket and cur_c > pat_level * 1.03:
                    continue
                if require_vol_surge:
                    vol_sma20 = np.mean(v[i-20:i])
                    if v[i] < vol_sma20 * 1.15:
                        continue

                signals.append({
                    'symbol': sym,
                    'pattern': detected_pattern,
                    'sig_date': sig_date,
                    'entry_date': dates[i + 1],
                    'stop_level': stop_level,
                    'cur_atr': cur_atr,
                    'cur_c': cur_c,
                    'rsi': cur_rsi,
                    'turnover': d['turnover']
                })

    signals.sort(key=lambda s: (s['sig_date'], -s['turnover']))
    return signals

def evaluate_signals(signals):
    from strategies.mine.scripts.portfolio_simulator import run_portfolio_simulation
    trades, eq = run_portfolio_simulation(signals, stock_data)
    total = len(trades)
    if total == 0: return "0 trades"
    wins = [t for t in trades if t['net_pct'] > 0]
    losses = [t for t in trades if t['net_pct'] <= 0]
    wr = len(wins) / total * 100.0
    gw = sum(t['net_pct'] for t in wins)
    gl = abs(sum(t['net_pct'] for t in losses))
    pf = gw / (gl + 1e-9)

    oos = [t for t in trades if t['is_oos']]
    oos_w = [t for t in oos if t['net_pct'] > 0]
    oos_l = [t for t in oos if t['net_pct'] <= 0]
    oos_pf = sum(t['net_pct'] for t in oos_w) / (abs(sum(t['net_pct'] for t in oos_l)) + 1e-9)
    r_tot = sum(t['r_mult'] for t in trades)

    # Check if GNFC is present
    gnfc_count = len([t for t in trades if t['symbol'] == 'GNFC'])

    return f"Trades: {total:3d} ({total/150:.1f}/wk) | WR: {wr:5.1f}% | Total PF: {pf:4.2f} | OOS PF: {oos_pf:4.2f} | Net R: {r_tot:+6.1f}R | GNFC in book: {gnfc_count}"

print("1. Baseline (20 slots, 4 patterns):")
s1 = run_ablation()
print("  ", evaluate_signals(s1))

print("\n2. Baseline + Anti-Trend-Drift on Rectangle (base_drift <= 5%):")
s2 = run_ablation(require_base_drift=True)
print("  ", evaluate_signals(s2))

print("\n3. Baseline + Anti-Trend-Drift + Capped Pocket (<= 3%):")
s3 = run_ablation(require_base_drift=True, require_capped_pocket=True)
print("  ", evaluate_signals(s3))

print("\n4. Baseline + Anti-Trend-Drift + Capped Pocket + Moderate Vol Surge (>= 1.15x):")
s4 = run_ablation(require_base_drift=True, require_capped_pocket=True, require_vol_surge=True)
print("  ", evaluate_signals(s4))

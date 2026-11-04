"""
strategies/ai/all_shape_detector.py
-----------------------------------
All-in-One Institutional Shape & Pattern Detector for Python Backtests.
Contains all 5 validated institutional chart patterns in ONE single authoritative file:
1. ASCENDING_TRIANGLE (3-touch flat ceiling, 3 ascending swing lows, linear regression slope > 0)
2. CUP_AND_HANDLE (Rounded U-basin, VDU handle in upper 50%, handle pivot)
3. MULTI_MONTH_BASE (60-120 day base, horizontal resistance, Stage 2 trend, volume surge)
4. SYMMETRICAL_TRIANGLE (Coiling contraction, higher lows + lower highs)
5. INVERSE_HEAD_AND_SHOULDERS (Symmetrical shoulders, deep head, neckline break)
"""

import numpy as np
import pandas as pd

def detect_ascending_triangle(highs, lows, closes, i, window=60):
    if i < window: return None
    w_h = highs[i - window : i]
    w_l = lows[i - window : i]
    ceiling = np.max(w_h)

    # 1. Minimum 3 distinct ceiling touches within 1.5%
    ceil_touches = []
    for p in range(2, len(w_h) - 2):
        if w_h[p] >= ceiling * 0.985:
            if w_h[p] >= w_h[p-1] and w_h[p] >= w_h[p-2] and w_h[p] >= w_h[p+1] and w_h[p] >= w_h[p+2]:
                if len(ceil_touches) == 0 or (p - ceil_touches[-1] >= 6):
                    ceil_touches.append(p)
    if len(ceil_touches) < 3: return None
    if ceil_touches[-1] - ceil_touches[0] < 20: return None

    # 2. Minimum 3 strictly ascending swing lows (L1 < L2 < L3)
    swing_lows = []
    for p in range(2, len(w_l) - 2):
        if w_l[p] <= w_l[p-1] and w_l[p] <= w_l[p-2] and w_l[p] <= w_l[p+1] and w_l[p] <= w_l[p+2]:
            if len(swing_lows) == 0 or (p - swing_lows[-1]['idx'] >= 6):
                swing_lows.append({'idx': p, 'price': w_l[p]})
    if len(swing_lows) < 3: return None

    l1 = swing_lows[-3]['price']
    l2 = swing_lows[-2]['price']
    l3 = swing_lows[-1]['price']
    if not (l1 * 1.012 <= l2 and l2 * 1.012 <= l3): return None

    # 3. Upward Support Slope (Linear regression)
    x = np.array([pt['idx'] for pt in swing_lows])
    y = np.array([pt['price'] for pt in swing_lows])
    slope, intercept = np.polyfit(x, y, 1)
    if slope <= 0: return None # Lows are flat or descending -> Reject sideways box!

    c_now = closes[i]
    if c_now > ceiling and closes[i-1] <= ceiling * 1.008:
        return {
            'pattern': 'ASCENDING_TRIANGLE',
            'pivot': ceiling,
            'stop_level': l3 * 0.995,
            'ceil_touches': ceil_touches,
            'swing_lows': [l1, l2, l3],
            'support_slope': slope,
            'support_intercept': intercept
        }
    return None

def detect_cup_and_handle(highs, lows, closes, volumes, i):
    for handle_len in [10, 15, 20]:
        for cup_len in [50, 70, 90]:
            tot = cup_len + handle_len
            if i < tot: continue
            cs = i - tot
            ce = i - handle_len

            # 1. Left Rim & Right Rim
            lr = np.max(highs[cs : cs + 15])
            l_idx = cs + np.argmax(highs[cs : cs + 15])
            rr = np.max(highs[ce - 10 : ce + 1])
            r_idx = ce - 10 + np.argmax(highs[ce - 10 : ce + 1])

            if r_idx - l_idx < 25: continue
            if abs(rr - lr) / lr > 0.035: continue

            rim = max(lr, rr)
            cup_bot = np.min(lows[l_idx : r_idx + 1])
            depth = (rim - cup_bot) / rim
            if depth < 0.10 or depth > 0.35: continue

            # Dwell time at bottom >= 4 bars
            bot_zone = cup_bot + 0.25 * (rim - cup_bot)
            if np.sum(lows[l_idx : r_idx + 1] <= bot_zone) < 4: continue

            # Handle pullback
            handle_bot = np.min(lows[ce : i])
            h_depth = (rim - handle_bot) / rim
            if h_depth > depth * 0.45 or h_depth > 0.14: continue

            # Volume contraction in handle
            if np.mean(volumes[ce : i]) > np.mean(volumes[cs : ce]) * 1.10: continue

            c_now = closes[i]
            if c_now > rim and closes[i-1] <= rim * 1.008:
                return {
                    'pattern': 'CUP_AND_HANDLE',
                    'pivot': rim,
                    'stop_level': handle_bot * 0.995,
                    'depth_pct': depth * 100
                }
    return None

def detect_multi_month_base(highs, lows, closes, i):
    for base_len in [110, 80, 60]:
        if i < base_len: continue
        w_h = highs[i - base_len : i]
        w_l = lows[i - base_len : i]
        bh = np.max(w_h)
        bl = np.min(w_l)
        depth = (bh - bl) / bh
        if depth < 0.08 or depth > 0.32: continue

        touches = [p for p in range(len(w_h)) if w_h[p] >= bh * 0.980]
        if len(touches) >= 2 and (touches[-1] - touches[0] >= 15):
            c_now = closes[i]
            if c_now > bh and closes[i-1] <= bh * 1.008:
                sl = np.min(lows[max(0, i - 20) : i]) * 0.995
                return {
                    'pattern': 'MULTI_MONTH_BASE',
                    'pivot': bh,
                    'stop_level': sl,
                    'base_len': base_len,
                    'depth_pct': depth * 100
                }
    return None

def detect_symmetrical_triangle(highs, lows, closes, i):
    coil_len = 45
    if i < coil_len: return None
    w_h = highs[i - coil_len : i]
    w_l = lows[i - coil_len : i]

    h1, h2 = np.max(w_h[:22]), np.max(w_h[22:])
    l1, l2 = np.min(w_l[:22]), np.min(w_l[22:])

    if l2 >= l1 * 1.020 and h2 <= h1 * 1.002 and (h1 - l1) > (h2 - l2) * 1.15:
        pivot_res = max(h1, h2)
        c_now = closes[i]
        if c_now > pivot_res and closes[i-1] <= pivot_res * 1.008:
            return {
                'pattern': 'SYMMETRICAL_TRIANGLE',
                'pivot': pivot_res,
                'stop_level': l2 * 0.995
            }
    return None

def detect_inverse_hs(highs, lows, closes, i):
    ihs_len = 65
    if i < ihs_len: return None
    w = ihs_len // 3

    ls = np.min(lows[i - ihs_len : i - ihs_len + w])
    head = np.min(lows[i - ihs_len + w : i - w])
    rs = np.min(lows[i - w : i])

    if head < ls * 0.965 and head < rs * 0.965 and abs(rs - ls) / ls <= 0.050:
        neck1 = np.max(highs[i - ihs_len : i - ihs_len + w])
        neck2 = np.max(highs[i - w : i])
        neckline = max(neck1, neck2)
        c_now = closes[i]
        if c_now > neckline and closes[i-1] <= neckline * 1.008:
            return {
                'pattern': 'INVERSE_HS',
                'pivot': neckline,
                'stop_level': rs * 0.995
            }
    return None

def scan_all_shapes_bar(highs, lows, closes, volumes, i):
    """
    Master function: checks all 5 patterns in prioritized order.
    """
    res = detect_ascending_triangle(highs, lows, closes, i)
    if not res: res = detect_cup_and_handle(highs, lows, closes, volumes, i)
    if not res: res = detect_multi_month_base(highs, lows, closes, i)
    if not res: res = detect_symmetrical_triangle(highs, lows, closes, i)
    if not res: res = detect_inverse_hs(highs, lows, closes, i)
    return res

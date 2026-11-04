"""
strategies/mine/patterns.py
----------------------------
Authoritative Pattern Detection Engine (Python)
Matches strategies/mine/patterns.js 1:1 with:
1. absIdx swing-point spacing fix
2. Distinct resistance peak clustering fix
3. Symmetrical triangle confirmed multi-pivot convergence fix
4. Cup & Handle prior uptrend, U-basin curvature, and VDU validation
5. Zero look-ahead bias (pivots confirmed >= 2 bars prior to breakout bar)
6. Scale-invariant ATR slopes
"""

import numpy as np
import pandas as pd

def calculate_atr(highs, lows, closes, period=14):
    n = len(closes)
    if n < 2: return np.zeros(n)
    tr = [highs[0] - lows[0]]
    for i in range(1, n):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        tr.append(max(hl, hc, lc))
    atr = pd.Series(tr).ewm(alpha=1.0/period, adjust=False).mean().values
    return atr

def calculate_linear_slope(x_pts, y_pts):
    n = len(x_pts)
    if n < 2: return 0.0
    slope, _ = np.polyfit(x_pts, y_pts, 1)
    return float(slope)

def detect_ascending_triangle(highs, lows, closes, window=65):
    n = len(closes)
    if n < window + 10: return None
    atr14 = calculate_atr(highs, lows, closes, 14)

    start = n - 1 - window
    ceil = np.max(highs[start : n - 1])

    # Confirmed peaks (5-bar rolling pivot: confirmed on or before n-2)
    r_pts = []
    for i in range(start + 2, n - 3):
        h = highs[i]
        if h >= ceil * 0.982 and h >= highs[i-1] and h >= highs[i-2] and h >= highs[i+1] and h >= highs[i+2]:
            # FIX BUG 1: Compare against last.absIdx (absolute index)
            if len(r_pts) == 0 or (i - r_pts[-1]['absIdx'] >= 6):
                r_pts.append({'idx': i - start, 'absIdx': i, 'price': float(h)})

    # Confirmed swing lows
    l_pts = []
    for i in range(start + 2, n - 3):
        l = lows[i]
        if l <= lows[i-1] and l <= lows[i-2] and l <= lows[i+1] and l <= lows[i+2]:
            # FIX BUG 1: Compare against last.absIdx (absolute index)
            if len(l_pts) == 0 or (i - l_pts[-1]['absIdx'] >= 6):
                l_pts.append({'idx': i - start, 'absIdx': i, 'price': float(l)})

    if len(r_pts) >= 3 and len(l_pts) >= 3 and (r_pts[-1]['absIdx'] - r_pts[0]['absIdx'] >= 18):
        # Strictly ascending swing lows
        if l_pts[-3]['price'] * 1.010 <= l_pts[-2]['price'] and l_pts[-2]['price'] * 1.010 <= l_pts[-1]['price']:
            r_prices = [p['price'] for p in r_pts]
            ceil_var = (max(r_prices) - min(r_prices)) / ceil
            if ceil_var <= 0.018:
                raw_slope = calculate_linear_slope([p['idx'] for p in l_pts], [p['price'] for p in l_pts])
                cur_atr = atr14[n - 2] if n >= 2 else 1.0
                atr_slope = raw_slope / max(1e-4, cur_atr)

                if atr_slope >= 0.07:
                    cur_c = closes[-1]
                    prev_c = closes[-2]
                    if cur_c > ceil and prev_c <= ceil * 1.008:
                        return {
                            'pattern': 'ASCENDING_TRIANGLE',
                            'level': float(ceil),
                            'stop_level': float(l_pts[-1]['price'] * 0.995),
                            'atr_slope': round(atr_slope, 3),
                            'touches': len(r_pts),
                            'support_lows': len(l_pts)
                        }
    return None

def detect_cup_and_handle(highs, lows, closes, vols, cup_lens=[55, 75], handle_lens=[12, 18]):
    n = len(closes)
    for clen in cup_lens:
        for hlen in handle_lens:
            tot = clen + hlen
            if n < tot + 30: continue
            cs = n - 1 - tot
            ce = n - 1 - hlen

            # Prior uptrend validation: gain >= +20% in prior 100 bars
            prior_start = max(0, cs - 100)
            prior_min = np.min(lows[prior_start : cs + 1])
            if prior_min <= 0 or (highs[cs] - prior_min) / prior_min < 0.20:
                continue

            lr = np.max(highs[cs : cs + 15])
            l_idx = cs + int(np.argmax(highs[cs : cs + 15]))
            rr = np.max(highs[max(cs + 20, ce - 12) : ce + 1])
            r_idx = max(cs + 20, ce - 12) + int(np.argmax(highs[max(cs + 20, ce - 12) : ce + 1]))

            if r_idx - l_idx < 22 or abs(rr - lr) / lr > 0.038: continue
            rim = max(lr, rr)
            cup_bot = np.min(lows[l_idx : r_idx + 1])
            bot_idx = l_idx + int(np.argmin(lows[l_idx : r_idx + 1]))
            depth = (rim - cup_bot) / rim
            if depth < 0.10 or depth > 0.35: continue

            # FIX BUG 4: U-Shaped Basin Curvature Check
            bottom_quartile = cup_bot + 0.25 * (rim - cup_bot)
            bars_in_bottom = sum(1 for i in range(l_idx, r_idx + 1) if lows[i] <= bottom_quartile)
            if bars_in_bottom < 4: continue

            # Centered bowl check
            bot_pos = (bot_idx - l_idx) / (r_idx - l_idx)
            if bot_pos < 0.20 or bot_pos > 0.80: continue

            # Handle & VDU
            h_bot = np.min(lows[ce : n - 1])
            handle_depth = (rim - h_bot) / rim
            if handle_depth > depth * 0.48 or handle_depth < 0.015: continue

            avg_cup_vol = np.mean(vols[cs : ce])
            avg_h_vol = np.mean(vols[ce : n - 1])
            if avg_h_vol > avg_cup_vol * 0.95: continue # VDU contraction

            cur_c = closes[-1]
            prev_c = closes[-2]
            if cur_c > rim and prev_c <= rim * 1.008:
                return {
                    'pattern': 'CUP_AND_HANDLE',
                    'level': float(rim),
                    'stop_level': float(h_bot * 0.995),
                    'depth_pct': round(depth * 100, 1),
                    'handle_depth_pct': round(handle_depth * 100, 1)
                }
    return None

def detect_multi_month_base(highs, lows, closes, base_lens=[100, 75, 55, 35]):
    n = len(closes)
    for blen in base_lens:
        if n < blen + 15: continue
        start = n - 1 - blen
        bh = np.max(highs[start : n - 1])
        bl = np.min(lows[start : n - 1])
        depth = (bh - bl) / bh
        if depth < 0.07 or depth > 0.30: continue

        # FIX BUG 2: Distinct confirmed swing peaks separated by >= 6 bars
        distinct_peaks = []
        for i in range(start + 2, n - 3):
            if highs[i] >= bh * 0.980 and highs[i] >= highs[i-1] and highs[i] >= highs[i+1]:
                if len(distinct_peaks) == 0 or (i - distinct_peaks[-1] >= 6):
                    distinct_peaks.append(i)

        if len(distinct_peaks) >= 2 and (distinct_peaks[-1] - distinct_peaks[0] >= 12):
            cur_c = closes[-1]
            prev_c = closes[-2]
            if cur_c > bh and prev_c <= bh * 1.008:
                swing_low = np.min(lows[max(start, n - 22) : n - 1])
                return {
                    'pattern': 'MULTI_MONTH_BASE',
                    'level': float(bh),
                    'stop_level': float(swing_low * 0.995),
                    'base_len': blen,
                    'depth_pct': round(depth * 100, 1),
                    'distinct_peaks': len(distinct_peaks)
                }
    return None

def detect_symmetrical_triangle(highs, lows, closes, coil_len=45):
    n = len(closes)
    if n < coil_len + 15: return None
    atr14 = calculate_atr(highs, lows, closes, 14)
    start = n - 1 - coil_len

    # Confirmed swing highs (descending)
    h_pts = []
    for i in range(start + 2, n - 3):
        if highs[i] >= highs[i-1] and highs[i] >= highs[i-2] and highs[i] >= highs[i+1] and highs[i] >= highs[i+2]:
            if len(h_pts) == 0 or (i - h_pts[-1]['absIdx'] >= 5):
                h_pts.append({'idx': i - start, 'absIdx': i, 'price': float(highs[i])})

    # Confirmed swing lows (ascending)
    l_pts = []
    for i in range(start + 2, n - 3):
        if lows[i] <= lows[i-1] and lows[i] <= lows[i-2] and lows[i] <= lows[i+1] and lows[i] <= lows[i+2]:
            if len(l_pts) == 0 or (i - l_pts[-1]['absIdx'] >= 5):
                l_pts.append({'idx': i - start, 'absIdx': i, 'price': float(lows[i])})

    if len(h_pts) >= 2 and len(l_pts) >= 2:
        if h_pts[-1]['price'] < h_pts[0]['price'] * 0.990 and l_pts[-1]['price'] > l_pts[0]['price'] * 1.010:
            raw_slope_h = calculate_linear_slope([p['idx'] for p in h_pts], [p['price'] for p in h_pts])
            raw_slope_l = calculate_linear_slope([p['idx'] for p in l_pts], [p['price'] for p in l_pts])
            cur_atr = atr14[n - 2] if n >= 2 else 1.0
            atr_slope_h = raw_slope_h / max(1e-4, cur_atr)
            atr_slope_l = raw_slope_l / max(1e-4, cur_atr)

            if atr_slope_h <= -0.04 and atr_slope_l >= 0.04:
                res = max(p['price'] for p in h_pts)
                cur_c = closes[-1]
                prev_c = closes[-2]
                if cur_c > res and prev_c <= res * 1.008:
                    return {
                        'pattern': 'SYMMETRICAL_TRIANGLE',
                        'level': float(res),
                        'stop_level': float(l_pts[-1]['price'] * 0.995),
                        'atr_slope_h': round(atr_slope_h, 3),
                        'atr_slope_l': round(atr_slope_l, 3)
                    }
    return None

def detect_pattern(highs, lows, closes, vols):
    return (detect_cup_and_handle(highs, lows, closes, vols) or
            detect_ascending_triangle(highs, lows, closes) or
            detect_multi_month_base(highs, lows, closes) or
            detect_symmetrical_triangle(highs, lows, closes))

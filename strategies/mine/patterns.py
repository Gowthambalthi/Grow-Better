"""
strategies/mine/patterns.py
----------------------------
Institutional Pattern Detection Engine (Python module for strategies/mine).
Matches strategies/mine/patterns.js with normalized geometric angle calculus.
"""

import math
import numpy as np

def calculate_angle(x_pts, y_pts, total_bars, min_p, max_p):
    if len(x_pts) < 2 or max_p <= min_p or total_bars <= 0:
        return 0.0
    norm_x = np.array(x_pts) / total_bars
    norm_y = (np.array(y_pts) - min_p) / (max_p - min_p)
    slope, _ = np.polyfit(norm_x, norm_y, 1)
    return float(np.degrees(np.arctan(slope)))

def detect_ascending_triangle(highs, lows, closes, window=65):
    n = len(closes)
    if n < window + 5: return None
    start = n - 1 - window
    w_h = highs[start : n - 1]
    w_l = lows[start : n - 1]
    ceil = np.max(w_h)
    min_w = np.min(w_l)

    r_pts = []
    for p in range(2, len(w_h) - 2):
        if w_h[p] >= ceil * 0.982:
            if w_h[p] >= w_h[p-1] and w_h[p] >= w_h[p-2] and w_h[p] >= w_h[p+1] and w_h[p] >= w_h[p+2]:
                if len(r_pts) == 0 or (p - r_pts[-1]['idx'] >= 6):
                    r_pts.append({'idx': p, 'price': w_h[p]})

    l_pts = []
    for p in range(2, len(w_l) - 2):
        if w_l[p] <= w_l[p-1] and w_l[p] <= w_l[p-2] and w_l[p] <= w_l[p+1] and w_l[p] <= w_l[p+2]:
            if len(l_pts) == 0 or (p - l_pts[-1]['idx'] >= 6):
                l_pts.append({'idx': p, 'price': w_l[p]})

    if len(r_pts) >= 3 and len(l_pts) >= 3 and (r_pts[-1]['idx'] - r_pts[0]['idx'] >= 18):
        if l_pts[-3]['price'] * 1.010 <= l_pts[-2]['price'] and l_pts[-2]['price'] * 1.010 <= l_pts[-1]['price']:
            ang_res = calculate_angle([pt['idx'] for pt in r_pts], [pt['price'] for pt in r_pts], window, min_w, ceil)
            ang_sup = calculate_angle([pt['idx'] for pt in l_pts], [pt['price'] for pt in l_pts], window, min_w, ceil)
            if abs(ang_res) <= 6.0 and ang_sup >= 10.0:
                cur_c = closes[-1]
                prev_c = closes[-2]
                if cur_c > ceil and prev_c <= ceil * 1.008:
                    return {
                        'pattern': 'ASCENDING_TRIANGLE',
                        'level': float(ceil),
                        'stop_level': float(l_pts[-1]['price'] * 0.995),
                        'ceil_angle': round(ang_res, 1),
                        'support_angle': round(ang_sup, 1),
                        'last_low': float(l_pts[-1]['price'])
                    }
    return None

def detect_cup_and_handle(highs, lows, closes, cup_lens=[55, 75], handle_lens=[12, 18]):
    n = len(closes)
    for clen in cup_lens:
        for hlen in handle_lens:
            tot = clen + hlen
            if n < tot + 15: continue
            cs = n - 1 - tot
            ce = n - 1 - hlen

            lr = np.max(highs[cs : cs + 15])
            l_idx = cs + np.argmax(highs[cs : cs + 15])
            rr = np.max(highs[ce - 12 : ce + 1])
            r_idx = ce - 12 + np.argmax(highs[ce - 12 : ce + 1])

            if r_idx - l_idx < 22 or abs(rr - lr) / lr > 0.038: continue
            rim = max(lr, rr)
            cup_bot = np.min(lows[l_idx : r_idx + 1])
            depth = (rim - cup_bot) / rim
            if depth < 0.10 or depth > 0.35: continue

            h_highs = highs[ce : n - 1]
            h_lows = lows[ce : n - 1]
            h_bot = np.min(h_lows)
            handle_depth = (rim - h_bot) / rim
            if handle_depth > depth * 0.48 or handle_depth < 0.015: continue

            ang_handle = calculate_angle(list(range(len(h_highs))), h_highs, hlen, h_bot, rim)
            if ang_handle <= 2.5:
                cur_c = closes[-1]
                prev_c = closes[-2]
                if cur_c > rim and prev_c <= rim * 1.008:
                    return {
                        'pattern': 'CUP_AND_HANDLE',
                        'level': float(rim),
                        'stop_level': float(h_bot * 0.995),
                        'depth_pct': round(depth * 100, 1),
                        'handle_angle': round(ang_handle, 1)
                    }
    return None

def detect_multi_month_base(highs, lows, closes, base_lens=[100, 75, 55, 35]):
    n = len(closes)
    for blen in base_lens:
        if n < blen + 15: continue
        start = n - 1 - blen
        w_h = highs[start : n - 1]
        w_l = lows[start : n - 1]
        bh = np.max(w_h)
        bl = np.min(w_l)
        depth = (bh - bl) / bh
        if depth < 0.07 or depth > 0.30: continue

        touches = [p for p in range(len(w_h)) if w_h[p] >= bh * 0.980]
        if len(touches) >= 2 and (touches[-1] - touches[0] >= 12):
            cur_c = closes[-1]
            prev_c = closes[-2]
            if cur_c > bh and prev_c <= bh * 1.008:
                swing_low = np.min(lows[max(start, n - 22) : n - 1])
                return {
                    'pattern': 'MULTI_MONTH_BASE',
                    'level': float(bh),
                    'stop_level': float(swing_low * 0.995),
                    'base_len': blen,
                    'depth_pct': round(depth * 100, 1)
                }
    return None

def detect_symmetrical_triangle(highs, lows, closes, coil_len=45):
    n = len(closes)
    if n < coil_len + 15: return None
    start = n - 1 - coil_len
    mid = start + coil_len // 2
    h1, h2 = np.max(highs[start : mid]), np.max(highs[mid : n - 1])
    l1, l2 = np.min(lows[start : mid]), np.min(lows[mid : n - 1])

    if l2 >= l1 * 1.018 and h2 <= h1 * 1.002 and (h1 - l1) > (h2 - l2) * 1.12:
        res = max(h1, h2)
        min_coil = min(l1, l2)
        ang_h = calculate_angle([10, 32], [h1, h2], coil_len, min_coil, res)
        ang_l = calculate_angle([10, 32], [l1, l2], coil_len, min_coil, res)
        if ang_h <= -5.0 and ang_l >= 5.0:
            cur_c = closes[-1]
            prev_c = closes[-2]
            if cur_c > res and prev_c <= res * 1.008:
                return {
                    'pattern': 'SYMMETRICAL_TRIANGLE',
                    'level': float(res),
                    'stop_level': float(l2 * 0.995),
                    'high_angle': round(ang_h, 1),
                    'low_angle': round(ang_l, 1)
                }
    return None

def detect_inverse_head_and_shoulders(highs, lows, closes, window=65):
    n = len(closes)
    if n < window + 15: return None
    start = n - 1 - window
    w = window // 3
    ls_idx = start + np.argmin(lows[start : start + w])
    head_idx = start + w + np.argmin(lows[start + w : start + 2 * w])
    rs_idx = start + 2 * w + np.argmin(lows[start + 2 * w : n - 1])

    ls, head, rs = lows[ls_idx], lows[head_idx], lows[rs_idx]
    if head_idx - ls_idx < 10 or rs_idx - head_idx < 10: return None
    if head < ls * 0.970 and head < rs * 0.970 and abs(rs / ls - 1.0) <= 0.055:
        neck1 = np.max(highs[ls_idx : head_idx + 1])
        neck2 = np.max(highs[head_idx : rs_idx + 1])
        neck = max(neck1, neck2)
        if abs(neck1 - neck2) / neck > 0.040: return None
        cur_c = closes[-1]
        prev_c = closes[-2]
        if cur_c > neck and prev_c <= neck * 1.008:
            return {
                'pattern': 'INVERSE_HEAD_AND_SHOULDERS',
                'level': float(neck),
                'stop_level': float(rs * 0.995)
            }
    return None

def detect_pattern(highs, lows, closes):
    return (detect_cup_and_handle(highs, lows, closes) or
            detect_ascending_triangle(highs, lows, closes) or
            detect_multi_month_base(highs, lows, closes) or
            detect_symmetrical_triangle(highs, lows, closes) or
            detect_inverse_head_and_shoulders(highs, lows, closes))

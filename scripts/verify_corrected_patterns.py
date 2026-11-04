"""
scripts/verify_corrected_patterns.py
-------------------------------------
Compares Old Buggy Pattern Detection vs New Mathematically Corrected Pattern Detection
across CIPLA, OIL, MOIL, RECLTD, BHEL, HINDALCO, MCX, BSE, DIXON.
"""

import json, os
import numpy as np

OHLCV_DIR = "data/ohlcv_3y"
test_symbols = ['CIPLA', 'OIL', 'MOIL', 'RECLTD', 'BHEL', 'HINDALCO', 'MCX', 'BSE', 'DIXON']

def test_detections():
    print("=" * 90)
    print("  VERIFYING PATTERN DETECTION CORRECTIONS (OLD BUGGY VS NEW CORRECTED)")
    print("=" * 90)

    for sym in test_symbols:
        p = f"{OHLCV_DIR}/{sym}.json"
        if not os.path.exists(p): continue
        with open(p, 'r') as fp: candles = json.load(fp)['candles']
        dates = [c[0][:10] for c in candles]
        highs = np.array([float(c[2]) for c in candles])
        lows = np.array([float(c[3]) for c in candles])
        closes = np.array([float(c[4]) for c in candles])
        vols = np.array([float(c[5]) for c in candles])
        n = len(dates)

        old_triangles = 0
        new_triangles = 0
        old_cups = 0
        new_cups = 0

        for i in range(70, n):
            c_now = closes[i]

            # -------------------------------------------------------------
            # OLD ASCENDING TRIANGLE (BUGGY)
            # -------------------------------------------------------------
            win_start = i - 40
            res_old = np.max(highs[win_start : i])
            touches_old = np.sum(highs[win_start : i] >= res_old * 0.98)
            l1_old = np.min(lows[win_start : win_start + 20])
            l2_old = np.min(lows[win_start + 20 : i])
            if touches_old >= 2 and l2_old > l1_old and c_now > res_old and closes[i-1] <= res_old * 1.005:
                old_triangles += 1

            # -------------------------------------------------------------
            # NEW ASCENDING TRIANGLE (CORRECTED)
            # -------------------------------------------------------------
            base_len = 50
            if i >= base_len:
                w_highs = highs[i - base_len : i]
                w_lows = lows[i - base_len : i]
                res_new = np.max(w_highs)
                # Find distinct peaks near ceiling
                hits = [p for p in range(len(w_highs)) if w_highs[p] >= res_new * 0.982]
                if len(hits) >= 2 and (hits[-1] - hits[0] >= 15): # Minimum 15-day gap between touches
                    mid_trough = np.min(w_lows[hits[0] : hits[-1] + 1])
                    if (res_new - mid_trough) / res_new >= 0.040: # Distinct 4% pullback wave
                        # Distinct confirmed swing lows
                        first_low = np.min(w_lows[:25])
                        second_low = np.min(w_lows[25:])
                        if second_low >= first_low * 1.020: # Strictly higher swing low
                            if c_now > res_new and closes[i-1] <= res_new * 1.008:
                                new_triangles += 1

            # -------------------------------------------------------------
            # OLD CUP & HANDLE (BUGGY: allows 15-day cups, sharp V-bottoms, high volume handles)
            # -------------------------------------------------------------
            for h_len in [6, 10]:
                for c_len in [35, 50]:
                    tot_len = c_len + h_len
                    if i < tot_len + 10: continue
                    s_cup = i - tot_len
                    m_cup = i - h_len
                    l_rim = np.max(highs[s_cup : s_cup + 12])
                    r_rim = np.max(highs[m_cup - 8 : m_cup + 2])
                    rim_old = max(l_rim, r_rim)
                    if abs(r_rim - l_rim) / rim_old <= 0.035:
                        bot_old = np.min(lows[s_cup : m_cup])
                        dep = (rim_old - bot_old) / rim_old
                        if 0.10 <= dep <= 0.38:
                            h_low = np.min(lows[m_cup : i])
                            h_dep = (rim_old - h_low) / rim_old
                            if 0.02 <= h_dep <= dep * 0.45:
                                if c_now > rim_old * 0.998 and closes[i-1] <= rim_old * 1.010:
                                    old_cups += 1
                                    break
                if old_cups > 0 and old_cups != old_cups: break

            # -------------------------------------------------------------
            # NEW CUP & HANDLE (CORRECTED: 25+ bar rim gap, centered rounded bowl, VDU handle)
            # -------------------------------------------------------------
            for c_len in [40, 55, 75]:
                for h_len in [8, 14, 20]:
                    tot_len = c_len + h_len
                    if i < tot_len: continue
                    cup_start = i - tot_len
                    cup_end = i - h_len
                    
                    l_rim = np.max(highs[cup_start : cup_start + 12])
                    l_idx = cup_start + np.argmax(highs[cup_start : cup_start + 12])
                    r_rim = np.max(highs[cup_end - 8 : cup_end + 1])
                    r_idx = cup_end - 8 + np.argmax(highs[cup_end - 8 : cup_end + 1])
                    
                    if r_idx - l_idx < 25: continue # Minimum 25-day gap between rims!
                    if abs(r_rim - l_rim) / max(l_rim, r_rim) > 0.022: continue # 2.2% rim tolerance
                    
                    rim = max(l_rim, r_rim)
                    cup_slice = lows[l_idx : r_idx + 1]
                    if len(cup_slice) < 15: continue
                    cup_bot = np.min(cup_slice)
                    bot_pos = np.argmin(cup_slice) / len(cup_slice)
                    if bot_pos < 0.25 or bot_pos > 0.75: continue # Centered bowl
                    
                    depth = (rim - cup_bot) / rim
                    if depth < 0.10 or depth > 0.35: continue
                    
                    # Rounded bottom: dwell time >= 4 bars in lower quartile
                    bot_zone = cup_bot + 0.25 * (rim - cup_bot)
                    if np.sum(cup_slice <= bot_zone) < 4: continue
                    
                    # Handle: shallow pullback in upper half of cup
                    handle_low = np.min(lows[cup_end : i])
                    h_depth = (rim - handle_low) / rim
                    if h_depth < 0.025 or h_depth > depth * 0.45 or h_depth > 0.12: continue
                    
                    # Volume contraction in handle
                    if np.mean(vols[cup_end : i]) > np.mean(vols[cup_start : cup_end]) * 1.0: continue
                    
                    if c_now > rim and closes[i-1] <= rim * 1.008:
                        new_cups += 1
                        break
                if new_cups > 0 and new_cups != new_cups: break

        print(f"{sym:10s} | Triangles: Old Buggy={old_triangles:2d} -> New Corrected={new_triangles:2d} | Cups: Old Buggy={old_cups:2d} -> New Corrected={new_cups:2d}")

if __name__ == "__main__":
    test_detections()

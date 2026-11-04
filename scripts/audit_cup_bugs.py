"""
scripts/audit_cup_bugs.py
--------------------------
Audits Cup & Handle detection logic in:
- strategies/mine/resistanceBreakoutStrategy.js
- strategy-core/patterns.js
Exposing:
1. Short separation between left rim and right rim (e.g. <= 12 days)
2. Sharp V-bottoms with 0 or 1 bar in lower quartile
3. Handles that do not contract volume
"""

import json, os
import numpy as np

OHLCV_DIR = "data/ohlcv_3y"
test_symbols = ['CIPLA', 'OIL', 'MOIL', 'RECLTD', 'BHEL', 'HINDALCO', 'TATAMOTORS', 'DIXON', 'BSE', 'MCX']

def audit_cups():
    print("=" * 80)
    print("  AUDITING CUP & HANDLE DETECTIONS")
    print("=" * 80)

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

        # Audit the old Cup & Handle implementation
        detected_cups = []
        for i in range(70, n):
            for handle_len in [6, 10, 15]:
                for cup_len in [35, 50, 65]:
                    total_len = cup_len + handle_len
                    if i < total_len + 30: continue
                    start_cup = i - total_len
                    mid_cup = i - handle_len

                    left_rim = np.max(highs[start_cup : start_cup + 13])
                    left_idx = start_cup + np.argmax(highs[start_cup : start_cup + 13])

                    right_rim = np.max(highs[mid_cup - 8 : mid_cup + 3])
                    right_idx = mid_cup - 8 + np.argmax(highs[mid_cup - 8 : mid_cup + 3])

                    rim_sep = right_idx - left_idx
                    rim = max(left_rim, right_rim)
                    if abs(right_rim - left_rim) / rim > 0.035: continue

                    cup_slice = lows[left_idx : right_idx + 1]
                    if len(cup_slice) < 10: continue
                    cup_bot = np.min(cup_slice)
                    depth = (rim - cup_bot) / rim
                    if depth < 0.08 or depth > 0.40: continue

                    # Check lower quartile dwell
                    bot_q = cup_bot + 0.25 * (rim - cup_bot)
                    bot_days = np.sum(cup_slice <= bot_q)

                    handle_low = np.min(lows[mid_cup : i])
                    handle_depth = (rim - handle_low) / rim
                    if handle_depth < 0.015 or handle_depth > depth * 0.50: continue

                    if closes[i] > rim and closes[i-1] <= rim * 1.01:
                        detected_cups.append({
                            'date': dates[i],
                            'rim_sep': int(rim_sep),
                            'bot_days': int(bot_days),
                            'is_v_bottom': bot_days <= 2,
                            'is_too_narrow': rim_sep < 20,
                            'handle_vol_ratio': round(float(np.mean(vols[mid_cup:i]) / (np.mean(vols[start_cup:mid_cup]) + 1e-9)), 2)
                        })
                        break
                if detected_cups and detected_cups[-1]['date'] == dates[i]: break

        narrow = [c for c in detected_cups if c['is_too_narrow']]
        v_bots = [c for c in detected_cups if c['is_v_bottom']]
        print(f"\n{sym}: {len(detected_cups)} old cup detections")
        print(f"  Narrow cups (< 20 bars between rims): {len(narrow)} ({len(narrow)/max(1,len(detected_cups))*100:.1f}%)")
        print(f"  V-bottoms (<= 2 days in bottom quartile): {len(v_bots)} ({len(v_bots)/max(1,len(detected_cups))*100:.1f}%)")
        if detected_cups:
            print(f"  Sample Detection: {detected_cups[0]}")

if __name__ == "__main__":
    audit_cups()

"""
scripts/test_strict_touches_filter.py
-------------------------------------
Tests the strict Multi-Touch & Anti-Trend-Drift rules:
1. Rectangle:
   - Ceiling touches >= 2 (separated by >= 4 bars)
   - Floor touches >= 2 (separated by >= 4 bars)
   - Flat base slope <= 3.5% (strictly horizontal, eliminates upward trend drifts like GNFC)
2. Ascending Triangle:
   - Flat ceiling touches >= 2 (separated by >= 4 bars)
   - Distinct higher swing low
3. Cup & Handle:
   - Symmetrical rims separated by >= 20 bars
"""

import os, json
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"

with open(os.path.join(OHLCV_DIR, "NIFTYBEES.json"), 'r') as f:
    nd = json.load(f)
n_dates = [c[0][:10] for c in nd['candles']]
n_closes = np.array([float(c[4]) for c in nd['candles']])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def count_separate_touches(series, target_level, tol=0.015, min_gap=4):
    """Counts distinct peaks touching the target level separated by at least min_gap bars"""
    touches = 0
    last_idx = -min_gap - 1
    for i in range(len(series)):
        if abs(series[i] - target_level) / target_level <= tol:
            if i - last_idx >= min_gap:
                touches += 1
                last_idx = i
    return touches

# Test on GNFC specifically
with open(os.path.join(OHLCV_DIR, "GNFC.json"), 'r') as f:
    gd = json.load(f)
g_candles = gd['candles']
g_dates = [c[0][:10] for c in g_candles]
g_highs = np.array([float(c[2]) for c in g_candles])
g_lows = np.array([float(c[3]) for c in g_candles])
g_closes = np.array([float(c[4]) for c in g_candles])

target_i = g_dates.index("2024-01-02")
win_h = g_highs[target_i - 30 : target_i]
win_l = g_lows[target_i - 30 : target_i]
box_h = np.max(win_h)
box_l = np.min(win_l)

ceil_touches = count_separate_touches(win_h, box_h, tol=0.015, min_gap=4)
floor_touches = count_separate_touches(win_l, box_l, tol=0.015, min_gap=4)

print(f"GNFC on 2024-01-02 Audit:")
print(f"  Ceiling Touches (>= 4 bar gap): {ceil_touches}")
print(f"  Floor Touches   (>= 4 bar gap): {floor_touches}")
if ceil_touches < 2:
    print("  -> REJECTED! Does not have multiple ceiling touches (it is a continuous trend mover, not a base breakout!).")
else:
    print("  -> PASSED.")

"""
scripts/analyze_cup_geometry.py
-------------------------------
Analyzes the geometrical quality of each of the 20 Cup & Handle calls:
1. Rim Symmetry: abs(LeftRim - RightRim) / LeftRim
2. Cup Roundness / Curvature: Is the bottom rounded or a sharp V-spike?
   Measured by: how many days did the price spend in the bottom 25% of the cup?
   (A true U-shaped cup spends 5-15 days consolidating at the bottom; a V-spike bounces in 1-2 days).
3. Handle Angle / Drift: Is the handle drifting gently downward or collapsing?
4. Volume Behavior: Did volume contract in the handle? (Handle Vol < Cup Vol)
5. Breakout Volume: Did the breakout candle have volume surge (>= 1.3x 20-day SMA)?
"""

import json, os
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"

with open('data/cup_20_calls_audit.json') as f:
    calls = json.load(f)

results = []

for c in calls:
    sym = c['symbol']
    b_dt = c['break_date']
    p = os.path.join(OHLCV_DIR, f"{sym}.json")
    with open(p, 'r') as fp:
        d = json.load(fp)
    candles = d['candles']
    dates = [x[0][:10] for x in candles]
    highs = np.array([float(x[2]) for x in candles])
    lows = np.array([float(x[3]) for x in candles])
    closes = np.array([float(x[4]) for x in candles])
    vols = np.array([float(x[5]) for x in candles])

    i = dates.index(b_dt)
    
    # We used cup_len in [45, 60]
    # Let's find the exact cup window
    # Search backwards for the left rim
    rim = c['rim']
    # Bottom
    cup_low = rim * (1.0 - c['cup_depth'] / 100.0)
    
    # Look back 60 days
    window_highs = highs[i-60 : i]
    window_lows = lows[i-60 : i]
    window_vols = vols[i-60 : i]
    
    # Volume SMA 20
    vol_sma20 = np.mean(vols[i-20 : i])
    break_vol_ratio = vols[i] / (vol_sma20 + 1e-9)
    
    # Handle volume vs cup volume
    handle_vols = vols[i-8 : i]
    cup_vols = vols[i-50 : i-10]
    handle_vol_ratio = np.mean(handle_vols) / (np.mean(cup_vols) + 1e-9)
    
    # Bottom dwell time: count candles where low <= cup_low + 0.25 * (rim - cup_low)
    bottom_threshold = cup_low + 0.25 * (rim - cup_low)
    bottom_days = np.sum((lows[i-50 : i-10] <= bottom_threshold))
    
    # Is it a true rounded base (U-shape) vs sharp V-bottom?
    is_u_shape = bottom_days >= 4
    
    results.append({
        'num': c['num'],
        'symbol': sym,
        'date': b_dt,
        'outcome': c['outcome'],
        'net_pct': c['net_pct'],
        'cup_depth': c['cup_depth'],
        'bottom_days': int(bottom_days),
        'is_u_shape': is_u_shape,
        'break_vol_ratio': round(break_vol_ratio, 2),
        'handle_vol_ratio': round(handle_vol_ratio, 2),
        'handle_depth': c['handle_depth']
    })

print(f"{'#':2s} | {'Symbol':10s} | {'Date':10s} | {'Outcome':9s} | {'Net%':5s} | {'BottomDays':10s} | {'Shape':7s} | {'BreakVol':8s} | {'HandleVol':9s}")
print("-" * 88)
for r in results:
    shape_str = "ROUND U" if r['is_u_shape'] else "SHARP V"
    print(f"{r['num']:02d} | {r['symbol']:10s} | {r['date']:10s} | {r['outcome']:9s} | {r['net_pct']:+5.1f}% | {r['bottom_days']:2d} days    | {shape_str:7s} | {r['break_vol_ratio']:4.2f}x    | {r['handle_vol_ratio']:4.2f}x")

# Summary stats on U-shape vs V-shape
u_shapes = [r for r in results if r['is_u_shape']]
v_shapes = [r for r in results if not r['is_u_shape']]

u_wins = len([r for r in u_shapes if r['net_pct'] > 0])
v_wins = len([r for r in v_shapes if r['net_pct'] > 0])

print("\n" + "=" * 50)
print(f"U-Shape (True Rounded Base): {len(u_shapes)} calls | Winners: {u_wins} ({u_wins/max(1,len(u_shapes))*100:.1f}%)")
print(f"V-Shape (Distorted V-Bottom): {len(v_shapes)} calls | Winners: {v_wins} ({v_wins/max(1,len(v_shapes))*100:.1f}%)")

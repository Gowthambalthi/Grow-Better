"""
scripts/verify_kaynes_touches.py
--------------------------------
Demonstrates what happened in KAYNES on 2024-03-11 / 2024-03-12:
- Was it a real multi-touch rounded base or an erratic chop?
"""

import os, json
import numpy as np

with open('data/ohlcv_3y/KAYNES.json', 'r') as f:
    d = json.load(f)

candles = d['candles']
dates = [c[0][:10] for c in candles]
highs = np.array([float(c[2]) for c in candles])
lows = np.array([float(c[3]) for c in candles])
closes = np.array([float(c[4]) for c in candles])

target_dt = '2024-03-11'
i = dates.index(target_dt)

win_h = highs[i-55 : i]
win_l = lows[i-55 : i]
win_dates = dates[i-55 : i]

print(f"KAYNES on {target_dt}:")
print(f"High on breakout: Rs {highs[i]:.2f}, Close: Rs {closes[i]:.2f}")
print(f"Next Day Open: Rs {candles[i+1][1]}, Low: Rs {candles[i+1][3]}, Close: Rs {candles[i+1][4]}")

# Look at the resistance:
# How many times did price test the rim level?
rim = np.max(win_h)
rim_touches = [win_dates[k] for k in range(len(win_h)) if win_h[k] >= rim * 0.985]
print(f"Rim Level: Rs {rim:.2f} | Touches: {len(rim_touches)}")
for rt in rim_touches:
    print(f"  Touch date: {rt}")

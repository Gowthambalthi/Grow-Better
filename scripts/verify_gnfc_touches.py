"""
scripts/verify_gnfc_touches.py
------------------------------
Demonstrates why GNFC on 2024-01-02 was NOT a real Rectangle Breakout:
- Checks how many times price actually touched the resistance ceiling
- Checks whether it was a horizontal base or an upward trending drift
"""

import os, json
import numpy as np

with open('data/ohlcv_3y/GNFC.json', 'r') as f:
    d = json.load(f)

candles = d['candles']
dates = [c[0][:10] for c in candles]
highs = np.array([float(c[2]) for c in candles])
lows = np.array([float(c[3]) for c in candles])
closes = np.array([float(c[4]) for c in candles])

target_dt = '2024-01-02'
i = dates.index(target_dt)

# Lookback 30 bars
win_h = highs[i-30 : i]
win_l = lows[i-30 : i]
win_c = closes[i-30 : i]
win_dates = dates[i-30 : i]

box_h = np.max(win_h)
box_l = np.min(win_l)

print(f"GNFC on {target_dt}:")
print(f"30-day Window High: Rs {box_h:.2f}")
print(f"30-day Window Low : Rs {box_l:.2f}")
print(f"Range Pct         : {(box_h - box_l)/box_l*100:.1f}%\n")

# Ceiling touches: how many distinct peaks touched within 1.5% of box_h?
ceil_touches = []
for k in range(len(win_h)):
    if win_h[k] >= box_h * 0.985:
        ceil_touches.append((win_dates[k], win_h[k]))

print(f"Ceiling Touches (within 1.5% of {box_h:.2f}):")
for ct in ceil_touches:
    print(f"  {ct[0]}: High Rs {ct[1]:.2f}")

# Trend Drift Check:
# What was the price at the start of the 30-day box vs before breakout?
start_c = np.mean(win_c[:5])
end_c = np.mean(win_c[-5:])
trend_slope_pct = (end_c - start_c) / start_c * 100.0
print(f"\nPrice at Start of 30d Window: Rs {start_c:.2f}")
print(f"Price at End of 30d Window  : Rs {end_c:.2f}")
print(f"Trend Drift Slope           : {trend_slope_pct:+.1f}%")
if trend_slope_pct > 5.0:
    print("VERDICT: NOT a horizontal rectangle! It is a continuous UPWARD TREND MOVER (+{:.1f}%), exactly as user pointed out!".format(trend_slope_pct))

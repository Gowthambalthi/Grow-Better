"""
scripts/analyze_20_calls_mfe_mae.py
-----------------------------------
Analyzes the MFE (Max Favorable Excursion) and MAE (Max Adverse Excursion)
for each of the 20 Cup & Handle calls over the 25-day holding window.
"""

import json, os
import numpy as np

OHLCV_DIR = "data/ohlcv_3y"

with open('data/cup_20_calls_audit.json') as f:
    calls = json.load(f)

print(f"{'#':2s} | {'Symbol':10s} | {'Date':10s} | {'Entry':7s} | {'Target':7s} | {'SL':7s} | {'MFE%':6s} | {'MAE%':6s} | {'Outcome':9s} | {'HitTP_Ever':10s}")
print("-" * 92)

tp_ever_count = 0

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
    opens = np.array([float(x[1]) for x in candles])
    closes = np.array([float(x[4]) for x in candles])

    i = dates.index(b_dt)
    entry_p = opens[i + 1]
    target_p = entry_p * 1.08
    sl_p = c['sl']
    
    # 25-day window
    f_highs = highs[i+1 : min(len(dates), i+26)]
    f_lows = lows[i+1 : min(len(dates), i+26)]
    
    max_h = np.max(f_highs)
    min_l = np.min(f_lows)
    
    mfe = (max_h - entry_p) / entry_p * 100.0
    mae = (min_l - entry_p) / entry_p * 100.0
    
    hit_tp_ever = max_h >= target_p
    if hit_tp_ever:
        tp_ever_count += 1
        
    print(f"{c['num']:02d} | {sym:10s} | {b_dt:10s} | {entry_p:7.1f} | {target_p:7.1f} | {sl_p:7.1f} | {mfe:+5.1f}% | {mae:+5.1f}% | {c['outcome']:9s} | {'YES (+8%)' if hit_tp_ever else 'NO':10s}")

print("-" * 92)
print(f"Total that reached +8% Target within 25 days: {tp_ever_count} / 20 ({tp_ever_count/20*100:.1f}%)")

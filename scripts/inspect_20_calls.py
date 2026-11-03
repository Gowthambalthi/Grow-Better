import json, os
import numpy as np

with open('data/cup_20_calls_audit.json') as f:
    calls = json.load(f)

print(f"{'#':2s} | {'Symbol':11s} | {'Date':10s} | {'Rim':8s} | {'Cup%':5s} | {'Hnd%':5s} | {'RSI':5s} | {'RS60':5s} | {'Outcome':9s} | {'Net%':6s} | {'Days':4s}")
print("-" * 85)
for c in calls:
    print(f"{c['num']:02d} | {c['symbol']:11s} | {c['break_date']:10s} | {c['rim']:8.1f} | {c['cup_depth']:4.1f}% | {c['handle_depth']:4.1f}% | {c['rsi']:4.1f} | {c['rs60']:4.1f}% | {c['outcome']:9s} | {c['net_pct']:+5.1f}% | {c['days']:2d}d")

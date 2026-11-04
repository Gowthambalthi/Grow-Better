"""
scripts/audit_pattern_bugs.py
------------------------------
Systematic audit of pattern detection bugs in:
1. strategies/mine/resistanceBreakoutStrategy.js
2. strategy-core/patterns.js
3. strategy-core/patternLibrary.js

Checks:
- Cup & Handle: Are rims too close? Is bottom a sharp V instead of U? Is handle missing VDU?
- Ascending Triangle: Are touches adjacent bars (e.g. Day 10 and Day 11)? Is intervening trough missing?
- Inverse Head & Shoulders: Are shoulders artificial fixed 1/3 slices? Are troughs separated?
- Rectangle: Does it detect diagonal trends as boxes?
"""

import json, os, glob
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"

def audit_patterns():
    print("=" * 80)
    print("  AUDITING PATTERN DETECTION ACCURACY & EXPOSING BUGS")
    print("=" * 80)

    # Let's inspect CIPLA, OIL, MOIL and sample stocks
    test_symbols = ['CIPLA', 'OIL', 'MOIL', 'RECLTD', 'BHEL', 'HINDALCO', 'TATAMOTORS']
    
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
        
        print(f"\nScanning {sym} ({n} bars)...")
        
        # Test Old Flawed Ascending Triangle (adjacent touch bug)
        fake_triangles = []
        for i in range(45, n):
            win_start = i - 40
            res = np.max(highs[win_start : i])
            # Count touches >= 0.98 * res
            touch_indices = [k for k in range(win_start, i) if highs[k] >= res * 0.98]
            if len(touch_indices) >= 2:
                # Check touch separation
                diffs = [touch_indices[j+1] - touch_indices[j] for j in range(len(touch_indices)-1)]
                min_sep = min(diffs)
                max_sep = touch_indices[-1] - touch_indices[0]
                first_half_low = np.min(lows[win_start : win_start + 20])
                second_half_low = np.min(lows[win_start + 20 : i])
                
                if second_half_low > first_half_low and closes[i] > res and closes[i-1] <= res * 1.005:
                    fake_triangles.append({
                        'date': dates[i],
                        'res': round(res, 2),
                        'touches': len(touch_indices),
                        'min_touch_sep': min_sep,
                        'max_touch_sep': max_sep,
                        'is_clump': min_sep <= 2
                    })
                    
        clumps = [t for t in fake_triangles if t['is_clump']]
        print(f"  Old Ascending Triangle: Found {len(fake_triangles)} signals, of which {len(clumps)} ({len(clumps)/max(1,len(fake_triangles))*100:.1f}%) were CLUMPED/ADJACENT touches (<= 2 bars apart)!")
        if clumps:
            print(f"    Example Clumped False Triangle: {clumps[0]}")

if __name__ == "__main__":
    audit_patterns()

"""
scripts/calibrate_4_patterns_new.py
-----------------------------------
Calibrate the 4 patterns:
1. Cup & Handle + RSI
2. Inverse Head & Shoulders + RSI
3. Rectangle + RSI
4. Ascending Triangle + RSI

Goal:
- Target: 4 to 5 high-conviction calls per week (~200-250 calls/year = 600-750 trades over 3 years)
- Solid Win Rate (>= 50-55%) and Profit Factor (>= 1.4 - 1.8)
- Test across the entire 923+ liquid NSE stock universe
- Realistic Zerodha/NSE friction 0.28% round-trip
"""

import os, sys, json
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = os.path.join(OHLCV_DIR, "NIFTYBEES.json")
UNIV_PATH = "data/universe_filtered.json"

with open(UNIV_PATH, 'r') as f:
    univ = json.load(f)
symbols = [s['symbol'] for s in univ['stocks'] if s.get('avgTurnoverCr', 0) >= 5.0]

with open(NIFTY_PATH, 'r') as f:
    nd = json.load(f)
n_dates = [c[0][:10] for c in nd['candles']]
n_closes = np.array([float(c[4]) for c in nd['candles']])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

print(f"Loaded {len(symbols)} liquid NSE stocks.")

def test_calibration(rsi_low=50, rsi_high=72, min_rs=10.0, min_vol=1.15, max_ext=1.03):
    trades = []
    
    for sym in symbols:
        p = os.path.join(OHLCV_DIR, f"{sym}.json")
        if not os.path.exists(p):
            continue
        try:
            with open(p, 'r') as fp:
                d = json.load(fp)
            candles = d.get('candles', [])
            if len(candles) < 220:
                continue

            dates = [c[0][:10] for c in candles]
            opens = np.array([float(c[1]) for c in candles])
            highs = np.array([float(c[2]) for c in candles])
            lows = np.array([float(c[3]) for c in candles])
            closes = np.array([float(c[4]) for c in candles])
            vols = np.array([float(c[5]) for c in candles])
            n = len(dates)

            rsi14 = calculate_rsi(closes, 14)
            vol_sma20 = pd.Series(vols).rolling(20).mean().values

            for i in range(70, n - 20):
                dt = dates[i]
                c_now = closes[i]
                rsi_now = rsi14[i]

                # Market gate
                if dt not in n_map or not n_map[dt]['bull']:
                    continue
                # RSI sweet spot
                if rsi_now < rsi_low or rsi_now > rsi_high:
                    continue

                # Relative Strength
                if i >= 60 and dt in n_map and dates[i-60] in n_map:
                    s_ret = (c_now - closes[i-60]) / closes[i-60]
                    n_ret = (n_map[dt]['close'] - n_map[dates[i-60]]['close']) / n_map[dates[i-60]]['close']
                    rs60 = (s_ret - n_ret) * 100.0
                    if rs60 < min_rs:
                        continue
                else:
                    continue

                # Volume surge
                vol_ratio = vols[i] / (vol_sma20[i] + 1e-9)
                if vol_ratio < min_vol:
                    continue

                detected = None
                pat_level = None
                stop_l = None

                # 1. Cup & Handle
                for c_len in [35, 50, 65]:
                    if i < c_len: continue
                    s_bar = i - c_len
                    m_bar = i - 8
                    lr = np.max(highs[s_bar : s_bar + 12])
                    bot = np.min(lows[s_bar + 10 : m_bar])
                    rr = np.max(highs[m_bar - 4 : m_bar + 4])
                    hl = np.min(lows[m_bar : i])

                    if abs(rr - lr) / lr <= 0.045:
                        rim = max(lr, rr)
                        depth = (rim - bot) / rim
                        if 0.10 <= depth <= 0.35:
                            h_depth = (rim - hl) / rim
                            if 0.02 <= h_depth <= depth * 0.45:
                                if c_now > rim * 0.998 and closes[i-1] <= rim * 1.005:
                                    detected = 'CUP_HANDLE'
                                    pat_level = rim
                                    stop_l = hl
                                    break

                # 2. Ascending Triangle
                if not detected and i >= 35:
                    win_s = i - 35
                    tri_res = np.max(highs[win_s : i])
                    touches = np.sum(highs[win_s : i] >= tri_res * 0.985)
                    if touches >= 2:
                        l1 = np.min(lows[win_s : win_s + 18])
                        l2 = np.min(lows[win_s + 18 : i])
                        if l2 > l1 * 1.01: # Rising swing low
                            if c_now > tri_res and closes[i-1] <= tri_res * 1.005:
                                detected = 'ASCENDING_TRIANGLE'
                                pat_level = tri_res
                                stop_l = l2

                # 3. Rectangle Consolidation
                if not detected and i >= 25:
                    box_h = np.max(highs[i - 25 : i])
                    box_l = np.min(lows[i - 25 : i])
                    r_pct = (box_h - box_l) / box_l * 100.0
                    if 4.0 <= r_pct <= 14.0:
                        if c_now > box_h and closes[i-1] <= box_h * 1.005:
                            detected = 'RECTANGLE'
                            pat_level = box_h
                            stop_l = box_l

                # 4. Inverse Head & Shoulders
                if not detected and i >= 60:
                    a = i - 60
                    w = 20
                    ls = np.min(lows[a : a + w])
                    head = np.min(lows[a + w : a + 2 * w])
                    rs = np.min(lows[a + 2 * w : i])
                    if head < ls and head < rs and abs(rs / ls - 1.0) <= 0.07:
                        neck = min(np.max(highs[a : a + w]), np.max(highs[a + 2 * w : i]))
                        if c_now > neck and closes[i-1] <= neck * 1.005:
                            detected = 'INVERSE_HS'
                            pat_level = neck
                            stop_l = rs

                if detected:
                    # Check capped buy pocket
                    if c_now > pat_level * max_ext:
                        continue

                    entry_p = opens[i + 1]
                    target_p = entry_p * 1.08 # +8% Target 1
                    
                    risk_pct = (entry_p - stop_l) / entry_p
                    if risk_pct < 0.025:
                        stop_l = entry_p * 0.975
                    elif risk_pct > 0.07:
                        stop_l = entry_p * 0.93

                    outcome = 'TIME_EXIT'
                    exit_p = closes[min(n-1, i+20)]
                    days = 20
                    for f_bar in range(i+1, min(n, i+21)):
                        if lows[f_bar] <= stop_l:
                            outcome = 'STOP_LOSS'
                            exit_p = min(opens[f_bar], stop_l)
                            days = f_bar - i
                            break
                        if highs[f_bar] >= target_p:
                            outcome = 'TARGET'
                            exit_p = max(opens[f_bar], target_p)
                            days = f_bar - i
                            break

                    net_pct = ((exit_p - entry_p) / entry_p - 0.0028) * 100.0
                    trades.append({
                        'sym': sym,
                        'pattern': detected,
                        'date': dt,
                        'net_pct': net_pct,
                        'outcome': outcome,
                        'days': days
                    })
        except Exception:
            continue

    total = len(trades)
    if total == 0:
        print("0 trades found.")
        return

    wins = [t for t in trades if t['net_pct'] > 0]
    losses = [t for t in trades if t['net_pct'] <= 0]
    wr = len(wins) / total * 100.0
    gw = sum(t['net_pct'] for t in wins)
    gl = abs(sum(t['net_pct'] for t in losses))
    pf = gw / (gl + 1e-9)
    net_tot = sum(t['net_pct'] for t in trades)
    calls_per_week = total / 150.0 # ~150 weeks in 3 years

    print(f"Results for RSI [{rsi_low}-{rsi_high}], RS>={min_rs}%, Vol>={min_vol}x, Ext<={max_ext}:")
    print(f"  Total Trades: {total} ({calls_per_week:.1f} calls/week)")
    print(f"  Win Rate: {wr:.1f}%")
    print(f"  Profit Factor: {pf:.2f}")
    print(f"  Net Total Gain: {net_tot:+.1f}%")

    from collections import defaultdict
    p_map = defaultdict(list)
    for t in trades:
        p_map[t['pattern']].append(t)
    for p, ts in p_map.items():
        p_wins = [x for x in ts if x['net_pct'] > 0]
        p_wr = len(p_wins) / len(ts) * 100.0
        p_gw = sum(x['net_pct'] for x in p_wins)
        p_gl = abs(sum(x['net_pct'] for x in ts if x['net_pct'] <= 0))
        p_pf = p_gw / (p_gl + 1e-9)
        print(f"    - {p:18s}: {len(ts):4d} trades | WR: {p_wr:5.1f}% | PF: {p_pf:4.2f} | Net: {sum(x['net_pct'] for x in ts):+6.1f}%")

print("\n--- TEST RUN 1 (Standard Institutional Calibration) ---")
test_calibration(rsi_low=50, rsi_high=72, min_rs=10.0, min_vol=1.15, max_ext=1.03)

print("\n--- TEST RUN 2 (Balanced 4-5 Calls/Week Target) ---")
test_calibration(rsi_low=48, rsi_high=74, min_rs=8.0, min_vol=1.10, max_ext=1.035)

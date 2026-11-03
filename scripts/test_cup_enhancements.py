"""
scripts/test_cup_enhancements.py
--------------------------------
Tests the two crucial institutional rules discovered during the 20-call visual audit:
1. Breakout Volume Confirmation (BreakVol >= 1.3x 20-day SMA)
2. Capped Buy Pocket (Entry Close <= Rim * 1.025 - no chasing extended candles)
"""

import os, json
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = os.path.join(OHLCV_DIR, "NIFTYBEES.json")

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

files = [f for f in os.listdir(OHLCV_DIR) if f.endswith('.json') and f != 'NIFTYBEES.json']

def run_simulation(min_break_vol=0.0, max_extension=1.10):
    trades = []
    for f in files:
        sym = f.replace('.json', '')
        p = os.path.join(OHLCV_DIR, f)
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
            volumes = np.array([float(c[5]) for c in candles])
            n = len(dates)

            rsi14 = calculate_rsi(closes, 14)
            vol_sma20 = pd.Series(volumes).rolling(20).mean().values

            for i in range(70, n - 25):
                dt = dates[i]
                c_now = closes[i]
                rsi_now = rsi14[i]

                if dt not in n_map or not n_map[dt]['bull']:
                    continue
                if rsi_now < 48 or rsi_now > 75:
                    continue

                if i >= 60 and dt in n_map and dates[i-60] in n_map:
                    s_ret = (c_now - closes[i-60]) / closes[i-60]
                    n_ret = (n_map[dt]['close'] - n_map[dates[i-60]]['close']) / n_map[dates[i-60]]['close']
                    rs60 = (s_ret - n_ret) * 100.0
                    if rs60 < 15.0:
                        continue
                else:
                    continue

                # Cup and Handle
                for cup_len in [45, 60]:
                    if i < cup_len: continue
                    start = i - cup_len
                    mid = i - 10
                    lr = np.max(highs[start : start + 15])
                    bot = np.min(lows[start + 15 : mid])
                    rr = np.max(highs[mid - 5 : mid + 5])
                    hl = np.min(lows[mid : i])

                    if abs(rr - lr) / lr <= 0.035:
                        rim = max(lr, rr)
                        depth = (rim - bot) / rim
                        if 0.12 <= depth <= 0.35:
                            h_depth = (rim - hl) / rim
                            if 0.02 <= h_depth <= depth * 0.40:
                                if c_now > rim * 0.998 and closes[i-1] <= rim * 1.005:
                                    # Institutional Check 1: Volume confirmation
                                    break_vol_ratio = volumes[i] / (vol_sma20[i] + 1e-9)
                                    if break_vol_ratio < min_break_vol:
                                        continue
                                    
                                    # Institutional Check 2: Capped Buy Pocket (No chasing)
                                    if c_now > rim * max_extension:
                                        continue

                                    entry_p = opens[i + 1]
                                    target_p = entry_p * 1.08
                                    sl_p = max(entry_p * 0.95, hl)

                                    outcome = 'TIME_EXIT'
                                    exit_p = closes[min(n-1, i+25)]
                                    days = 25
                                    for f_bar in range(i+1, min(n, i+26)):
                                        if lows[f_bar] <= sl_p:
                                            outcome = 'STOP_LOSS'
                                            exit_p = min(opens[f_bar], sl_p)
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
                                        'date': dt,
                                        'net_pct': net_pct,
                                        'outcome': outcome,
                                        'days': days
                                    })
                                    break
        except Exception:
            continue
    return trades

print("Testing Baseline (No Vol filter, No Chasing Cap):")
base = run_simulation(min_break_vol=0.0, max_extension=1.15)
base_wins = [t for t in base if t['net_pct'] > 0]
base_losses = [t for t in base if t['net_pct'] <= 0]
base_gross_win = sum([t['net_pct'] for t in base_wins])
base_gross_loss = abs(sum([t['net_pct'] for t in base_losses]))
base_pf = base_gross_win / (base_gross_loss + 1e-9)
print(f"Total: {len(base)} | Win Rate: {len(base_wins)/len(base)*100:.1f}% | PF: {base_pf:.2f} | Net Total: {sum(t['net_pct'] for t in base):+.1f}%")

print("\nTesting Enhanced (Vol >= 1.3x, Buy Pocket <= Rim * 1.025):")
enh = run_simulation(min_break_vol=1.3, max_extension=1.025)
enh_wins = [t for t in enh if t['net_pct'] > 0]
enh_losses = [t for t in enh if t['net_pct'] <= 0]
enh_gross_win = sum([t['net_pct'] for t in enh_wins])
enh_gross_loss = abs(sum([t['net_pct'] for t in enh_losses]))
enh_pf = enh_gross_win / (enh_gross_loss + 1e-9)
print(f"Total: {len(enh)} | Win Rate: {len(enh_wins)/len(enh)*100:.1f}% | PF: {enh_pf:.2f} | Net Total: {sum(t['net_pct'] for t in enh):+.1f}%")

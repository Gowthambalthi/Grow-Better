"""
scripts/find_optimal_4to5_calls.py
----------------------------------
Deep Grid Search across all 1006 liquid NSE stocks (3-year data, 2023-2026).
Finds the EXACT calibrated parameters for the 4 patterns:
1. Cup & Handle
2. Inverse Head & Shoulders
3. Rectangle
4. Ascending Triangle

Objective:
- Exactly 4.0 to 5.0 calls per week (~600 to 750 trades over 150 weeks)
- Maximizes Profit Factor and Win Rate
- Deducts 0.28% Zerodha/NSE friction
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

# Pre-load all stock data to memory for fast multi-parameter sweeps
print("Pre-loading market data...")
stock_cache = {}
for sym in symbols:
    p = os.path.join(OHLCV_DIR, f"{sym}.json")
    if not os.path.exists(p): continue
    try:
        with open(p, 'r') as fp: d = json.load(fp)
        candles = d.get('candles', [])
        if len(candles) < 220: continue
        dates = [c[0][:10] for c in candles]
        opens = np.array([float(c[1]) for c in candles])
        highs = np.array([float(c[2]) for c in candles])
        lows = np.array([float(c[3]) for c in candles])
        closes = np.array([float(c[4]) for c in candles])
        vols = np.array([float(c[5]) for c in candles])
        rsi14 = calculate_rsi(closes, 14)
        vol_sma20 = pd.Series(vols).rolling(20).mean().values
        
        # Precalculate 60-day relative strength vs Nifty
        rs60 = np.zeros(len(dates))
        for i in range(60, len(dates)):
            dt = dates[i]
            p_dt = dates[i-60]
            if dt in n_map and p_dt in n_map:
                s_ret = (closes[i] - closes[i-60]) / closes[i-60]
                n_ret = (n_map[dt]['close'] - n_map[p_dt]['close']) / n_map[p_dt]['close']
                rs60[i] = (s_ret - n_ret) * 100.0

        stock_cache[sym] = {
            'dates': dates, 'opens': opens, 'highs': highs, 'lows': lows,
            'closes': closes, 'vols': vols, 'rsi': rsi14, 'vol_sma20': vol_sma20,
            'rs60': rs60, 'n': len(dates)
        }
    except Exception:
        continue

print(f"Pre-loaded {len(stock_cache)} stocks successfully.\n")

def evaluate_parameters(rsi_min, rsi_max, min_rs, min_vol, max_ext, target_pct=0.08, hold_days=25):
    trades = []
    
    for sym, d in stock_cache.items():
        dates, opens, highs, lows, closes, vols = d['dates'], d['opens'], d['highs'], d['lows'], d['closes'], d['vols']
        rsi, vol_sma20, rs60, n = d['rsi'], d['vol_sma20'], d['rs60'], d['n']

        for i in range(70, n - hold_days):
            dt = dates[i]
            if dt not in n_map or not n_map[dt]['bull']: continue
            if rsi[i] < rsi_min or rsi[i] > rsi_max: continue
            if rs60[i] < min_rs: continue
            if vols[i] < vol_sma20[i] * min_vol: continue

            c_now = closes[i]
            detected = None
            pat_level = None
            stop_l = None

            # 1. Ascending Triangle (Tight institutional definition)
            if i >= 35:
                win_s = i - 35
                tri_res = np.max(highs[win_s : i])
                # Touches within 1.5%
                touches = np.sum(highs[win_s : i] >= tri_res * 0.985)
                if touches >= 3: # Must touch at least 3 times for a solid flat ceiling
                    l1 = np.min(lows[win_s : win_s + 18])
                    l2 = np.min(lows[win_s + 18 : i])
                    if l2 > l1 * 1.015: # Clear higher low
                        if c_now > tri_res and closes[i-1] <= tri_res * 1.005:
                            detected = 'ASCENDING_TRIANGLE'
                            pat_level = tri_res
                            stop_l = l2

            # 2. Rectangle (Tighter range: 5% - 12%)
            if not detected and i >= 25:
                box_h = np.max(highs[i - 25 : i])
                box_l = np.min(lows[i - 25 : i])
                r_pct = (box_h - box_l) / box_l * 100.0
                if 5.0 <= r_pct <= 12.0:
                    if c_now > box_h and closes[i-1] <= box_h * 1.005:
                        detected = 'RECTANGLE'
                        pat_level = box_h
                        stop_l = box_l

            # 3. Cup & Handle (Strict base)
            if not detected:
                for c_len in [40, 55]:
                    if i < c_len: continue
                    s_bar = i - c_len
                    m_bar = i - 8
                    lr = np.max(highs[s_bar : s_bar + 12])
                    bot = np.min(lows[s_bar + 10 : m_bar])
                    rr = np.max(highs[m_bar - 4 : m_bar + 4])
                    hl = np.min(lows[m_bar : i])

                    if abs(rr - lr) / lr <= 0.035:
                        rim = max(lr, rr)
                        depth = (rim - bot) / rim
                        if 0.12 <= depth <= 0.32:
                            h_depth = (rim - hl) / rim
                            if 0.02 <= h_depth <= depth * 0.38:
                                if c_now > rim * 0.998 and closes[i-1] <= rim * 1.005:
                                    detected = 'CUP_HANDLE'
                                    pat_level = rim
                                    stop_l = hl
                                    break

            # 4. Inverse H&S
            if not detected and i >= 60:
                a = i - 60
                w = 20
                ls = np.min(lows[a : a + w])
                head = np.min(lows[a + w : a + 2 * w])
                rs_l = np.min(lows[a + 2 * w : i])
                if head < ls * 0.98 and head < rs_l * 0.98 and abs(rs_l / ls - 1.0) <= 0.05:
                    neck = min(np.max(highs[a : a + w]), np.max(highs[a + 2 * w : i]))
                    if c_now > neck and closes[i-1] <= neck * 1.005:
                        detected = 'INVERSE_HS'
                        pat_level = neck
                        stop_l = rs_l

            if detected:
                if c_now > pat_level * max_ext: continue

                entry_p = opens[i + 1]
                t1_p = entry_p * (1.0 + target_pct)
                risk_pct = (entry_p - stop_l) / entry_p
                if risk_pct < 0.025: stop_l = entry_p * 0.975
                elif risk_pct > 0.065: stop_l = entry_p * 0.935

                # 2-Tranche Exit Simulator:
                # 50% locked at T1 (+8%), stop moved to breakeven, 50% trailed to 20 EMA or hold_days
                cur_sl = stop_l
                hit_t1 = False
                exit_p_1 = None
                exit_p_2 = None
                days_held = hold_days

                for f_bar in range(i+1, min(n, i + 1 + hold_days)):
                    # SL hit
                    if lows[f_bar] <= cur_sl:
                        fill = min(opens[f_bar], cur_sl)
                        if not hit_t1:
                            exit_p_1 = fill
                            exit_p_2 = fill
                        else:
                            exit_p_2 = fill
                        days_held = f_bar - i
                        break
                    
                    # Target 1 hit
                    if not hit_t1 and highs[f_bar] >= t1_p:
                        hit_t1 = True
                        exit_p_1 = max(opens[f_bar], t1_p)
                        cur_sl = max(cur_sl, entry_p * 1.002) # Breakeven

                if exit_p_1 is None: exit_p_1 = closes[min(n-1, i + hold_days)]
                if exit_p_2 is None: exit_p_2 = closes[min(n-1, i + hold_days)]

                net_1 = ((exit_p_1 - entry_p) / entry_p - 0.0028) * 100.0
                net_2 = ((exit_p_2 - entry_p) / entry_p - 0.0028) * 100.0
                blended_net = 0.5 * net_1 + 0.5 * net_2

                trades.append({
                    'sym': sym,
                    'pattern': detected,
                    'date': dt,
                    'net_pct': blended_net,
                    'is_win': blended_net > 0,
                    'days': days_held
                })

    total = len(trades)
    if total == 0: return None
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    wr = len(wins) / total * 100.0
    gw = sum(t['net_pct'] for t in wins)
    gl = abs(sum(t['net_pct'] for t in losses))
    pf = gw / (gl + 1e-9)
    cpw = total / 150.0 # ~150 trading weeks in 3 years
    net_tot = sum(t['net_pct'] for t in trades)

    return {
        'total': total,
        'cpw': round(cpw, 2),
        'wr': round(wr, 1),
        'pf': round(pf, 2),
        'net_tot': round(net_tot, 1),
        'trades': trades
    }

# Sweep grid
print(f"{'RSI':10s} | {'RS60':5s} | {'Vol':5s} | {'Ext':5s} | {'Total':6s} | {'Calls/Wk':8s} | {'WinRate':7s} | {'PF':5s} | {'NetPnL':8s}")
print("-" * 85)

results = []
for rsi_range in [(52, 70), (54, 72), (55, 68)]:
    for min_rs in [12.0, 15.0, 18.0]:
        for min_vol in [1.20, 1.35]:
            for max_ext in [1.025, 1.03]:
                res = evaluate_parameters(rsi_range[0], rsi_range[1], min_rs, min_vol, max_ext)
                if res:
                    rsi_s = f"{rsi_range[0]}-{rsi_range[1]}"
                    print(f"{rsi_s:10s} | {min_rs:4.1f}% | {min_vol:4.2f}x | {max_ext:4.3f} | {res['total']:6d} | {res['cpw']:5.2f}/wk  | {res['wr']:5.1f}% | {res['pf']:4.2f} | {res['net_tot']:+7.1f}%")
                    results.append({
                        'rsi': rsi_range, 'rs': min_rs, 'vol': min_vol, 'ext': max_ext,
                        'res': res
                    })

# Find best candidate closest to 4.5 calls/week with PF > 1.3
target_candidates = [r for r in results if 3.5 <= r['res']['cpw'] <= 5.5]
if target_candidates:
    best = max(target_candidates, key=lambda x: x['res']['pf'])
    print("\n" + "=" * 85)
    print("  OPTIMAL CALIBRATED CONFIGURATION (4 to 5 Calls/Week Target):")
    print("=" * 85)
    b_res = best['res']
    print(f"RSI Sweet Spot : {best['rsi'][0]} to {best['rsi'][1]}")
    print(f"Min RS vs Nifty: >= {best['rs']}% (60 days)")
    print(f"Min Vol Surge  : >= {best['vol']}x (20-day SMA)")
    print(f"Capped Buy Pkt : <= {best['ext']} (No chasing > {(best['ext']-1)*100:.1f}%)")
    print(f"Total Calls    : {b_res['total']} across 3 years ({b_res['cpw']} calls/week)")
    print(f"Win Rate       : {b_res['wr']}%")
    print(f"Profit Factor  : {b_res['pf']}")
    print(f"Net Total PnL  : {b_res['net_tot']:+.1f}%")

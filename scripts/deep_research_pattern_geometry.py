"""
scripts/deep_research_pattern_geometry.py
-------------------------------------------
Comprehensive Quantitative Research & Backtest for Institutional Swing Patterns
"""

import os, json, math, time
import numpy as np
import pandas as pd

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = "data/ohlcv_3y/NIFTYBEES.json"
FRICTION_DECIMAL = 0.0028 # 0.28% round-trip friction

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def wilson_interval(wins, total, z=1.96):
    if total == 0: return (0.0, 0.0)
    p = wins / total
    denom = 1 + z**2 / total
    center = (p + z**2 / (2 * total)) / denom
    margin = z * math.sqrt((p * (1 - p) / total) + (z**2 / (4 * total**2))) / denom
    return (round(max(0.0, center - margin) * 100, 1), round(min(1.0, center + margin) * 100, 1))

def simulate_trade(entry_price, stop_price, target_price, highs, lows, closes, start_idx, max_hold=25):
    """Simulate execution bar by bar with 0.28% Zerodha friction."""
    effective_entry = entry_price * (1.0 + FRICTION_DECIMAL / 2.0)
    n = len(closes)
    
    # 2-Tranche Target Logic: T1 +5.0%, T2 +9.0% (or pattern target)
    t1 = effective_entry * 1.050
    t2 = max(target_price, effective_entry * 1.090)
    cur_stop = stop_price
    t1_hit = False
    
    for k in range(start_idx, min(start_idx + max_hold, n)):
        h = highs[k]
        l = lows[k]
        c = closes[k]
        
        # Check Stop
        if l <= cur_stop:
            exit_p = min(cur_stop, c) * (1.0 - FRICTION_DECIMAL / 2.0)
            if t1_hit:
                pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
            else:
                pnl = (exit_p - effective_entry) / effective_entry
            return {'pnl': pnl, 'bars': k - start_idx + 1, 'exit_reason': 'STOP', 'win': pnl > 0}
            
        # Check T1
        if not t1_hit and h >= t1:
            t1_hit = True
            cur_stop = max(cur_stop, effective_entry * 1.002) # Move stop to breakeven after securing T1
            
        # Check T2
        if t1_hit and h >= t2:
            exit_p = t2 * (1.0 - FRICTION_DECIMAL / 2.0)
            pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
            return {'pnl': pnl, 'bars': k - start_idx + 1, 'exit_reason': 'TARGET_FULL', 'win': True}
            
    # Time Exit
    exit_p = closes[min(start_idx + max_hold - 1, n - 1)] * (1.0 - FRICTION_DECIMAL / 2.0)
    if t1_hit:
        pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
    else:
        pnl = (exit_p - effective_entry) / effective_entry
    return {'pnl': pnl, 'bars': max_hold, 'exit_reason': 'TIME_EXIT', 'win': pnl > 0}

def load_data():
    with open(NIFTY_PATH, 'r') as f:
        n_candles = json.load(f)['candles']
    n_dates = [c[0][:10] for c in n_candles]
    n_closes = np.array([float(c[4]) for c in n_candles])
    n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
    n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

    files = [f for f in os.listdir(OHLCV_DIR) if f.endswith('.json') and f != 'NIFTYBEES.json']
    stock_data = []

    for f in files:
        sym = f.replace('.json', '')
        p = os.path.join(OHLCV_DIR, f)
        try:
            with open(p, 'r') as fp:
                d = json.load(fp)
            candles = d.get('candles', [])
            if len(candles) < 250:
                continue

            dates = [c[0][:10] for c in candles]
            opens = np.array([float(c[1]) for c in candles])
            highs = np.array([float(c[2]) for c in candles])
            lows = np.array([float(c[3]) for c in candles])
            closes = np.array([float(c[4]) for c in candles])
            volumes = np.array([float(c[5]) for c in candles])
            
            # Indicators
            ema20 = pd.Series(closes).ewm(span=20).mean().values
            ema50 = pd.Series(closes).ewm(span=50).mean().values
            ema200 = pd.Series(closes).ewm(span=200).mean().values
            rsi14 = calculate_rsi(closes, 14)
            vol_sma20 = pd.Series(volumes).rolling(20).mean().values
            
            stock_data.append({
                'sym': sym,
                'dates': dates,
                'opens': opens,
                'highs': highs,
                'lows': lows,
                'closes': closes,
                'volumes': volumes,
                'ema20': ema20,
                'ema50': ema50,
                'ema200': ema200,
                'rsi14': rsi14,
                'vol_sma20': vol_sma20,
                'n': len(dates)
            })
        except Exception:
            continue
            
    return n_map, stock_data

def run_deep_research():
    print("=" * 85)
    print("  DEEP QUANTITATIVE RESEARCH: TOLERANCE & TOUCH TIME GAPS")
    print("=" * 85)
    
    n_map, stock_data = load_data()
    print(f"Loaded {len(stock_data)} liquid stocks across 3 Years.")
    
    # Grid 1: Touch Gap Ablation (testing min bar gap between ceiling touches: 5d, 10d, 15d, 20d)
    print("\n--- PART 1: MINIMUM TIME GAP BETWEEN RESISTANCE TOUCHES ---")
    gaps_to_test = [5, 10, 15, 20]
    
    for gap in gaps_to_test:
        trades = []
        for s in stock_data:
            dates = s['dates']
            closes = s['closes']
            highs = s['highs']
            lows = s['lows']
            vols = s['volumes']
            vol_sma = s['vol_sma20']
            n = s['n']
            
            last_entry = -999
            for i in range(80, n - 26):
                if i - last_entry < 20: continue
                dt = dates[i]
                if dt not in n_map or not n_map[dt]['bull']: continue
                c_now = closes[i]
                
                # Check for Ascending Triangle with given gap
                win = 45
                w_highs = highs[i - win : i]
                w_lows = lows[i - win : i]
                ceil = np.max(w_highs)
                
                # Find distinct peaks near ceiling
                peak_indices = [p for p in range(len(w_highs)) if w_highs[p] >= ceil * 0.980]
                if len(peak_indices) < 2: continue
                
                # Separation check
                if peak_indices[-1] - peak_indices[0] < gap: continue
                
                # Intervening trough pullback check
                mid_trough = np.min(w_lows[peak_indices[0] : peak_indices[-1] + 1])
                if (ceil - mid_trough) / ceil < 0.035: continue # Must have real pullbacks, not a flat line
                
                # Breakout check
                if c_now > ceil and closes[i-1] <= ceil * 1.005 and vols[i] >= vol_sma[i-1] * 1.3:
                    # SL is mid trough or 1.5 ATR
                    sl = max(mid_trough, c_now * 0.94)
                    res = simulate_trade(c_now, sl, c_now * 1.10, highs, lows, closes, i + 1)
                    trades.append(res)
                    last_entry = i
                    
        wins = sum(1 for t in trades if t['win'])
        tot = len(trades)
        wr = (wins / tot * 100) if tot > 0 else 0
        pnls = [t['pnl'] for t in trades]
        gain_sum = sum(p for p in pnls if p > 0)
        loss_sum = abs(sum(p for p in pnls if p < 0))
        pf = (gain_sum / (loss_sum + 1e-9)) if loss_sum > 0 else 999.0
        print(f"Gap: {gap:2d} days | Total Trades: {tot:4d} | Win Rate: {wr:5.1f}% | Profit Factor: {pf:4.2f} | Net PnL: {sum(pnls)*100:+7.1f}%")

    # Grid 2: Resistance Line Tolerance (1.5%, 2.0%, 2.5%, 3.5%)
    print("\n--- PART 2: RESISTANCE LINE PERCENTAGE TOLERANCE ---")
    tolerances = [0.015, 0.020, 0.025, 0.035]
    for tol in tolerances:
        trades = []
        for s in stock_data:
            dates = s['dates']
            closes = s['closes']
            highs = s['highs']
            lows = s['lows']
            vols = s['volumes']
            vol_sma = s['vol_sma20']
            n = s['n']
            
            last_entry = -999
            for i in range(80, n - 26):
                if i - last_entry < 20: continue
                dt = dates[i]
                if dt not in n_map or not n_map[dt]['bull']: continue
                c_now = closes[i]
                
                win = 45
                w_highs = highs[i - win : i]
                w_lows = lows[i - win : i]
                ceil = np.max(w_highs)
                
                # Peaks matching within tolerance
                peak_indices = [p for p in range(len(w_highs)) if w_highs[p] >= ceil * (1.0 - tol)]
                if len(peak_indices) < 2: continue
                if peak_indices[-1] - peak_indices[0] < 12: continue
                
                mid_trough = np.min(w_lows[peak_indices[0] : peak_indices[-1] + 1])
                if (ceil - mid_trough) / ceil < 0.035: continue
                
                if c_now > ceil and closes[i-1] <= ceil * 1.005 and vols[i] >= vol_sma[i-1] * 1.3:
                    sl = max(mid_trough, c_now * 0.94)
                    res = simulate_trade(c_now, sl, c_now * 1.10, highs, lows, closes, i + 1)
                    trades.append(res)
                    last_entry = i
                    
        wins = sum(1 for t in trades if t['win'])
        tot = len(trades)
        wr = (wins / tot * 100) if tot > 0 else 0
        pnls = [t['pnl'] for t in trades]
        gain_sum = sum(p for p in pnls if p > 0)
        loss_sum = abs(sum(p for p in pnls if p < 0))
        pf = (gain_sum / (loss_sum + 1e-9)) if loss_sum > 0 else 999.0
        print(f"Tolerance: {tol*100:4.1f}% | Total Trades: {tot:4d} | Win Rate: {wr:5.1f}% | Profit Factor: {pf:4.2f} | Net PnL: {sum(pnls)*100:+7.1f}%")

if __name__ == "__main__":
    run_deep_research()

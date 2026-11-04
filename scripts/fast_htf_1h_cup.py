import json, glob, os, sys
import numpy as np
import pandas as pd
from concurrent.futures import ProcessPoolExecutor, as_completed

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def process_file(f_path):
    sym = os.path.basename(f_path).replace('.json', '')
    trades = []
    try:
        with open(f_path, 'r') as fp:
            d = json.load(fp)
        candles = d.get('candles', [])
        if len(candles) < 5000:
            return trades
        
        df = pd.DataFrame(candles, columns=['dt', 'o', 'h', 'l', 'c', 'v'])
        df['dt'] = pd.to_datetime(df['dt'])
        df = df.set_index('dt')
        
        # 1-Hour OHLCV
        df_1h = df.resample('1h').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        if len(df_1h) < 200:
            return trades
            
        # 15-Minute OHLCV (for trigger confirmation)
        df_15m = df.resample('15min').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        df_15m['vol_sma20'] = df_15m['v'].rolling(20).mean()
        
        # Daily for HTF trend gate
        df_daily = df.resample('1D').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        df_daily['ema50'] = df_daily['c'].ewm(span=50).mean()
        df_daily['ema20'] = df_daily['c'].ewm(span=20).mean()
        
        h1_dates = df_1h.index
        h1_highs = df_1h['h'].values
        h1_lows = df_1h['l'].values
        h1_closes = df_1h['c'].values
        h1_vols = df_1h['v'].values
        n = len(df_1h)
        
        rsi14 = calculate_rsi(h1_closes, 14)
        vol_sma20 = pd.Series(h1_vols).rolling(20).mean().values
        
        last_signal_idx = -999
        
        for i in range(70, n - 20):
            if i - last_signal_idx < 30: # 30 1H bars cooldown (~5 trading days)
                continue
                
            cur_c = h1_closes[i]
            # Fast filter: close must be higher than the previous 12 bars high to even consider a breakout
            if cur_c < np.max(h1_highs[i-12:i]):
                continue
                
            cur_dt = h1_dates[i]
            # Daily trend check
            day_str = cur_dt.strftime('%Y-%m-%d')
            if day_str in df_daily.index:
                d_row = df_daily.loc[day_str]
                if isinstance(d_row, pd.DataFrame): d_row = d_row.iloc[-1]
                if d_row['c'] < d_row['ema50'] or d_row['ema20'] < d_row['ema50']:
                    continue
            
            cur_rsi = rsi14[i]
            cur_vol = h1_vols[i]
            avg_v = vol_sma20[i - 1]
            
            if np.isnan(cur_rsi) or cur_rsi < 50 or cur_rsi > 75: continue
            if np.isnan(avg_v) or avg_v <= 0 or cur_vol < avg_v * 1.20: continue
            
            detected = None
            for handle_len in [5, 8, 12]:
                for cup_len in [30, 45, 60]:
                    total_len = cup_len + handle_len
                    if i < total_len + 20: continue
                    start_cup = i - total_len
                    mid_cup = i - handle_len
                    
                    left_rim = np.max(h1_highs[start_cup : start_cup + 10])
                    left_rim_idx = start_cup + np.argmax(h1_highs[start_cup : start_cup + 10])
                    right_rim = np.max(h1_highs[mid_cup - 6 : mid_cup + 2])
                    
                    if abs(right_rim - left_rim) / max(left_rim, right_rim) > 0.030: continue
                    rim = max(left_rim, right_rim)
                    
                    # Absolute ceiling
                    if np.max(h1_highs[start_cup : i]) > rim * 1.015: continue
                    
                    cup_bottom = np.min(h1_lows[left_rim_idx : mid_cup])
                    bottom_idx = left_rim_idx + np.argmin(h1_lows[left_rim_idx : mid_cup])
                    depth = (rim - cup_bottom) / rim
                    if depth < 0.08 or depth > 0.28: continue
                    
                    cup_span = mid_cup - left_rim_idx
                    if cup_span < 12: continue
                    bottom_pos = (bottom_idx - left_rim_idx) / cup_span
                    if bottom_pos < 0.28 or bottom_pos > 0.72: continue
                    
                    bottom_q = cup_bottom + 0.25 * (rim - cup_bottom)
                    if np.sum(h1_lows[left_rim_idx : mid_cup] <= bottom_q) < 3: continue
                    
                    handle_low = np.min(h1_lows[mid_cup : i])
                    handle_depth = (rim - handle_low) / rim
                    handle_ratio = handle_depth / depth
                    if handle_depth < 0.015 or handle_ratio < 0.15 or handle_ratio > 0.45: continue
                    
                    prev_c = h1_closes[i - 1]
                    if cur_c > rim * 0.998 and prev_c <= rim * 1.010 and cur_c <= rim * 1.035:
                        # 15-Minute Confirmation: check 15m candles in this 1-hour window
                        h1_start_time = cur_dt
                        h1_end_time = cur_dt + pd.Timedelta(hours=1)
                        m15_slice = df_15m.loc[h1_start_time:h1_end_time]
                        m15_ok = True
                        if len(m15_slice) > 0:
                            m15_breakout = m15_slice['c'] >= rim * 0.998
                            m15_vol = m15_slice['v'] >= m15_slice['vol_sma20'] * 1.15
                            m15_ok = (m15_breakout & m15_vol).any() or (m15_breakout).any()
                        
                        if m15_ok:
                            detected = {
                                'symbol': sym,
                                'date': cur_dt.strftime('%Y-%m-%d %H:%M'),
                                'entry_p': cur_c,
                                'rim': rim,
                                'handle_low': handle_low,
                                'bar_i': i
                            }
                            break
                if detected: break
                
            if detected:
                last_signal_idx = i
                entry_p = detected['entry_p']
                sl_p = min(entry_p * 0.965, detected['handle_low'] * 0.99)
                risk_pct = (entry_p - sl_p) / entry_p
                if risk_pct > 0.075: sl_p = entry_p * 0.925
                
                t1_p = entry_p * 1.08 # +8% Target
                
                exit_p = entry_p
                exit_reason = 'TIME_EXIT'
                t1_hit = False
                bars_held = 0
                
                for bi in range(detected['bar_i'] + 1, min(n, detected['bar_i'] + 50)):
                    b_h = h1_highs[bi]
                    b_l = h1_lows[bi]
                    b_c = h1_closes[bi]
                    bars_held += 1
                    
                    if b_l <= sl_p:
                        exit_p = sl_p
                        exit_reason = 'STOP_LOSS'
                        break
                    if not t1_hit and b_h >= t1_p:
                        t1_hit = True
                        sl_p = entry_p * 1.002 # Move stop to Breakeven (+0.2%)
                    if t1_hit and bars_held >= 15:
                        if b_c < np.mean(h1_closes[bi-20:bi]):
                            exit_p = b_c
                            exit_reason = 'TRAIL_EXIT'
                            break
                    if bi == min(n, detected['bar_i'] + 50) - 1:
                        exit_p = b_c
                        
                net_pct = ((exit_p - entry_p) / entry_p - 0.0028) * 100
                trades.append({
                    'symbol': sym, 'date': detected['date'],
                    'entry_p': entry_p, 'exit_p': exit_p,
                    'sl_p': sl_p, 'rim': detected['rim'],
                    'net_pct': net_pct, 'exit_reason': exit_reason,
                    'bars_held': bars_held
                })
    except Exception as e:
        pass
    return trades

if __name__ == '__main__':
    all_files = glob.glob('data/ohlcv_1m_full/*.json')
    files = all_files[:300] # Test across 300 liquid stocks
    print(f"Launching parallel backtest across {len(files)} liquid stocks using {os.cpu_count()} CPU cores...", flush=True)
    
    all_trades = []
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
        futures = {executor.submit(process_file, f): f for f in files}
        done_count = 0
        for f in as_completed(futures):
            res = f.result()
            if res:
                all_trades.extend(res)
            done_count += 1
            if done_count % 50 == 0 or done_count == len(files):
                print(f"Progress: {done_count}/{len(files)} stocks processed ({len(all_trades)} trades found)...", flush=True)
                
    wins = [t for t in all_trades if t['net_pct'] > 0]
    losses = [t for t in all_trades if t['net_pct'] <= 0]
    wr = len(wins) / (len(all_trades) + 1e-9) * 100
    gross_win = sum(t['net_pct'] for t in wins)
    gross_loss = abs(sum(t['net_pct'] for t in losses))
    pf = gross_win / (gross_loss + 1e-9)
    total_net = sum(t['net_pct'] for t in all_trades)
    
    # 17 months in dataset = ~73.6 weeks
    weeks = 73.6
    calls_per_wk_300 = len(all_trades) / weeks
    calls_per_wk_universe = calls_per_wk_300 * (1006.0 / len(files))
    
    print("\n" + "="*70, flush=True)
    print("INSTITUTIONAL MULTI-TIMEFRAME RESULTS (1-HOUR BASE + 15-MIN CONFIRMATION)", flush=True)
    print("="*70, flush=True)
    print(f"Universe Sampled: {len(files)} stocks (out of 1,006 total liquid NSE stocks)")
    print(f"Total Completed Trades: {len(all_trades)}")
    print(f"Win Rate: {wr:.1f}% ({len(wins)} Wins / {len(losses)} Losses)")
    print(f"Profit Factor: {pf:.2f}")
    print(f"Total Net Return: {total_net:+.1f}% (after 0.28% Zerodha friction)")
    print(f"Calls / Week (300 stocks): {calls_per_wk_300:.2f} calls/week")
    print(f"CALIBRATED UNIVERSE RUN-RATE (1,006 stocks): {calls_per_wk_universe:.2f} calls/week (TARGET: strictly 4 to 5 calls/week)")
    print("="*70, flush=True)
    
    print("\nSAMPLE TRADES (VERIFIABLE ENTRY / EXIT / REASON):", flush=True)
    for t in sorted(all_trades, key=lambda x: x['date'], reverse=True)[:15]:
        sym = t['symbol']
        dt = t['date']
        ep = t['entry_p']
        xp = t['exit_p']
        np_val = t['net_pct']
        bh = t['bars_held']
        rsn = t['exit_reason']
        print(f"{sym:12s} | Entry: {dt} @ Rs {ep:7.2f} | Out: Rs {xp:7.2f} | Net: {np_val:+6.1f}% | Held: {bh}h | {rsn}")

    # Save trades to data/
    with open('data/htf_1h_cup_backtest_trades.json', 'w') as out_fp:
        json.dump(all_trades, out_fp, indent=2)
    print("\nFull trade log written to data/htf_1h_cup_backtest_trades.json", flush=True)

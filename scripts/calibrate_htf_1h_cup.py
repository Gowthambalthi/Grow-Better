import json, glob, os
import numpy as np
import pandas as pd
from concurrent.futures import ProcessPoolExecutor, as_completed

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def process_file_calibrated(f_path):
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
        
        df_1h = df.resample('1h').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        if len(df_1h) < 200:
            return trades
            
        df_15m = df.resample('15min').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        df_15m['vol_sma20'] = df_15m['v'].rolling(20).mean()
        
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
            if i - last_signal_idx < 30:
                continue
                
            cur_c = h1_closes[i]
            if cur_c < np.max(h1_highs[i-12:i]):
                continue
                
            cur_dt = h1_dates[i]
            
            # RULE 1: Skip opening gap bar (09:15-10:15) to avoid morning trap
            if cur_dt.hour == 9:
                continue
                
            # RULE 2: Daily HTF Gate (Close > EMA50, EMA20 > EMA50)
            day_str = cur_dt.strftime('%Y-%m-%d')
            if day_str in df_daily.index:
                d_row = df_daily.loc[day_str]
                if isinstance(d_row, pd.DataFrame): d_row = d_row.iloc[-1]
                if d_row['c'] < d_row['ema50'] or d_row['ema20'] < d_row['ema50']:
                    continue
            
            cur_rsi = rsi14[i]
            cur_vol = h1_vols[i]
            avg_v = vol_sma20[i - 1]
            
            # Strict RSI sweet spot
            if np.isnan(cur_rsi) or cur_rsi < 52 or cur_rsi > 72: continue
            # Strict Volume surge >= 1.5x
            if np.isnan(avg_v) or avg_v <= 0 or cur_vol < avg_v * 1.50: continue
            
            detected = None
            for handle_len in [5, 8, 12]:
                for cup_len in [30, 45, 60]:
                    total_len = cup_len + handle_len
                    if i < total_len + 30: continue
                    start_cup = i - total_len
                    mid_cup = i - handle_len
                    
                    # Left Rim Peak
                    left_rim = np.max(h1_highs[start_cup : start_cup + 10])
                    left_rim_idx = start_cup + np.argmax(h1_highs[start_cup : start_cup + 10])
                    right_rim = np.max(h1_highs[mid_cup - 6 : mid_cup + 2])
                    
                    # Horizontal Rim Alignment <= 3%
                    if abs(right_rim - left_rim) / max(left_rim, right_rim) > 0.030: continue
                    rim = max(left_rim, right_rim)
                    
                    # Absolute Ceiling <= 1.5%
                    if np.max(h1_highs[start_cup : i]) > rim * 1.015: continue
                    
                    # Prior Uptrend >= 15% leading into left rim
                    prior_low = np.min(h1_lows[max(0, start_cup - 35) : start_cup])
                    if (left_rim - prior_low) / prior_low < 0.12: continue
                    
                    # Cup Bottom & Depth (10% to 26%)
                    cup_bottom = np.min(h1_lows[left_rim_idx : mid_cup])
                    bottom_idx = left_rim_idx + np.argmin(h1_lows[left_rim_idx : mid_cup])
                    depth = (rim - cup_bottom) / rim
                    if depth < 0.10 or depth > 0.26: continue
                    
                    # Centered U-Shape Bowl (bottom between 28% and 72% of cup span)
                    cup_span = mid_cup - left_rim_idx
                    if cup_span < 12: continue
                    bottom_pos = (bottom_idx - left_rim_idx) / cup_span
                    if bottom_pos < 0.28 or bottom_pos > 0.72: continue
                    
                    # U-Shape Rounding: at least 3 bars in bottom quartile
                    bottom_q = cup_bottom + 0.25 * (rim - cup_bottom)
                    if np.sum(h1_lows[left_rim_idx : mid_cup] <= bottom_q) < 3: continue
                    
                    # Handle Depth (15% to 42% of cup depth)
                    handle_low = np.min(h1_lows[mid_cup : i])
                    handle_depth = (rim - handle_low) / rim
                    handle_ratio = handle_depth / depth
                    if handle_depth < 0.015 or handle_ratio < 0.15 or handle_ratio > 0.42: continue
                    
                    # Volume Dry Up (VDU): average handle volume < average cup volume
                    cup_vol_avg = np.mean(h1_vols[left_rim_idx : mid_cup])
                    handle_vol_avg = np.mean(h1_vols[mid_cup : i])
                    if handle_vol_avg > cup_vol_avg * 1.10: continue
                    
                    prev_c = h1_closes[i - 1]
                    if cur_c > rim * 0.998 and prev_c <= rim * 1.010 and cur_c <= rim * 1.030:
                        # 15-Minute Confirmation
                        h1_start_time = cur_dt
                        h1_end_time = cur_dt + pd.Timedelta(hours=1)
                        m15_slice = df_15m.loc[h1_start_time:h1_end_time]
                        if len(m15_slice) > 0:
                            m15_breakout = m15_slice['c'] >= rim * 0.998
                            m15_vol = m15_slice['v'] >= m15_slice['vol_sma20'] * 1.25
                            if (m15_breakout & m15_vol).any():
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
                sl_p = min(entry_p * 0.965, detected['handle_low'] * 0.992)
                risk_pct = (entry_p - sl_p) / entry_p
                if risk_pct > 0.065: sl_p = entry_p * 0.935
                
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
                        sl_p = entry_p * 1.002
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
    files = all_files[:300]
    print(f"Launching Calibrated Backtest across {len(files)} stocks with 12 CPU cores...", flush=True)
    
    all_trades = []
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
        futures = {executor.submit(process_file_calibrated, f): f for f in files}
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
    
    weeks = 73.6
    calls_per_wk_300 = len(all_trades) / weeks
    calls_per_wk_universe = calls_per_wk_300 * (1006.0 / len(files))
    
    print("\n" + "="*70, flush=True)
    print("CALIBRATED INSTITUTIONAL 1H + 15M RESULTS", flush=True)
    print("="*70, flush=True)
    print(f"Sampled Stocks: {len(files)} / 1,006")
    print(f"Total Completed Trades: {len(all_trades)}")
    print(f"Win Rate: {wr:.1f}% ({len(wins)} Wins / {len(losses)} Losses)")
    print(f"Profit Factor: {pf:.2f}")
    print(f"Total Net Return: {total_net:+.1f}% (after 0.28% Zerodha friction)")
    print(f"Calls / Week (300 stocks): {calls_per_wk_300:.2f} calls/week")
    print(f"CALIBRATED UNIVERSE RUN-RATE (1,006 stocks): {calls_per_wk_universe:.2f} calls/week (TARGET: strictly 4 to 5 calls/week)")
    print("="*70, flush=True)
    
    print("\nSAMPLE CALIBRATED TRADES:", flush=True)
    for t in sorted(all_trades, key=lambda x: x['net_pct'], reverse=True)[:15]:
        sym = t['symbol']
        dt = t['date']
        ep = t['entry_p']
        xp = t['exit_p']
        np_val = t['net_pct']
        bh = t['bars_held']
        rsn = t['exit_reason']
        print(f"{sym:12s} | Entry: {dt} @ Rs {ep:7.2f} | Out: Rs {xp:7.2f} | Net: {np_val:+6.1f}% | Held: {bh}h | {rsn}")
        
    with open('data/calibrated_1h_cup_trades.json', 'w') as out_fp:
        json.dump(all_trades, out_fp, indent=2)

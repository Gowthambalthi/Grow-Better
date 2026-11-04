import json, os, glob
import pandas as pd
import numpy as np
from concurrent.futures import ProcessPoolExecutor, as_completed

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

with open('data/ohlcv_3y/NIFTYBEES.json', 'r') as fp:
    nifty_raw = json.load(fp)
df_nifty = pd.DataFrame(nifty_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
df_nifty['dt'] = pd.to_datetime(df_nifty['dt'])
df_nifty = df_nifty.set_index('dt')

def process_file(f_path):
    sym = os.path.basename(f_path).replace('.json', '')
    trades = []
    try:
        with open(f_path, 'r') as fp:
            d = json.load(fp)
        candles = d.get('candles', [])
        if len(candles) < 5000: return trades
        
        df = pd.DataFrame(candles, columns=['dt', 'o', 'h', 'l', 'c', 'v'])
        df['dt'] = pd.to_datetime(df['dt'])
        df = df.set_index('dt')
        
        df_1h = df.resample('1h').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        if len(df_1h) < 200: return trades
        
        df_15m = df.resample('15min').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        df_15m['vol_sma20'] = df_15m['v'].rolling(20).mean()
        
        df_daily = df.resample('1D').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
        df_daily['ema50'] = df_daily['c'].ewm(span=50).mean()
        df_daily['ema20'] = df_daily['c'].ewm(span=20).mean()
        df_daily['ema200'] = df_daily['c'].ewm(span=200).mean()
        
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
            if i - last_signal_idx < 30: continue
            cur_c = h1_closes[i]
            if cur_c < np.max(h1_highs[i-12:i]): continue
            cur_dt = h1_dates[i]
            if cur_dt.hour == 9: continue # Skip opening trap
            
            # Daily Trend Gate
            day_str = cur_dt.strftime('%Y-%m-%d')
            if day_str in df_daily.index:
                d_row = df_daily.loc[day_str]
                if isinstance(d_row, pd.DataFrame): d_row = d_row.iloc[-1]
                if d_row['c'] < d_row['ema50'] or d_row['ema20'] < d_row['ema50']:
                    continue
                # Anti-Climax: Distance from 200 EMA <= 50%
                if d_row['c'] > d_row['ema200'] * 1.50:
                    continue
                    
            # RELATIVE STRENGTH (RS) GATE vs NIFTY >= +15%
            s_daily_sub = df_daily.loc[:cur_dt]
            n_sub = df_nifty.loc[:cur_dt]
            lookback = min(45, len(s_daily_sub) - 1, len(n_sub) - 1)
            if lookback >= 25:
                s_ret = (s_daily_sub['c'].iloc[-1] - s_daily_sub['c'].iloc[-lookback]) / s_daily_sub['c'].iloc[-lookback] * 100
                n_ret = (n_sub['c'].iloc[-1] - n_sub['c'].iloc[-lookback]) / n_sub['c'].iloc[-lookback] * 100
                rs_outperf = s_ret - n_ret
                if rs_outperf < 15.0: # Must outperform NIFTY by at least +15%
                    continue
            else:
                continue
                
            cur_rsi = rsi14[i]
            cur_vol = h1_vols[i]
            avg_v = vol_sma20[i - 1]
            if np.isnan(cur_rsi) or cur_rsi < 52 or cur_rsi > 72: continue
            if np.isnan(avg_v) or avg_v <= 0 or cur_vol < avg_v * 1.50: continue
            
            detected = None
            for handle_len in [5, 8, 12]:
                for cup_len in [30, 45, 60]:
                    total_len = cup_len + handle_len
                    if i < total_len + 30: continue
                    start_cup = i - total_len
                    mid_cup = i - handle_len
                    
                    left_rim = np.max(h1_highs[start_cup : start_cup + 10])
                    left_rim_idx = start_cup + np.argmax(h1_highs[start_cup : start_cup + 10])
                    right_rim = np.max(h1_highs[mid_cup - 6 : mid_cup + 2])
                    
                    if abs(right_rim - left_rim) / max(left_rim, right_rim) > 0.030: continue
                    rim = max(left_rim, right_rim)
                    if np.max(h1_highs[start_cup : i]) > rim * 1.015: continue
                    
                    prior_low = np.min(h1_lows[max(0, start_cup - 35) : start_cup])
                    if (left_rim - prior_low) / prior_low < 0.12: continue
                    
                    cup_bottom = np.min(h1_lows[left_rim_idx : mid_cup])
                    bottom_idx = left_rim_idx + np.argmin(h1_lows[left_rim_idx : mid_cup])
                    depth = (rim - cup_bottom) / rim
                    if depth < 0.10 or depth > 0.26: continue
                    
                    cup_span = mid_cup - left_rim_idx
                    if cup_span < 12: continue
                    bottom_pos = (bottom_idx - left_rim_idx) / cup_span
                    if bottom_pos < 0.28 or bottom_pos > 0.72: continue
                    
                    bottom_q = cup_bottom + 0.25 * (rim - cup_bottom)
                    if np.sum(h1_lows[left_rim_idx : mid_cup] <= bottom_q) < 3: continue
                    
                    handle_low = np.min(h1_lows[mid_cup : i])
                    handle_depth = (rim - handle_low) / rim
                    handle_ratio = handle_depth / depth
                    if handle_depth < 0.015 or handle_ratio < 0.15 or handle_ratio > 0.42: continue
                    
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
                                    'bar_i': i,
                                    'rs_outperf': rs_outperf
                                }
                                break
                if detected: break
                
            if detected:
                last_signal_idx = i
                entry_p = detected['entry_p']
                sl_p = min(entry_p * 0.965, detected['handle_low'] * 0.992)
                risk_pct = (entry_p - sl_p) / entry_p
                if risk_pct > 0.065: sl_p = entry_p * 0.935
                
                # High Profit Multi-Target System:
                # T1 (+5.0%): Take 50% Profit, Move SL to Breakeven (+0.2%)
                # T2 (+9.0%): Runner trailing exit
                t1_p = entry_p * 1.050
                t2_p = entry_p * 1.090
                t1_hit = False
                exit_p = entry_p
                exit_reason = 'TIME_EXIT'
                bars_held = 0
                
                for bi in range(detected['bar_i'] + 1, min(n, detected['bar_i'] + 50)):
                    b_h = h1_highs[bi]
                    b_l = h1_lows[bi]
                    b_c = h1_closes[bi]
                    bars_held += 1
                    
                    if b_l <= sl_p:
                        exit_p = sl_p
                        exit_reason = 'STOP_LOSS' if not t1_hit else 'BREAKEVEN_EXIT'
                        break
                        
                    if not t1_hit and b_h >= t1_p:
                        t1_hit = True
                        sl_p = max(sl_p, entry_p * 1.002) # Breakeven protection
                        
                    if t1_hit and b_h >= t2_p:
                        exit_p = t2_p
                        exit_reason = 'TARGET_2'
                        break
                        
                    if t1_hit and bars_held >= 15:
                        if b_c < np.mean(h1_closes[bi-20:bi]):
                            exit_p = b_c
                            exit_reason = 'TRAIL_EXIT'
                            break
                            
                    if bi == min(n, detected['bar_i'] + 50) - 1:
                        exit_p = b_c
                        
                # 50/50 Blended Return: If T1 was hit, 50% sold at T1, 50% sold at exit_p
                if t1_hit:
                    avg_exit = 0.5 * t1_p + 0.5 * exit_p
                else:
                    avg_exit = exit_p
                    
                net_pct = ((avg_exit - entry_p) / entry_p - 0.0028) * 100
                trades.append({
                    'symbol': sym, 'date': detected['date'],
                    'entry_p': entry_p, 'exit_p': avg_exit,
                    'sl_p': sl_p, 'rim': detected['rim'],
                    'net_pct': net_pct, 'exit_reason': exit_reason,
                    'bars_held': bars_held,
                    'rs_outperf': detected['rs_outperf'],
                    't1_hit': t1_hit
                })
    except Exception as e:
        pass
    return trades

if __name__ == '__main__':
    all_files = glob.glob('data/ohlcv_1m_full/*.json')
    files = all_files[:300]
    print(f"Launching RS + Climax Guard Backtest across {len(files)} stocks with 12 cores...", flush=True)
    
    all_trades = []
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as executor:
        futures = {executor.submit(process_file, f): f for f in files}
        for f in as_completed(futures):
            res = f.result()
            if res: all_trades.extend(res)
            
    wins = [t for t in all_trades if t['net_pct'] > 0]
    losses = [t for t in all_trades if t['net_pct'] <= 0]
    wr = len(wins) / (len(all_trades) + 1e-9) * 100
    gross_win = sum(t['net_pct'] for t in wins)
    gross_loss = abs(sum(t['net_pct'] for t in losses))
    pf = gross_win / (gross_loss + 1e-9)
    total_net = sum(t['net_pct'] for t in all_trades)
    
    print("\n" + "="*85)
    print("FINAL CALIBRATED RS-POWERED 1-HOUR CUP & HANDLE SYSTEM")
    print("="*85)
    print(f"Universe Sampled: {len(files)} stocks (17 Months Tape Data)")
    print(f"Total Completed Trades: {len(all_trades)}")
    print(f"Win Rate: {wr:.1f}% ({len(wins)} Wins / {len(losses)} Losses)")
    print(f"PROFIT FACTOR: {pf:.2f}")
    print(f"TOTAL NET RETURN: {total_net:+.2f}% (AFTER 0.28% Zerodha friction)")
    print("="*85)
    
    print("\nWINNING STOCKS:")
    for t in sorted(wins, key=lambda x: x['net_pct'], reverse=True):
        print(f"  WIN  | {t['symbol']:10s} | {t['date']:16s} | Entry: Rs {t['entry_p']:7.2f} | Out: Rs {t['exit_p']:7.2f} | Net: {t['net_pct']:+6.2f}% | RS: {t['rs_outperf']:+6.1f}% | {t['exit_reason']}")
        
    print("\nLOSING STOCKS:")
    for t in sorted(losses, key=lambda x: x['net_pct']):
        print(f"  LOSS | {t['symbol']:10s} | {t['date']:16s} | Entry: Rs {t['entry_p']:7.2f} | Out: Rs {t['exit_p']:7.2f} | Net: {t['net_pct']:+6.2f}% | RS: {t['rs_outperf']:+6.1f}% | {t['exit_reason']}")
        
    with open('data/rs_calibrated_final_trades.json', 'w') as out_fp:
        json.dump(all_trades, out_fp, indent=2)

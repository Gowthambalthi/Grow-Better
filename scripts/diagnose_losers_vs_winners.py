import json, os
import pandas as pd
import numpy as np

with open('data/calibrated_1h_cup_trades.json') as fp:
    trades = json.load(fp)

with open('data/ohlcv_3y/NIFTYBEES.json') as fp:
    n_raw = json.load(fp)
df_nifty = pd.DataFrame(n_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
df_nifty['dt'] = pd.to_datetime(df_nifty['dt'])
df_nifty = df_nifty.set_index('dt')
df_nifty['ema50'] = df_nifty['c'].ewm(span=50).mean()

print("="*115)
print(f"{'SYM':10s} | {'DATE':16s} | {'TYPE':5s} | {'NET%':6s} | {'RS 60d%':8s} | {'NIFTY>EMA50':11s} | {'DIST 200EMA%':12s} | {'STOP%':8s}")
print("="*115)

for t in trades:
    sym = t['symbol']
    dt_str = t['date']
    t_dt = pd.to_datetime(dt_str)
    
    with open(f'data/ohlcv_1m_full/{sym}.json') as sfp:
        s_raw = json.load(sfp)
    s_df = pd.DataFrame(s_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
    s_df['dt'] = pd.to_datetime(s_df['dt'])
    s_df = s_df.set_index('dt')
    s_daily = s_df.resample('1D').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last'}).dropna()
    s_daily['ema200'] = s_daily['c'].ewm(span=200).mean()
    
    s_sub = s_daily.loc[:t_dt]
    n_sub = df_nifty.loc[:t_dt]
    
    n_last = n_sub.iloc[-1]
    n_market_ok = n_last['c'] > n_last['ema50']
    
    lookback = min(45, len(s_sub) - 1, len(n_sub) - 1)
    if lookback > 10:
        s_ret = (s_sub['c'].iloc[-1] - s_sub['c'].iloc[-lookback]) / s_sub['c'].iloc[-lookback] * 100
        n_ret = (n_sub['c'].iloc[-1] - n_sub['c'].iloc[-lookback]) / n_sub['c'].iloc[-lookback] * 100
        rs_60d = s_ret - n_ret
    else:
        rs_60d = 0.0
        
    cur_c = s_sub['c'].iloc[-1]
    cur_ema200 = s_sub['ema200'].iloc[-1]
    dist_200 = (cur_c - cur_ema200) / cur_ema200 * 100
    
    t_type = "WIN" if t['net_pct'] > 0 else "LOSS"
    n_ok_str = "BULL (YES)" if n_market_ok else "BEAR (NO!)"
    stop_dist = (t['entry_p'] - t['sl_p']) / t['entry_p'] * 100
    
    print(f"{sym:10s} | {dt_str:16s} | {t_type:5s} | {t['net_pct']:+5.1f}% | {rs_60d:+7.1f}% | {n_ok_str:11s} | {dist_200:+11.1f}% | {stop_dist:6.1f}%")

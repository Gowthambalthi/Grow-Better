import json, os
import pandas as pd
import numpy as np

# Load 3-year NIFTYBEES daily data
with open('data/ohlcv_3y/NIFTYBEES.json', 'r') as fp:
    nifty_raw = json.load(fp)

df_nifty = pd.DataFrame(nifty_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
df_nifty['dt'] = pd.to_datetime(df_nifty['dt'])
df_nifty = df_nifty.set_index('dt')

with open('data/calibrated_1h_cup_trades.json') as fp:
    trades = json.load(fp)

print("="*105)
print(f"{'SYMBOL':12s} | {'DATE':16s} | {'TYPE':7s} | {'NET %':7s} | {'STOCK 60d%':11s} | {'NIFTY 60d%':11s} | {'RS OUTPERF':11s} | {'EXIT REASON':12s}")
print("="*105)

results = []

for t in trades:
    sym = t['symbol']
    dt_str = t['date']
    t_dt = pd.to_datetime(dt_str)
    
    # Load stock daily from 1m or 3y
    f_path = f'data/ohlcv_1m_full/{sym}.json'
    f_path_3y = f'data/ohlcv_3y/{sym}.json'
    s_daily = None
    
    if os.path.exists(f_path_3y):
        try:
            with open(f_path_3y, 'r') as sfp:
                s_raw = json.load(sfp)
            s_df = pd.DataFrame(s_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
            s_df['dt'] = pd.to_datetime(s_df['dt'])
            s_daily = s_df.set_index('dt')
        except:
            pass
            
    if s_daily is None and os.path.exists(f_path):
        try:
            with open(f_path, 'r') as sfp:
                s_raw = json.load(sfp)
            s_df = pd.DataFrame(s_raw['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
            s_df['dt'] = pd.to_datetime(s_df['dt'])
            s_df = s_df.set_index('dt')
            s_daily = s_df.resample('1D').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last'}).dropna()
        except:
            pass
            
    if s_daily is not None:
        s_sub = s_daily.loc[:t_dt]
        n_sub = df_nifty.loc[:t_dt]
        
        lookback = 45 # 45 to 60 trading days (~2 to 3 months)
        if len(s_sub) >= lookback and len(n_sub) >= lookback:
            s_ret = (s_sub['c'].iloc[-1] - s_sub['c'].iloc[-lookback]) / s_sub['c'].iloc[-lookback] * 100
            n_ret = (n_sub['c'].iloc[-1] - n_sub['c'].iloc[-lookback]) / n_sub['c'].iloc[-lookback] * 100
            rs = s_ret - n_ret
        else:
            s_ret, n_ret, rs = np.nan, np.nan, np.nan
            
        t_type = "WIN" if t['net_pct'] > 0 else "LOSS"
        results.append({
            'symbol': sym, 'date': dt_str, 'type': t_type,
            'net_pct': t['net_pct'], 's_ret': s_ret, 'n_ret': n_ret, 'rs': rs,
            'exit_reason': t['exit_reason'], 'sl_p': t['sl_p'], 'entry_p': t['entry_p']
        })
        print(f"{sym:12s} | {dt_str:16s} | {t_type:7s} | {t['net_pct']:+6.2f}% | {s_ret:+9.2f}% | {n_ret:+9.2f}% | {rs:+9.2f}% | {t['exit_reason']:12s}")

print("="*105)
win_rs = [r['rs'] for r in results if r['type'] == 'WIN' and not np.isnan(r['rs'])]
loss_rs = [r['rs'] for r in results if r['type'] == 'LOSS' and not np.isnan(r['rs'])]
print(f"Average Relative Strength (RS) for WINNERS: {np.mean(win_rs):+.2f}%")
print(f"Average Relative Strength (RS) for LOSERS:  {np.mean(loss_rs):+.2f}%")

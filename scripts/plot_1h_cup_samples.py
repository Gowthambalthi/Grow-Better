import json, os
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

def plot_trade(sym, entry_dt_str, rim_price, sl_price, exit_p, out_name):
    f_path = f'data/ohlcv_1m_full/{sym}.json'
    if not os.path.exists(f_path):
        print(f"File {f_path} not found")
        return
        
    with open(f_path, 'r') as fp:
        d = json.load(fp)
    df = pd.DataFrame(d['candles'], columns=['dt', 'o', 'h', 'l', 'c', 'v'])
    df['dt'] = pd.to_datetime(df['dt'])
    df = df.set_index('dt')
    
    # Resample to 1-Hour
    df_1h = df.resample('1h').agg({'o': 'first', 'h': 'max', 'l': 'min', 'c': 'last', 'v': 'sum'}).dropna()
    
    entry_dt = pd.to_datetime(entry_dt_str)
    # Find index of entry
    sub = df_1h.loc[:entry_dt + pd.Timedelta(days=12)]
    plot_sub = sub.tail(75) # 75 bars of 1H
    
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
    fig.patch.set_facecolor('#0e1117')
    ax1.set_facecolor('#0e1117')
    ax2.set_facecolor('#0e1117')
    
    dates = plot_sub.index
    opens = plot_sub['o'].values
    highs = plot_sub['h'].values
    lows = plot_sub['l'].values
    closes = plot_sub['c'].values
    vols = plot_sub['v'].values
    
    # Plot candlesticks
    width = 0.03
    width2 = 0.005
    for i in range(len(dates)):
        d_val = mdates.date2num(dates[i])
        c_val = closes[i]
        o_val = opens[i]
        h_val = highs[i]
        l_val = lows[i]
        col = '#00e676' if c_val >= o_val else '#ff5252'
        
        ax1.plot([d_val, d_val], [l_val, h_val], color=col, linewidth=1.2)
        rect_bottom = min(o_val, c_val)
        rect_height = abs(c_val - o_val)
        ax1.bar(d_val, rect_height, bottom=rect_bottom, width=width, color=col, edgecolor=col)
        
        v_col = '#00e676' if c_val >= o_val else '#ff5252'
        ax2.bar(d_val, vols[i], width=width, color=v_col, alpha=0.7)
        
    # Draw Rim Resistance Line
    d_start = mdates.date2num(dates[0])
    d_end = mdates.date2num(dates[-1])
    ax1.axhline(rim_price, color='#ffd600', linestyle='--', linewidth=2, label=f'Cup Rim (Rs {rim_price:.2f})')
    
    # Entry annotation
    d_entry = mdates.date2num(entry_dt)
    ax1.scatter([d_entry], [rim_price * 1.005], color='#00e5ff', s=120, zorder=5, marker='^', label='15m Breakout Buy Trigger')
    ax1.axhline(sl_price, color='#ff1744', linestyle=':', linewidth=1.5, label=f'Handle SL (Rs {sl_price:.2f})')
    
    ax1.set_title(f"1-HOUR TEXTBOOK CUP & HANDLE: {sym} (Entry: {entry_dt_str})", color='#ffffff', fontsize=14, fontweight='bold', pad=12)
    ax1.set_ylabel("Price (INR)", color='#e0e0e0', fontsize=11)
    ax1.grid(True, color='#262a36', linestyle='--', alpha=0.6)
    ax1.tick_params(colors='#e0e0e0')
    ax1.legend(loc='upper left', facecolor='#161b22', edgecolor='#30363d', labelcolor='#ffffff')
    
    ax2.set_ylabel("1H Volume", color='#e0e0e0', fontsize=11)
    ax2.grid(True, color='#262a36', linestyle='--', alpha=0.6)
    ax2.tick_params(colors='#e0e0e0')
    ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b %d %H:%M'))
    fig.autofmt_xdate()
    
    plt.tight_layout()
    plt.savefig(out_name, dpi=180, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print(f"Chart saved to {out_name}")

if __name__ == '__main__':
    art_dir = r'C:/Users/goutham/.gemini/antigravity/brain/9c0e395d-4da1-41cb-8c07-6407a7c69969'
    plot_trade('DALMIASUG', '2026-08-17 11:00', 439.7, 428.0, 497.05, f'{art_dir}/dalmiasug_1h_cup_trade.png')
    plot_trade('ADSL', '2024-06-28 12:00', 172.5, 164.5, 224.11, f'{art_dir}/adsl_1h_cup_trade.png')
    plot_trade('CENTUM', '2026-09-21 10:00', 4421.0, 4280.0, 4804.0, f'{art_dir}/centum_1h_cup_trade.png')

"""
scripts/generate_pattern_visuals.py
------------------------------------
Generates high-resolution annotated charts for:
1. CIPLA: Macro 105-day Cup & Handle matching user chart
2. OIL: Ascending Triangle with 20-day touch gaps & higher lows
3. MOIL: Exhausted climax top (+43% above 200 EMA) showing why it failed
"""

import os, json
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import pandas as pd
import numpy as np

OUTPUT_DIR = r"C:\Users\goutham\.gemini\antigravity\brain\9c0e395d-4da1-41cb-8c07-6407a7c69969"
OHLCV_DIR = "data/ohlcv_3y"

plt.style.use('dark_background')

def plot_cipla():
    with open(os.path.join(OHLCV_DIR, "CIPLA.json"), 'r') as f:
        candles = json.load(f)['candles']
    df = pd.DataFrame(candles, columns=['dt', 'o', 'h', 'l', 'c', 'v'])
    df['dt'] = pd.to_datetime(df['dt'])
    df = df[(df['dt'] >= '2024-01-01') & (df['dt'] <= '2024-08-31')].reset_index(drop=True)
    
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
    
    # Plot Candles
    for idx, row in df.iterrows():
        color = '#26a69a' if row['c'] >= row['o'] else '#ef5350'
        ax1.plot([row['dt'], row['dt']], [row['l'], row['h']], color=color, linewidth=1.2)
        ax1.plot([row['dt'], row['dt']], [row['o'], row['c']], color=color, linewidth=4)
        ax2.bar(row['dt'], row['v'], color=color, width=0.8, alpha=0.8)
        
    # Annotations
    rim_price = 1582.0
    ax1.axhline(rim_price, color='#ffd700', linestyle='--', linewidth=2, label=f'Macro Resistance Line: ₹{rim_price:.1f}')
    
    # Mark Key Points
    ax1.scatter(pd.to_datetime('2024-03-11'), 1519.0, color='#00e676', s=120, zorder=5, label='Left Rim (Mar 11)')
    ax1.scatter(pd.to_datetime('2024-05-10'), 1317.25, color='#29b6f6', s=140, zorder=5, label='U-Shaped Bottom (May 10 - 40d gap)')
    ax1.scatter(pd.to_datetime('2024-06-19'), 1582.0, color='#ab47bc', s=120, zorder=5, label='Right Rim (Jun 19 - 28d gap)')
    ax1.scatter(pd.to_datetime('2024-06-27'), 1465.3, color='#ffa726', s=120, zorder=5, label='Handle Low (Jun 27 - VDU)')
    ax1.scatter(pd.to_datetime('2024-08-13'), 1606.7, color='#00e676', marker='^', s=180, zorder=6, label='Breakout ₹1606.7 (Aug 13)')
    
    # Draw U-shape curve fit
    cup_dates = df[(df['dt'] >= '2024-03-11') & (df['dt'] <= '2024-06-19')]
    x_num = mdates.date2num(cup_dates['dt'])
    p = np.polyfit(x_num, cup_dates['c'], 2)
    y_curve = np.polyval(p, x_num)
    ax1.plot(cup_dates['dt'], y_curve, color='#00e5ff', linewidth=2.5, linestyle='-', alpha=0.9, label='Rounded Cup Basin (U-Shape)')

    ax1.set_title("CIPLA - Textbook Macro Cup & Handle (105-Day Accumulation Base)", fontsize=14, fontweight='bold', pad=12, color='#ffffff')
    ax1.set_ylabel("Price (INR)", fontsize=11)
    ax1.grid(True, linestyle=':', alpha=0.3)
    ax1.legend(loc='lower left', fontsize=9, framealpha=0.8)
    
    ax2.set_ylabel("Volume", fontsize=11)
    ax2.grid(True, linestyle=':', alpha=0.3)
    
    plt.tight_layout()
    p_out = os.path.join(OUTPUT_DIR, "cipla_macro_cup_annotated.png")
    plt.savefig(p_out, dpi=180)
    plt.close()
    print("Saved CIPLA chart:", p_out)

def plot_oil():
    with open(os.path.join(OHLCV_DIR, "OIL.json"), 'r') as f:
        candles = json.load(f)['candles']
    df = pd.DataFrame(candles, columns=['dt', 'o', 'h', 'l', 'c', 'v'])
    df['dt'] = pd.to_datetime(df['dt'])
    df = df[(df['dt'] >= '2024-03-15') & (df['dt'] <= '2024-09-01')].reset_index(drop=True)
    
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
    
    for idx, row in df.iterrows():
        color = '#26a69a' if row['c'] >= row['o'] else '#ef5350'
        ax1.plot([row['dt'], row['dt']], [row['l'], row['h']], color=color, linewidth=1.2)
        ax1.plot([row['dt'], row['dt']], [row['o'], row['c']], color=color, linewidth=4)
        ax2.bar(row['dt'], row['v'], color=color, width=0.8, alpha=0.8)
        
    # Resistance Line
    res_line = 468.0
    ax1.axhline(res_line, color='#ffd700', linestyle='--', linewidth=2, label=f'Horizontal Ceiling: ₹{res_line:.1f}')
    
    # Mark touches with time gaps
    ax1.scatter(pd.to_datetime('2024-05-21'), 447.4, color='#00e676', s=130, zorder=5, label='Touch 1 (May 21)')
    ax1.scatter(pd.to_datetime('2024-06-19'), 468.0, color='#ab47bc', s=130, zorder=5, label='Touch 2 (Jun 19 - 21d gap)')
    
    # Rising swing lows
    lows_dates = [pd.to_datetime('2024-04-22'), pd.to_datetime('2024-05-14'), pd.to_datetime('2024-06-04'), pd.to_datetime('2024-06-11')]
    lows_prices = [396.7, 404.6, 363.3, 405.7]
    ax1.scatter(lows_dates, lows_prices, color='#ff7043', s=120, zorder=5, label='Ascending Swing Lows')
    
    # Trendline along lows
    x_lows = mdates.date2num([pd.to_datetime('2024-04-22'), pd.to_datetime('2024-06-11')])
    y_lows = [396.7, 432.4]
    p = np.polyfit(x_lows, y_lows, 1)
    x_trend = mdates.date2num(df[(df['dt'] >= '2024-04-15') & (df['dt'] <= '2024-07-05')]['dt'])
    ax1.plot(df[(df['dt'] >= '2024-04-15') & (df['dt'] <= '2024-07-05')]['dt'], np.polyval(p, x_trend), color='#ff7043', linewidth=2.5, linestyle='-', label='Up-Slanting Lows Trendline')

    ax1.scatter(pd.to_datetime('2024-07-03'), 495.3, color='#00e676', marker='^', s=200, zorder=6, label='Volume Breakout ₹495+ (Surge to 653)')

    ax1.set_title("OIL - Classic Ascending Triangle with Rising Lows & 21-Day Touch Gap", fontsize=14, fontweight='bold', pad=12, color='#ffffff')
    ax1.set_ylabel("Price (INR)", fontsize=11)
    ax1.grid(True, linestyle=':', alpha=0.3)
    ax1.legend(loc='lower right', fontsize=9, framealpha=0.8)
    
    ax2.set_ylabel("Volume", fontsize=11)
    ax2.grid(True, linestyle=':', alpha=0.3)
    
    plt.tight_layout()
    p_out = os.path.join(OUTPUT_DIR, "oil_ascending_triangle_annotated.png")
    plt.savefig(p_out, dpi=180)
    plt.close()
    print("Saved OIL chart:", p_out)

def plot_moil():
    with open(os.path.join(OHLCV_DIR, "MOIL.json"), 'r') as f:
        candles = json.load(f)['candles']
    df = pd.DataFrame(candles, columns=['dt', 'o', 'h', 'l', 'c', 'v'])
    df['dt'] = pd.to_datetime(df['dt'])
    df = df[(df['dt'] >= '2024-04-01') & (df['dt'] <= '2024-10-15')].reset_index(drop=True)
    df['ema200'] = df['c'].ewm(span=200).mean()
    
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
    
    for idx, row in df.iterrows():
        color = '#26a69a' if row['c'] >= row['o'] else '#ef5350'
        ax1.plot([row['dt'], row['dt']], [row['l'], row['h']], color=color, linewidth=1.2)
        ax1.plot([row['dt'], row['dt']], [row['o'], row['c']], color=color, linewidth=4)
        ax2.bar(row['dt'], row['v'], color=color, width=0.8, alpha=0.8)
        
    ax1.plot(df['dt'], df['ema200'], color='#ff9100', linewidth=2, label='200 EMA (Long-term anchor)')
    
    # Mark Climax Top on June 18
    ax1.scatter(pd.to_datetime('2024-06-18'), 534.6, color='#ff1744', marker='v', s=180, zorder=6, label='Climax Exhaustion: +43.0% Above 200 EMA (REJECTED)')
    ax1.annotate("Climax Top (Jun 18)\nNo Base + Churning Wicks", xy=(mdates.date2num(pd.to_datetime('2024-06-18')), 534.6),
                 xytext=(mdates.date2num(pd.to_datetime('2024-07-05')), 570),
                 arrowprops=dict(facecolor='#ff1744', shrink=0.05, width=2), fontsize=10, color='#ff5252', fontweight='bold')

    ax1.set_title("MOIL - Climax Exhaustion Top (+43% Above 200 EMA) Leading to 35% Collapse", fontsize=14, fontweight='bold', pad=12, color='#ffffff')
    ax1.set_ylabel("Price (INR)", fontsize=11)
    ax1.grid(True, linestyle=':', alpha=0.3)
    ax1.legend(loc='lower left', fontsize=9, framealpha=0.8)
    
    ax2.set_ylabel("Volume", fontsize=11)
    ax2.grid(True, linestyle=':', alpha=0.3)
    
    plt.tight_layout()
    p_out = os.path.join(OUTPUT_DIR, "moil_climax_failure_annotated.png")
    plt.savefig(p_out, dpi=180)
    plt.close()
    print("Saved MOIL chart:", p_out)

if __name__ == "__main__":
    plot_cipla()
    plot_oil()
    plot_moil()

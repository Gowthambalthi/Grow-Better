"""
scripts/generate_20_pattern_audit.py
------------------------------------
Extracts 20 real calls of Cup & Handle across liquid NSE stocks.
Renders visual candlestick charts with pattern overlay and saves PNGs
to the artifact directory for visual inspection and audit.
"""

import os, json, math
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OHLCV_DIR = os.path.join(ROOT, "data", "ohlcv_3y")
NIFTY_PATH = os.path.join(OHLCV_DIR, "NIFTYBEES.json")
ARTIFACT_DIR = r"C:\Users\goutham\.gemini\antigravity\brain\9c0e395d-4da1-41cb-8c07-6407a7c69969"

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def plot_candlestick_pattern(sym, dates, opens, highs, lows, closes, vols, pat_info, out_path):
    """Renders a clean TradingView/Groww-style candlestick chart with pattern overlay"""
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 6), gridspec_kw={'height_ratios': [3.5, 1]}, sharex=True)
    fig.patch.set_facecolor('#131722')
    ax1.set_facecolor('#131722')
    ax2.set_facecolor('#131722')

    n = len(dates)
    x = np.arange(n)

    # Candlestick plotting
    for i in range(n):
        c_color = '#089981' if closes[i] >= opens[i] else '#F23645'
        # Wick
        ax1.plot([x[i], x[i]], [lows[i], highs[i]], color=c_color, linewidth=1)
        # Body
        body_bottom = min(opens[i], closes[i])
        body_height = max(abs(closes[i] - opens[i]), 0.05)
        rect = plt.Rectangle((x[i] - 0.35, body_bottom), 0.7, body_height, facecolor=c_color, edgecolor=c_color)
        ax1.add_patch(rect)

        # Volume
        v_rect = plt.Rectangle((x[i] - 0.35, 0), 0.7, vols[i], facecolor=c_color, alpha=0.7)
        ax2.add_patch(v_rect)

    # Overlay Pattern Geometry
    lr_idx = pat_info['lr_idx']
    bot_idx = pat_info['bot_idx']
    rr_idx = pat_info['rr_idx']
    hl_idx = pat_info['hl_idx']
    break_idx = pat_info['break_idx']

    rim_level = pat_info['rim']
    bot_level = pat_info['cup_low']
    handle_level = pat_info['handle_low']

    # Horizontal Rim line
    ax1.plot([x[lr_idx], x[break_idx]], [rim_level, rim_level], color='#2962FF', linestyle='--', linewidth=1.8, label=f"Rim (₹{rim_level:.2f})")
    
    # Cup curve approximation
    cup_x = [x[lr_idx], x[bot_idx], x[rr_idx]]
    cup_y = [rim_level, bot_level, rim_level]
    p_fit = np.polyfit(cup_x, cup_y, 2)
    curve_x = np.linspace(x[lr_idx], x[rr_idx], 30)
    curve_y = np.polyval(p_fit, curve_x)
    ax1.plot(curve_x, curve_y, color='#F7931A', linewidth=2.0, alpha=0.85, label='Cup Bowl')

    # Handle line
    ax1.plot([x[rr_idx], x[hl_idx]], [rim_level, handle_level], color='#E040FB', linewidth=2.0, label='Handle Drift')

    # Breakout marker
    ax1.scatter([x[break_idx]], [closes[break_idx]], color='#00E676', s=120, zorder=5, marker='^', label='Breakout Entry')

    # Stop Loss & Target lines
    sl = pat_info['sl']
    tp = pat_info['target']
    ax1.axhline(sl, color='#FF5252', linestyle=':', linewidth=1.2, label=f"SL (₹{sl:.2f})")
    ax1.axhline(tp, color='#00E676', linestyle=':', linewidth=1.2, label=f"Target (₹{tp:.2f})")

    # Titles & Labels
    outcome_str = f"Outcome: {pat_info['outcome']} ({pat_info['net_pct']:+.1f}% in {pat_info['days']}d)"
    ax1.set_title(f"{sym} — Cup & Handle Breakout ({pat_info['break_date']}) | {outcome_str}", color='white', fontsize=12, pad=10, fontweight='bold')
    ax1.tick_params(colors='#787B86')
    ax2.tick_params(colors='#787B86')
    ax1.grid(True, color='#2A2E39', alpha=0.5, linestyle='--')
    ax2.grid(True, color='#2A2E39', alpha=0.5, linestyle='--')

    # Format X axis dates
    step = max(1, n // 8)
    ax2.set_xticks(x[::step])
    ax2.set_xticklabels(dates[::step], rotation=25, color='#787B86')
    ax1.legend(loc='upper left', facecolor='#1E222D', edgecolor='#2A2E39', labelcolor='white', fontsize=8)

    plt.tight_layout()
    plt.savefig(out_path, dpi=120, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()

def main():
    print("=" * 80)
    print("  EXTRACTING & RENDERING 20 CUP & HANDLE CALLS FOR VISUAL AUDIT")
    print("=" * 80)

    with open(NIFTY_PATH, 'r') as f:
        nd = json.load(f)
    n_dates = [c[0][:10] for c in nd['candles']]
    n_closes = np.array([float(c[4]) for c in nd['candles']])
    n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
    n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

    files = [f for f in os.listdir(OHLCV_DIR) if f.endswith('.json') and f != 'NIFTYBEES.json']
    calls = []

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
            tr = np.maximum(highs[1:] - lows[1:], np.maximum(abs(highs[1:] - closes[:-1]), abs(lows[1:] - closes[:-1])))
            tr = np.insert(tr, 0, highs[0] - lows[0])
            atr14 = pd.Series(tr).rolling(14).mean().values

            for i in range(70, n - 25):
                dt = dates[i]
                c_now = closes[i]
                atr_now = atr14[i]
                rsi_now = rsi14[i]

                if np.isnan(atr_now) or atr_now <= 0 or np.isnan(rsi_now):
                    continue

                # Filters
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

                # Cup and Handle search
                for cup_len in [45, 60]:
                    if i < cup_len: continue
                    start = i - cup_len
                    mid = i - 10
                    lr = np.max(highs[start : start + 15])
                    lr_i = start + np.argmax(highs[start : start + 15])
                    bot = np.min(lows[lr_i : mid])
                    bot_i = lr_i + np.argmin(lows[lr_i : mid])
                    rr = np.max(highs[mid - 5 : mid + 5])
                    rr_i = (mid - 5) + np.argmax(highs[mid - 5 : mid + 5])
                    hl = np.min(lows[mid : i])
                    hl_i = mid + np.argmin(lows[mid : i])

                    if abs(rr - lr) / lr <= 0.035:
                        rim = max(lr, rr)
                        depth = (rim - bot) / rim
                        if 0.12 <= depth <= 0.35:
                            h_depth = (rim - hl) / rim
                            if 0.02 <= h_depth <= depth * 0.40:
                                if c_now > rim * 0.998 and closes[i-1] <= rim * 1.005:
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

                                    calls.append({
                                        'sym': sym,
                                        'break_date': dt,
                                        'dates': dates[start : i + 25],
                                        'opens': opens[start : i + 25],
                                        'highs': highs[start : i + 25],
                                        'lows': lows[start : i + 25],
                                        'closes': closes[start : i + 25],
                                        'vols': volumes[start : i + 25],
                                        'pat_info': {
                                            'lr_idx': lr_i - start,
                                            'bot_idx': bot_i - start,
                                            'rr_idx': rr_i - start,
                                            'hl_idx': hl_i - start,
                                            'break_idx': i - start,
                                            'rim': rim,
                                            'cup_low': bot,
                                            'handle_low': hl,
                                            'sl': sl_p,
                                            'target': target_p,
                                            'break_date': dt,
                                            'outcome': outcome,
                                            'net_pct': net_pct,
                                            'days': days,
                                            'depth_pct': depth * 100,
                                            'handle_depth_pct': h_depth * 100,
                                            'rsi': rsi_now,
                                            'rs60': rs60
                                        }
                                    })
                                    break
        except Exception:
            continue

    print(f"Total Qualified Calls Found: {len(calls)}")
    # Pick 20 diverse calls across time and stocks
    selected_20 = calls[:20] if len(calls) <= 20 else [calls[int(k * (len(calls)-1) / 19)] for k in range(20)]

    chart_paths = []
    audit_table = []

    for idx, c in enumerate(selected_20, 1):
        sym = c['sym']
        b_dt = c['break_date']
        fname = f"cup_audit_{idx:02d}_{sym}_{b_dt}.png"
        fpath = os.path.join(ARTIFACT_DIR, fname)
        plot_candlestick_pattern(sym, c['dates'], c['opens'], c['highs'], c['lows'], c['closes'], c['vols'], c['pat_info'], fpath)
        chart_paths.append(fpath)

        p = c['pat_info']
        audit_table.append({
            'num': idx,
            'symbol': sym,
            'break_date': b_dt,
            'rim': round(p['rim'], 2),
            'cup_depth': round(p['depth_pct'], 1),
            'handle_depth': round(p['handle_depth_pct'], 1),
            'rsi': round(p['rsi'], 1),
            'rs60': round(p['rs60'], 1),
            'target': round(p['target'], 2),
            'sl': round(p['sl'], 2),
            'outcome': p['outcome'],
            'net_pct': round(p['net_pct'], 2),
            'days': p['days'],
            'chart_file': fname
        })
        print(f"[{idx:02d}] {sym:12s} {b_dt} | Rim: {p['rim']:.1f} | Depth: {p['depth_pct']:.1f}% | Outcome: {p['outcome']} ({p['net_pct']:+.1f}%) -> {fname}")

    # Save summary json
    with open('data/cup_20_calls_audit.json', 'w') as f:
        json.dump(audit_table, f, indent=2)
    print("\nSaved 20 audited calls to data/cup_20_calls_audit.json")

if __name__ == '__main__':
    main()

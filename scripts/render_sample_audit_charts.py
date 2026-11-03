"""
scripts/render_sample_audit_charts.py
-------------------------------------
Renders high-resolution candlestick charts for representative winning and losing calls
so the user can visually audit them alongside their broker app (Groww / TradingView).
"""

import os, json
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OHLCV_DIR = os.path.join(ROOT, "data", "ohlcv_3y")
ARTIFACT_DIR = r"C:\Users\goutham\.gemini\antigravity\brain\9c0e395d-4da1-41cb-8c07-6407a7c69969"

sample_calls = [
    # Winners
    {'sym': 'HBLENGINE', 'pat': 'Cup & Handle', 'entry_dt': '2024-01-25', 'exit_dt': '2024-02-13', 'entry_p': 482.00, 'exit_p': 516.29, 'net_pct': 7.3, 'type': 'WINNER', 'reason': 'Target Hit (+8%) -> Trailed to Rs 516'},
    {'sym': 'CDSL', 'pat': 'Inverse H&S', 'entry_dt': '2024-12-05', 'exit_dt': '2024-12-23', 'entry_p': 1740.00, 'exit_p': 1820.14, 'net_pct': 6.0, 'type': 'WINNER', 'reason': 'Target Hit (+8%) -> Trailed via 20 EMA'},
    {'sym': 'RADICO', 'pat': 'Inverse H&S', 'entry_dt': '2026-04-20', 'exit_dt': '2026-05-27', 'entry_p': 3220.90, 'exit_p': 3433.71, 'net_pct': 7.0, 'type': 'WINNER', 'reason': 'Target Hit (+8%) -> Trailed via 20 EMA'},
    
    # Losers
    {'sym': 'KAYNES', 'pat': 'Cup & Handle', 'entry_dt': '2024-03-11', 'exit_dt': '2024-03-12', 'entry_p': 3115.00, 'exit_p': 2881.38, 'net_pct': -7.8, 'type': 'LOSER', 'reason': 'Immediate False Breakout Dump -> SL Hit'},
    {'sym': 'GNFC', 'pat': 'Rectangle', 'entry_dt': '2024-01-02', 'exit_dt': '2024-01-17', 'entry_p': 797.40, 'exit_p': 737.60, 'net_pct': -7.8, 'type': 'LOSER', 'reason': 'Failed Box Breakout -> Retest Failed'},
    {'sym': 'BHEL', 'pat': 'Rectangle', 'entry_dt': '2026-01-05', 'exit_dt': '2026-01-08', 'entry_p': 300.80, 'exit_p': 278.24, 'net_pct': -7.8, 'type': 'LOSER', 'reason': 'Gap Down Market Reversal -> SL Hit'}
]

for sc in sample_calls:
    sym = sc['sym']
    p = os.path.join(OHLCV_DIR, f"{sym}.json")
    if not os.path.exists(p): continue
    with open(p, 'r') as fp: d = json.load(fp)
    candles = d['candles']
    dates = [c[0][:10] for c in candles]
    opens = np.array([float(c[1]) for c in candles])
    highs = np.array([float(c[2]) for c in candles])
    lows = np.array([float(c[3]) for c in candles])
    closes = np.array([float(c[4]) for c in candles])
    vols = np.array([float(c[5]) for c in candles])

    if sc['entry_dt'] not in dates: continue
    e_idx = dates.index(sc['entry_dt'])
    start_idx = max(0, e_idx - 35)
    end_idx = min(len(dates), e_idx + 30)

    sub_d = dates[start_idx:end_idx]
    sub_o = opens[start_idx:end_idx]
    sub_h = highs[start_idx:end_idx]
    sub_l = lows[start_idx:end_idx]
    sub_c = closes[start_idx:end_idx]
    sub_v = vols[start_idx:end_idx]

    n = len(sub_d)
    x = np.arange(n)

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(11, 6), gridspec_kw={'height_ratios': [3.5, 1]}, sharex=True)
    fig.patch.set_facecolor('#131722')
    ax1.set_facecolor('#131722')
    ax2.set_facecolor('#131722')

    for i in range(n):
        c_col = '#089981' if sub_c[i] >= sub_o[i] else '#F23645'
        ax1.plot([x[i], x[i]], [sub_l[i], sub_h[i]], color=c_col, linewidth=1)
        b_bot = min(sub_o[i], sub_c[i])
        b_h = max(abs(sub_c[i] - sub_o[i]), 0.05)
        ax1.add_patch(plt.Rectangle((x[i] - 0.35, b_bot), 0.7, b_h, facecolor=c_col, edgecolor=c_col))
        ax2.add_patch(plt.Rectangle((x[i] - 0.35, 0), 0.7, sub_v[i], facecolor=c_col, alpha=0.7))

    rel_e = e_idx - start_idx
    ax1.scatter([x[rel_e]], [sc['entry_p']], color='#00E676', s=140, marker='^', zorder=5, label=f"Entry: Rs {sc['entry_p']:.1f}")

    if sc['exit_dt'] in sub_d:
        rel_x = sub_d.index(sc['exit_dt'])
        exit_marker_color = '#00E676' if sc['type'] == 'WINNER' else '#FF5252'
        ax1.scatter([x[rel_x]], [sc['exit_p']], color=exit_marker_color, s=140, marker='v', zorder=5, label=f"Exit: Rs {sc['exit_p']:.1f}")

    outcome_col = '#00E676' if sc['type'] == 'WINNER' else '#FF5252'
    title = f"{sc['type']}: {sym} ({sc['pat']}) | Net: {sc['net_pct']:+.1f}% | {sc['reason']}"
    ax1.set_title(title, color=outcome_col, fontsize=12, pad=10, fontweight='bold')
    ax1.tick_params(colors='#787B86')
    ax2.tick_params(colors='#787B86')
    ax1.grid(True, color='#2A2E39', alpha=0.5, linestyle='--')
    ax2.grid(True, color='#2A2E39', alpha=0.5, linestyle='--')
    ax1.legend(loc='upper left', facecolor='#1E222D', edgecolor='#2A2E39', labelcolor='white', fontsize=9)

    step = max(1, n // 8)
    ax2.set_xticks(x[::step])
    ax2.set_xticklabels(sub_d[::step], rotation=25, color='#787B86')

    plt.tight_layout()
    out_f = f"audit_sample_{sc['type'].lower()}_{sym}_{sc['entry_dt']}.png"
    plt.savefig(os.path.join(ARTIFACT_DIR, out_f), dpi=120, facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close()
    print(f"Rendered {out_f}")

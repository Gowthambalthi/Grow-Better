"""
scripts/extract_audit_samples.py
--------------------------------
Extracts diverse winning and losing calls from 603 executed portfolio trades
spanning 2024, 2025, and 2026 for manual charting and visual audit on Groww/TradingView.
"""

import json

with open('strategies/mine/data/portfolio_simulation_results.json') as f:
    trades = json.load(f)

wins = [t for t in trades if t['net_pct'] > 0]
losses = [t for t in trades if t['net_pct'] < 0]

print(f"Total Portfolio Trades: {len(trades)} | Total Wins: {len(wins)} | Total Losses: {len(losses)}\n")

patterns = ['ASCENDING_TRIANGLE', 'RECTANGLE', 'CUP_AND_HANDLE', 'INVERSE_HS']

def format_row(idx, t):
    return f"{idx:02d} | {t['pattern']:18s} | {t['symbol']:12s} | {t['entry_date']:10s} | Rs {t['entry_p']:9.2f} | {t['exit_date']:10s} | Rs {t['exit_p']:9.2f} | {t['net_pct']:+6.1f}% | {t['bars_held']:2d}d | {t['exit_reason']:11s}"

print("=" * 107)
print("  REPRESENTATIVE WINNING CALLS FOR AUDIT (2024 - 2026)")
print("=" * 107)
print(f"{'#':2s} | {'Pattern':18s} | {'Symbol':12s} | {'Entry Date':10s} | {'Entry (Rs)':10s} | {'Exit Date':10s} | {'Exit (Rs)':10s} | {'Net PnL':7s} | {'Held':4s} | {'Exit Reason':11s}")
print("-" * 107)

win_sample = []
idx = 1
for yr in ['2024', '2025', '2026']:
    for p in patterns:
        matching = [t for t in wins if t['pattern'] == p and t['entry_date'].startswith(yr)]
        if matching:
            t = matching[0]
            win_sample.append(t)
            print(format_row(idx, t))
            idx += 1

print("\n" + "=" * 107)
print("  REPRESENTATIVE LOSING CALLS FOR AUDIT (2024 - 2026)")
print("=" * 107)
print(f"{'#':2s} | {'Pattern':18s} | {'Symbol':12s} | {'Entry Date':10s} | {'Entry (Rs)':10s} | {'Exit Date':10s} | {'Exit (Rs)':10s} | {'Net PnL':7s} | {'Held':4s} | {'Exit Reason':11s}")
print("-" * 107)

loss_sample = []
idx = 1
for yr in ['2024', '2025', '2026']:
    for p in patterns:
        matching = [t for t in losses if t['pattern'] == p and t['entry_date'].startswith(yr)]
        if matching:
            t = matching[0]
            loss_sample.append(t)
            print(format_row(idx, t))
            idx += 1

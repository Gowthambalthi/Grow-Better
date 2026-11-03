"""
scripts/test_position_capacity.py
---------------------------------
Tests portfolio execution capacity across different slot limits:
10 slots (baseline), 15 slots, 20 slots, 25 slots, 30 slots.
"""

import os, sys, json
import numpy as np

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from strategies.mine.scripts.data_loader import load_clean_market_data
from strategies.mine.scripts.portfolio_simulator import extract_trio_signals, run_portfolio_simulation
import strategies.mine.config as cfg
import strategies.mine.scripts.portfolio_simulator as ps

stock_data, nifty_map = load_clean_market_data()
signals = extract_trio_signals(stock_data, nifty_map)
print(f"Total Raw Signals Generated: {len(signals)}")

for max_pos in [10, 15, 20, 25, 30]:
    ps.MAX_CONCURRENT_POSITIONS = max_pos
    ps.CAPITAL_PER_POSITION = ps.STARTING_CAPITAL / max_pos
    trades, equity = run_portfolio_simulation(signals, stock_data)
    total = len(trades)
    cpw = total / 150.0 # ~150 weeks
    wins = [t for t in trades if t['net_pct'] > 0]
    wr = len(wins) / total * 100.0 if total > 0 else 0
    gw = sum(t['net_pct'] for t in wins)
    gl = abs(sum(t['net_pct'] for t in trades if t['net_pct'] <= 0))
    pf = gw / (gl + 1e-9)

    oos = [t for t in trades if t['is_oos']]
    oos_w = [t for t in oos if t['net_pct'] > 0]
    oos_l = [t for t in oos if t['net_pct'] <= 0]
    oos_pf = sum(t['net_pct'] for t in oos_w) / (abs(sum(t['net_pct'] for t in oos_l)) + 1e-9)
    r_tot = sum(t['r_mult'] for t in trades)

    print(f"Slots: {max_pos:2d} | Trades: {total:4d} ({cpw:4.2f}/wk) | WinRate: {wr:5.1f}% | Total PF: {pf:4.2f} | OOS PF: {oos_pf:4.2f} | Net R: {r_tot:+6.1f}R")

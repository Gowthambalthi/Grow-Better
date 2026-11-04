"""
strategies/mine/scripts/portfolio_simulator.py
Portfolio Simulator for Trio Breakout Engine:
- Cup & Handle + RSI
- Inverse Head & Shoulders + RSI
- Rectangle Consolidation + RSI
"""

import os
import sys
import json
import math
import numpy as np
import pandas as pd

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from strategies.mine.config import (
    FRICTION_DECIMAL, OOS_SPLIT_DATE, MIN_TURNOVER_CR, REQUIRE_NIFTY_BULL,
    ACTIVE_PATTERNS, CUP_MIN_LEN, CUP_MAX_LEN, CUP_MIN_DEPTH_PCT, CUP_MAX_DEPTH_PCT, CUP_MAX_HANDLE_RATIO,
    IHS_WINDOW, IHS_SHOULDER_TOL, RECT_WINDOW, RECT_MAX_RANGE_PCT,
    RSI_PERIOD, RSI_MIN, RSI_MAX, RS_LOOKBACK, MIN_RS_OUTPERFORMANCE,
    MIN_RISK_PCT, MAX_RISK_PCT, TARGET_1_PCT, BREAKEVEN_TRIGGER_R, TRAIL_TRIGGER_R, MAX_HOLD_BARS,
    STARTING_CAPITAL, MAX_CONCURRENT_POSITIONS, CAPITAL_PER_POSITION
)
from strategies.mine.scripts.data_loader import load_clean_market_data, get_project_root

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def extract_trio_signals(stock_data, nifty_map):
    """
    Extracts high-conviction breakout signals for:
    1. Cup & Handle + RSI
    2. Inverse Head & Shoulders + RSI
    3. Rectangle Breakout + RSI
    """
    signals = []

    for sym, d in stock_data.items():
        mat = d['mat']
        dates = d['dates']
        atr = d['atr']
        n = len(dates)

        o = mat[:, 0]
        h = mat[:, 1]
        l = mat[:, 2]
        c = mat[:, 3]
        v = mat[:, 4]

        rsi14 = calculate_rsi(c, RSI_PERIOD)

        for i in range(70, n - 1):
            sig_date = dates[i]

            # 1. Market Gate (NIFTY > 50 EMA)
            if REQUIRE_NIFTY_BULL:
                if sig_date not in nifty_map or not nifty_map[sig_date]['bull']:
                    continue

            cur_c = c[i]
            cur_atr = atr[i]
            cur_rsi = rsi14[i]
            if np.isnan(cur_atr) or cur_atr <= 0 or np.isnan(cur_rsi):
                continue

            # 2. RSI Gate: healthy momentum, not exhausted
            if cur_rsi < RSI_MIN or cur_rsi > RSI_MAX:
                continue

            # 3. Relative Strength Gate (60 days vs NIFTY)
            if i >= RS_LOOKBACK:
                past_date = dates[i - RS_LOOKBACK]
                if sig_date in nifty_map and past_date in nifty_map:
                    stock_ret = (cur_c - c[i - RS_LOOKBACK]) / c[i - RS_LOOKBACK]
                    n_ret = (nifty_map[sig_date]['close'] - nifty_map[past_date]['close']) / nifty_map[past_date]['close']
                    rs_outperformance = (stock_ret - n_ret) * 100.0
                    if rs_outperformance < MIN_RS_OUTPERFORMANCE:
                        continue

            # 4. Pattern Detection
            detected_pattern = None
            stop_level = None
            pat_level = None

            # A. Cup & Handle
            if 'CUP_HANDLE' in ACTIVE_PATTERNS:
                for cup_len in [40, 55, 70]:
                    if i < cup_len:
                        continue
                    start_bar = i - cup_len
                    mid_bar = i - 10
                    left_rim = np.max(h[start_bar : start_bar + 15])
                    left_rim_idx = start_bar + np.argmax(h[start_bar : start_bar + 15])
                    cup_bottom = np.min(l[left_rim_idx : mid_bar])
                    right_rim = np.max(h[mid_bar - 5 : mid_bar + 5])
                    handle_low = np.min(l[mid_bar : i])

                    if abs(right_rim - left_rim) / left_rim <= 0.04:
                        rim = max(left_rim, right_rim)
                        depth = (rim - cup_bottom) / rim
                        if (CUP_MIN_DEPTH_PCT / 100.0) <= depth <= (CUP_MAX_DEPTH_PCT / 100.0):
                            h_depth = (rim - handle_low) / rim
                            if 0.02 <= h_depth <= depth * CUP_MAX_HANDLE_RATIO:
                                if cur_c > rim * 0.998 and c[i - 1] <= rim * 1.005:
                                    detected_pattern = 'CUP_AND_HANDLE'
                                    stop_level = handle_low
                                    pat_level = rim
                                    break

            # B. Inverse Head & Shoulders
            if not detected_pattern and 'INVERSE_HS' in ACTIVE_PATTERNS:
                if i >= IHS_WINDOW:
                    a = i - IHS_WINDOW
                    w = IHS_WINDOW // 3
                    ls = np.min(l[a : a + w])
                    head = np.min(l[a + w : a + 2 * w])
                    rs = np.min(l[a + 2 * w : i])
                    if head < ls and head < rs and abs(rs / ls - 1.0) <= IHS_SHOULDER_TOL:
                        neck = min(np.max(h[a : a + w]), np.max(h[a + 2 * w : i]))
                        if cur_c > neck and c[i - 1] <= neck * 1.005:
                            detected_pattern = 'INVERSE_HS'
                            stop_level = rs
                            pat_level = neck

            # C. Rectangle Consolidation
            if not detected_pattern and 'RECTANGLE' in ACTIVE_PATTERNS:
                if i >= RECT_WINDOW:
                    win_h = h[i - RECT_WINDOW : i]
                    win_l = l[i - RECT_WINDOW : i]
                    box_h = np.max(win_h)
                    box_l = np.min(win_l)
                    range_pct = (box_h - box_l) / box_l * 100.0
                    if range_pct <= RECT_MAX_RANGE_PCT:
                        # Horizontal base drift check: Eliminates diagonal trend movers (like GNFC)
                        base_drift = abs(c[i - 1] - c[i - RECT_WINDOW]) / c[i - RECT_WINDOW]
                        if base_drift <= 0.05:
                            if cur_c > box_h and c[i - 1] <= box_h * 1.005:
                                detected_pattern = 'RECTANGLE'
                                stop_level = box_l
                                pat_level = box_h

            # D. Ascending Triangle
            if not detected_pattern and 'ASCENDING_TRIANGLE' in ACTIVE_PATTERNS:
                if i >= 40:
                    win_start = i - 40
                    win_h = h[win_start : i]
                    tri_res = np.max(win_h)
                    touches = np.sum(win_h >= tri_res * 0.98)
                    if touches >= 2:
                        first_low = np.min(l[win_start : win_start + 20])
                        second_low = np.min(l[win_start + 20 : i])
                        if second_low > first_low:  # Lows must be rising
                            if cur_c > tri_res and c[i - 1] <= tri_res * 1.005:
                                detected_pattern = 'ASCENDING_TRIANGLE'
                                stop_level = second_low
                                pat_level = tri_res

            if detected_pattern:
                # 1. Capped Buy Pocket (No chasing > 3.0% above broken level)
                if cur_c > pat_level * 1.03:
                    continue
                # 2. Volume Surge Confirmation (>= 1.15x 20-day SMA)
                vol_sma20 = np.mean(v[i-20:i])
                if v[i] < vol_sma20 * 1.15:
                    continue

                signals.append({
                    'symbol': sym,
                    'pattern': detected_pattern,
                    'sig_date': sig_date,
                    'entry_date': dates[i + 1],
                    'stop_level': stop_level,
                    'cur_atr': cur_atr,
                    'cur_c': cur_c,
                    'rsi': cur_rsi,
                    'turnover': d['turnover']
                })

    signals.sort(key=lambda s: (s['sig_date'], -s['turnover']))
    print(f"Total Trio Pattern Signals Generated: {len(signals)}")
    return signals

def run_portfolio_simulation(signals, stock_data):
    all_dates = sorted(list(set(d for sd in stock_data.values() for d in sd['dates'])))

    cash = STARTING_CAPITAL
    open_positions = []
    closed_trades = []
    daily_equity = []

    signals_by_entry_date = {}
    for s in signals:
        signals_by_entry_date.setdefault(s['entry_date'], []).append(s)

    for current_date in all_dates:
        # 1. Manage Open Positions
        remaining_positions = []

        for pos in open_positions:
            sym = pos['symbol']
            sd = stock_data[sym]
            s_dates = sd['dates']
            mat = sd['mat']

            if current_date not in s_dates:
                remaining_positions.append(pos)
                continue

            bar_idx = s_dates.index(current_date)
            b_o, b_h, b_l, b_c = mat[bar_idx, 0], mat[bar_idx, 1], mat[bar_idx, 2], mat[bar_idx, 3]
            pos['bars_held'] += 1

            exit_occurred = False
            exit_price = 0.0
            exit_reason = ''

            # 1. Check Tranche 1 Hit (+8% to +9%)
            if not pos['t1_hit'] and b_h >= pos['target_1']:
                pos['t1_hit'] = True
                pos['current_stop'] = max(pos['current_stop'], pos['entry_p'] * 1.002) # Move SL to BE

            # 2. Check Stop Loss
            if b_l <= pos['current_stop']:
                exit_occurred = True
                exit_price = min(b_o, pos['current_stop'])
                exit_reason = 'STOP_LOSS' if not pos['t1_hit'] else 'TRAIL_EXIT'

            # 3. Trailing remainder via 20 EMA
            if pos['t1_hit'] and not exit_occurred:
                ema20_now = sd['ema20'][bar_idx] if 'ema20' in sd else b_c
                if ema20_now > pos['current_stop']:
                    pos['current_stop'] = ema20_now * 0.998

            # 4. Max Hold (35 bars)
            if not exit_occurred and pos['bars_held'] >= MAX_HOLD_BARS:
                exit_occurred = True
                exit_price = b_c
                exit_reason = 'TIME_EXIT'

            if exit_occurred:
                if pos['t1_hit']:
                    # 50% booked at Target 1, 50% exited at exit_price
                    p1_net = TARGET_1_PCT - FRICTION_DECIMAL
                    p2_net = (exit_price - pos['entry_p']) / pos['entry_p'] - FRICTION_DECIMAL
                    net_pct = 0.5 * p1_net + 0.5 * p2_net
                else:
                    gross_pct = (exit_price - pos['entry_p']) / pos['entry_p']
                    net_pct = gross_pct - FRICTION_DECIMAL

                r_mult = (pos['entry_p'] * net_pct) / pos['cash_risk'] if pos['cash_risk'] > 0 else 0
                cash += pos['allocation'] * (1.0 + net_pct)

                closed_trades.append({
                    'symbol': sym,
                    'pattern': pos['pattern'],
                    'entry_date': pos['entry_date'],
                    'exit_date': current_date,
                    'entry_p': pos['entry_p'],
                    'exit_p': exit_price,
                    'sl_p': pos['init_stop'],
                    't1_hit': pos['t1_hit'],
                    'net_pct': net_pct * 100.0,
                    'r_mult': r_mult,
                    'bars_held': pos['bars_held'],
                    'exit_reason': exit_reason,
                    'is_oos': pos['entry_date'] >= OOS_SPLIT_DATE
                })
            else:
                remaining_positions.append(pos)

        open_positions = remaining_positions

        # 2. Enter New Signals
        if current_date in signals_by_entry_date:
            day_sigs = signals_by_entry_date[current_date]
            for sig in day_sigs:
                if len(open_positions) >= MAX_CONCURRENT_POSITIONS:
                    break
                if cash < CAPITAL_PER_POSITION * 0.5:
                    break

                sym = sig['symbol']
                sd = stock_data[sym]
                s_dates = sd['dates']
                mat = sd['mat']
                if current_date not in s_dates:
                    continue

                bar_idx = s_dates.index(current_date)
                entry_p = mat[bar_idx, 0]
                if np.isnan(entry_p) or entry_p <= 0:
                    continue

                struct_sl = sig['stop_level']
                init_sl = struct_sl if struct_sl and struct_sl < entry_p else entry_p - 1.5 * sig['cur_atr']
                risk_pct = (entry_p - init_sl) / entry_p

                if risk_pct < MIN_RISK_PCT:
                    init_sl = entry_p * (1.0 - MIN_RISK_PCT)
                    risk_pct = MIN_RISK_PCT
                elif risk_pct > MAX_RISK_PCT:
                    init_sl = entry_p * (1.0 - MAX_RISK_PCT)
                    risk_pct = MAX_RISK_PCT

                cash_risk = entry_p - init_sl
                target_1 = entry_p * (1.0 + TARGET_1_PCT)
                allocation = min(CAPITAL_PER_POSITION, cash * 0.95)
                cash -= allocation

                open_positions.append({
                    'symbol': sym,
                    'pattern': sig['pattern'],
                    'entry_date': current_date,
                    'entry_p': entry_p,
                    'init_stop': init_sl,
                    'current_stop': init_sl,
                    'cash_risk': cash_risk,
                    'target_1': target_1,
                    'allocation': allocation,
                    'bars_held': 0,
                    't1_hit': False
                })

        daily_equity.append({
            'date': current_date,
            'equity': cash + sum(p['allocation'] for p in open_positions)
        })

    return closed_trades, daily_equity

def main():
    print("=" * 85)
    print("  SIMULATING TRIO BREAKOUT ENGINE (CUP&HANDLE, INVERSE H&S, RECTANGLE + RSI)")
    print("=" * 85)

    stock_data, nifty_map = load_clean_market_data()
    signals = extract_trio_signals(stock_data, nifty_map)
    closed_trades, daily_equity = run_portfolio_simulation(signals, stock_data)

    df = pd.DataFrame(closed_trades)
    print(f"\nTotal Portfolio Trades Executed: {len(df)}")
    if df.empty:
        return

    wins = df[df['r_mult'] > 0]
    losses = df[df['r_mult'] <= 0]
    wr = len(wins) / len(df) * 100.0
    g_w = wins['r_mult'].sum()
    g_l = abs(losses['r_mult'].sum())
    pf = g_w / g_l if g_l > 0 else 99.0
    net_r = df['r_mult'].sum()

    is_df = df[df['is_oos'] == False]
    oos_df = df[df['is_oos'] == True]
    is_pf = is_df[is_df['r_mult'] > 0]['r_mult'].sum() / abs(is_df[is_df['r_mult'] <= 0]['r_mult'].sum()) if len(is_df) else 0
    oos_pf = oos_df[oos_df['r_mult'] > 0]['r_mult'].sum() / abs(oos_df[oos_df['r_mult'] <= 0]['r_mult'].sum()) if len(oos_df) else 0

    print(f"\nOverall Portfolio Win Rate: {wr:.1f}%")
    print(f"Overall Profit Factor     : {pf:.2f}")
    print(f"In-Sample PF (< Apr 2025) : {is_pf:.2f}")
    print(f"Out-of-Sample PF (>= Apr): {oos_pf:.2f}")
    print(f"Net Realized R-Multiple   : +{net_r:.1f}R")
    print(f"Average Winner Return     : +{wins['net_pct'].mean():.2f}%")
    print(f"Average Loser Return      : {losses['net_pct'].mean():.2f}%")

    out_p = os.path.join(ROOT_DIR, 'strategies', 'mine', 'data', 'portfolio_simulation_results.json')
    with open(out_p, 'w') as f:
        json.dump(closed_trades, f, indent=2)
    print(f"\nSaved portfolio results to {out_p}")

if __name__ == '__main__':
    main()

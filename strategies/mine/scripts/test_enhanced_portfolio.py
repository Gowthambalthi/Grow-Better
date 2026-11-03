"""
strategies/mine/scripts/test_enhanced_portfolio.py
--------------------------------------------------
Runs side-by-side portfolio simulation comparing:
1. Baseline Trio/Quad Breakout Engine
2. Institutional Filtered Engine (Volume Surge >= 1.25x + Capped Buy Pocket <= 2.5%)
"""

import os, sys, json, numpy as np, pandas as pd

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
from strategies.mine.scripts.data_loader import load_clean_market_data

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def extract_signals(stock_data, nifty_map, min_vol_ratio=0.0, max_extension=1.15):
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
            if REQUIRE_NIFTY_BULL:
                if sig_date not in nifty_map or not nifty_map[sig_date]['bull']:
                    continue

            cur_c = c[i]
            cur_atr = atr[i]
            cur_rsi = rsi14[i]
            if np.isnan(cur_atr) or cur_atr <= 0 or np.isnan(cur_rsi):
                continue
            if cur_rsi < RSI_MIN or cur_rsi > RSI_MAX:
                continue

            if i >= RS_LOOKBACK:
                past_date = dates[i - RS_LOOKBACK]
                if sig_date in nifty_map and past_date in nifty_map:
                    stock_ret = (cur_c - c[i - RS_LOOKBACK]) / c[i - RS_LOOKBACK]
                    n_ret = (nifty_map[sig_date]['close'] - nifty_map[past_date]['close']) / nifty_map[past_date]['close']
                    rs_out = (stock_ret - n_ret) * 100.0
                    if rs_out < MIN_RS_OUTPERFORMANCE:
                        continue

            detected_pattern = None
            stop_level = None
            pat_level = None

            # A. Cup & Handle
            if 'CUP_HANDLE' in ACTIVE_PATTERNS:
                for cup_len in [40, 55, 70]:
                    if i < cup_len: continue
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
                    box_h = np.max(h[i - RECT_WINDOW : i])
                    box_l = np.min(l[i - RECT_WINDOW : i])
                    range_pct = (box_h - box_l) / box_l * 100.0
                    if range_pct <= RECT_MAX_RANGE_PCT:
                        if cur_c > box_h and c[i - 1] <= box_h * 1.005:
                            detected_pattern = 'RECTANGLE'
                            stop_level = box_l
                            pat_level = box_h

            # D. Ascending Triangle
            if not detected_pattern and 'ASCENDING_TRIANGLE' in ACTIVE_PATTERNS:
                if i >= 40:
                    win_start = i - 40
                    tri_res = np.max(h[win_start : i])
                    touches = np.sum(h[win_start : i] >= tri_res * 0.98)
                    if touches >= 2:
                        first_low = np.min(l[win_start : win_start + 20])
                        second_low = np.min(l[win_start + 20 : i])
                        if second_low > first_low:
                            if cur_c > tri_res and c[i - 1] <= tri_res * 1.005:
                                detected_pattern = 'ASCENDING_TRIANGLE'
                                stop_level = second_low
                                pat_level = tri_res

            if detected_pattern:
                # Volume filter
                vol_sma20 = np.mean(v[i-20:i])
                vol_ratio = v[i] / (vol_sma20 + 1e-9)
                if vol_ratio < min_vol_ratio:
                    continue
                # Capped Buy Pocket filter
                if cur_c > pat_level * max_extension:
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
                    'score': 100.0 + (cur_rsi - 50.0) * 0.5
                })
    return signals

def run_portfolio(signals, stock_data):
    signals.sort(key=lambda s: s['sig_date'])
    trades = []
    active = []

    unique_dates = sorted(list(set(s['sig_date'] for s in signals)))
    all_dates = sorted(list(set([d for sym in stock_data for d in stock_data[sym]['dates']])))

    for cur_dt in all_dates:
        # Check active positions
        still_active = []
        for pos in active:
            sym = pos['symbol']
            sd = stock_data[sym]
            d_list = sd['dates']
            if cur_dt not in d_list:
                still_active.append(pos)
                continue
            idx = d_list.index(cur_dt)
            mat = sd['mat']
            bar_o = mat[idx, 0]
            bar_h = mat[idx, 1]
            bar_l = mat[idx, 2]
            bar_c = mat[idx, 3]

            pos['bars_held'] += 1
            exit_trade = False
            exit_price = None
            exit_reason = None

            # 1. SL Check
            if bar_l <= pos['cur_sl']:
                exit_trade = True
                exit_price = min(bar_o, pos['cur_sl'])
                exit_reason = 'STOP_LOSS'
            # 2. Target 1
            elif not pos['hit_t1'] and bar_h >= pos['target_1']:
                pos['hit_t1'] = True
                pos['cur_sl'] = max(pos['cur_sl'], pos['entry_price'] * 1.002)

            # 3. Max hold
            if not exit_trade and pos['bars_held'] >= MAX_HOLD_BARS:
                exit_trade = True
                exit_price = bar_c
                exit_reason = 'TIME_EXIT'

            if exit_trade:
                gross = (exit_price - pos['entry_price']) / pos['entry_price']
                net = gross - FRICTION_DECIMAL
                r_mult = net / pos['risk_pct']
                trades.append({
                    'symbol': sym,
                    'pattern': pos['pattern'],
                    'entry_date': pos['entry_date'],
                    'exit_date': cur_dt,
                    'net_pct': net * 100.0,
                    'r_mult': r_mult,
                    'is_win': net > 0,
                    'is_oos': pos['entry_date'] >= OOS_SPLIT_DATE
                })
            else:
                still_active.append(pos)
        active = still_active

        # Entry logic
        day_signals = [s for s in signals if s['entry_date'] == cur_dt]
        day_signals.sort(key=lambda x: x['score'], reverse=True)

        for sig in day_signals:
            if len(active) >= MAX_CONCURRENT_POSITIONS:
                break
            if any(p['symbol'] == sig['symbol'] for p in active):
                continue
            sym = sig['symbol']
            sd = stock_data[sym]
            if cur_dt not in sd['dates']:
                continue
            idx = sd['dates'].index(cur_dt)
            entry_p = sd['mat'][idx, 0]

            struct_sl = sig['stop_level']
            risk_pct = (entry_p - struct_sl) / entry_p
            if risk_pct < MIN_RISK_PCT:
                struct_sl = entry_p * (1.0 - MIN_RISK_PCT)
                risk_pct = MIN_RISK_PCT
            elif risk_pct > MAX_RISK_PCT:
                struct_sl = entry_p * (1.0 - MAX_RISK_PCT)
                risk_pct = MAX_RISK_PCT

            active.append({
                'symbol': sym,
                'pattern': sig['pattern'],
                'entry_date': cur_dt,
                'entry_price': entry_p,
                'cur_sl': struct_sl,
                'target_1': entry_p * (1.0 + TARGET_1_PCT),
                'risk_pct': risk_pct,
                'bars_held': 0,
                'hit_t1': False
            })

    return trades

def print_metrics(label, trades):
    if not trades:
        print(f"{label}: 0 trades")
        return
    wins = [t for t in trades if t['is_win']]
    losses = [t for t in trades if not t['is_win']]
    wr = len(wins) / len(trades) * 100.0
    gross_w = sum(t['net_pct'] for t in wins)
    gross_l = abs(sum(t['net_pct'] for t in losses))
    pf = gross_w / (gross_l + 1e-9)
    r_tot = sum(t['r_mult'] for t in trades)

    oos = [t for t in trades if t['is_oos']]
    oos_w = [t for t in oos if t['is_win']]
    oos_l = [t for t in oos if not t['is_win']]
    oos_pf = sum(t['net_pct'] for t in oos_w) / (abs(sum(t['net_pct'] for t in oos_l)) + 1e-9)

    print(f"{label}:")
    print(f"  Total Trades: {len(trades)} | Win Rate: {wr:.1f}% | Total PF: {pf:.2f} | OOS PF: {oos_pf:.2f} | Net R: {r_tot:+.1f}R")

def main():
    stock_data, nifty_map = load_clean_market_data()
    print("Running Baseline (No Vol, No Extension Cap)...")
    base_sigs = extract_signals(stock_data, nifty_map, min_vol_ratio=0.0, max_extension=1.15)
    base_trades = run_portfolio(base_sigs, stock_data)
    print_metrics("Baseline", base_trades)

    print("\nRunning Institutional Enhanced (Vol >= 1.25x, Capped Buy Pocket <= 2.5%)...")
    enh_sigs = extract_signals(stock_data, nifty_map, min_vol_ratio=1.25, max_extension=1.025)
    enh_trades = run_portfolio(enh_sigs, stock_data)
    print_metrics("Institutional Enhanced", enh_trades)

if __name__ == '__main__':
    main()

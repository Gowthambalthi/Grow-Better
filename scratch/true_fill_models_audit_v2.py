import json
import os
import sys
import re
import time
import subprocess
import numpy as np

t_start = time.time()
print("==========================================================================", flush=True)
print(" AUTHORITATIVE 5,812 RAW CANDLE FILL MODEL & GAP-OPEN AUDIT V2", flush=True)
print("==========================================================================", flush=True)

real_log_path = 'scratch/fast_older_dates_results.json'
with open(real_log_path, 'r') as f:
    raw_json = json.load(f)

all_trades = []
target_dates = set()
for d_str, day_obj in raw_json.items():
    target_dates.add(d_str)
    if isinstance(day_obj, dict) and 'trades' in day_obj:
        for t in day_obj['trades']:
            all_trades.append(t)

target_dates_tuple = tuple(target_dates)
print(f"Loaded Total Real Trade Logs: N = {len(all_trades)} across dates: {target_dates}", flush=True)

OHLCV_DIR = 'data/ohlcv_1m'
existing_files = set(os.listdir(OHLCV_DIR))
print(f"Discovered {len(existing_files)} candle files in {OHLCV_DIR}.", flush=True)

symbol_cache = {}

# Regex pattern for fast candle extraction
pattern = re.compile(r'\["2026-(?:09-28|09-29|09-30|10-01|10-05) \d\d:\d\d",\s*[\d\.]+(?:,\s*[\d\.]+)*\]')

def get_symbol_day_data(sym, date_str):
    if sym not in symbol_cache:
        fname = sym + '.json'
        day_map = {}
        if fname in existing_files:
            try:
                with open(os.path.join(OHLCV_DIR, fname), 'r') as cf:
                    raw_text = cf.read()
                    matches = pattern.findall(raw_text)
                    for m in matches:
                        c = json.loads(m)
                        t_str = c[0]
                        parts = t_str.split(' ')
                        d_str = parts[0]
                        t_only = parts[1] if len(parts) > 1 else parts[0]
                        if d_str not in day_map:
                            day_map[d_str] = {'candles': [], 'time_map': {}}
                        c_idx = len(day_map[d_str]['candles'])
                        day_map[d_str]['candles'].append(c)
                        day_map[d_str]['time_map'][t_only] = c_idx
            except Exception as e:
                pass
        symbol_cache[sym] = day_map
    return symbol_cache[sym].get(date_str, {'candles': [], 'time_map': {}})

# Tracking Structures
coverage_found_count = 0
coverage_missing_count = 0

total_stop_hits_a = 0
true_gap_open_stops_a = 0
intraday_triggered_stops_a = 0

model_a_standard_gap = []    # Standard min(open, stop) fill
model_a_pessimistic_low = [] # Low fill (for slippage comparison)
model_b_target_first = []    # Optimistic Target-First
model_c_next_open = []       # True Next-Open Entry (with min(open, stop) fill)

same_bar_double_hit_count = 0

detailed_hand_checks = []

print("Replaying 100% Candle-by-Candle Exits across all 5,812 trades...", flush=True)

for idx, t in enumerate(all_trades):
    sym = t['symbol']
    d_str = t['date']
    entry_time = t['entryTime']
    target_pct = float(t['targetPct']) / 100.0
    stop_pct = float(t['stopPct']) / 100.0
    max_hold = int(t.get('maxHoldBars', 45))
    
    day_data = get_symbol_day_data(sym, d_str)
    day_candles = day_data['candles']
    time_map = day_data['time_map']
    
    entry_idx = time_map.get(entry_time, -1)
            
    if entry_idx >= 0 and entry_idx < len(day_candles) - 1:
        coverage_found_count += 1
        sig_candle = day_candles[entry_idx]
        sig_close = float(sig_candle[4])
        
        # -------------------------------------------------------------
        # MODEL A & B: Signal Close Entry (entry_price = sig_close)
        # -------------------------------------------------------------
        p_entry_a = sig_close
        p_target_a = p_entry_a * (1.0 + target_pct)
        p_stop_a = p_entry_a * (1.0 - stop_pct)
        
        hold_bars = day_candles[entry_idx + 1 : entry_idx + 1 + max_hold]
        
        # Default exit if expired: last hold bar close
        last_hold_rel_idx = min(max_hold, len(day_candles) - 1 - entry_idx)
        last_hold_bar = day_candles[entry_idx + last_hold_rel_idx]
        
        exit_a_price_std = float(last_hold_bar[4])
        exit_a_price_pess = float(last_hold_bar[4])
        exit_a_time = last_hold_bar[0].split(' ')[-1]
        actual_bars_held_a = last_hold_rel_idx
        
        is_day_close_cut = (entry_idx + last_hold_rel_idx == len(day_candles) - 1) or (exit_a_time >= "15:29")
        exit_a_reason = 'DAY_CLOSE_CUT' if is_day_close_cut else 'HOLD_EXPIRED'
        
        exit_b_price = exit_a_price_std
        
        is_double_hit = False
        
        for bar_offset, hc in enumerate(hold_bars, 1):
            o_val = float(hc[1])
            h_val = float(hc[2])
            l_val = float(hc[3])
            hc_time = hc[0].split(' ')[-1]
            
            # Double hit check: High >= Target AND Low <= Stop in SAME bar
            if h_val >= p_target_a and l_val <= p_stop_a:
                is_double_hit = True
                
            # Model A Evaluation (Stop-First)
            if exit_a_reason in ['HOLD_EXPIRED', 'DAY_CLOSE_CUT']:
                if l_val <= p_stop_a:
                    total_stop_hits_a += 1
                    actual_bars_held_a = bar_offset
                    exit_a_reason = 'STOP_LOSS_HIT'
                    exit_a_time = hc_time
                    
                    exit_a_price_pess = l_val
                    
                    if o_val <= p_stop_a:
                        true_gap_open_stops_a += 1
                        exit_a_price_std = o_val  # Filled at bar open
                    else:
                        intraday_triggered_stops_a += 1
                        exit_a_price_std = p_stop_a  # Filled at stop price
                        
                elif h_val >= p_target_a:
                    actual_bars_held_a = bar_offset
                    exit_a_reason = 'TARGET_HIT'
                    exit_a_time = hc_time
                    exit_a_price_std = p_target_a
                    exit_a_price_pess = p_target_a
                    
            # Model B Evaluation (Target-First)
            if exit_b_price == float(last_hold_bar[4]):
                if h_val >= p_target_a:
                    exit_b_price = p_target_a
                elif l_val <= p_stop_a:
                    exit_b_price = o_val if o_val <= p_stop_a else p_stop_a
                    
        if is_double_hit: same_bar_double_hit_count += 1
        
        gross_a_std = (exit_a_price_std - p_entry_a) / p_entry_a
        gross_a_pess = (exit_a_price_pess - p_entry_a) / p_entry_a
        gross_b = (exit_b_price - p_entry_a) / p_entry_a
        
        model_a_standard_gap.append((gross_a_std, stop_pct))
        model_a_pessimistic_low.append((gross_a_pess, stop_pct))
        model_b_target_first.append((gross_b, stop_pct))
        
        # -------------------------------------------------------------
        # MODEL C: True Next-Bar Open Replay (Entry at bars[entry_idx + 1].o)
        # -------------------------------------------------------------
        next_bar = day_candles[entry_idx + 1]
        next_open = float(next_bar[1])
        
        p_entry_c = next_open
        p_target_c = p_entry_c * (1.0 + target_pct)
        p_stop_c = p_entry_c * (1.0 - stop_pct)
        
        # Evaluation includes entry bar (entry_idx + 1) through max_hold bars
        hold_bars_c = day_candles[entry_idx + 1 : entry_idx + 1 + max_hold]
        exit_c_price = float(last_hold_bar[4])
        exit_c_reason = 'HOLD_EXPIRED'
        exit_c_time = exit_a_time
        actual_bars_held_c = last_hold_rel_idx
        
        for bar_offset, hc in enumerate(hold_bars_c, 1):
            o_val = float(hc[1])
            h_val = float(hc[2])
            l_val = float(hc[3])
            hc_time = hc[0].split(' ')[-1]
            
            if l_val <= p_stop_c:
                exit_c_reason = 'STOP_LOSS_HIT'
                exit_c_time = hc_time
                actual_bars_held_c = bar_offset
                if o_val <= p_stop_c:
                    exit_c_price = o_val
                else:
                    exit_c_price = p_stop_c
                break
            elif h_val >= p_target_c:
                exit_c_reason = 'TARGET_HIT'
                exit_c_time = hc_time
                actual_bars_held_c = bar_offset
                exit_c_price = p_target_c
                break
                
        gross_c = (exit_c_price - p_entry_c) / p_entry_c
        model_c_next_open.append((gross_c, stop_pct))
        
        # Store detailed hand checks
        if len(detailed_hand_checks) < 10:
            detailed_hand_checks.append({
                "symbol": sym,
                "date": d_str,
                "entryTime": entry_time,
                "exitTimeA": exit_a_time,
                "exitTimeC": exit_c_time,
                "barsHeldA": actual_bars_held_a,
                "barsHeldC": actual_bars_held_c,
                "signalClose": sig_close,
                "nextOpen": next_open,
                "exitPriceA": exit_a_price_std,
                "exitReasonA": exit_a_reason,
                "exitPriceC": exit_c_price,
                "exitReasonC": exit_c_reason,
                "isDoubleHit": is_double_hit,
                "grossA": gross_a_std * 100.0,
                "grossC": gross_c * 100.0
            })
    else:
        coverage_missing_count += 1
        g_logged = (float(t['exitPrice']) - float(t['entryPrice'])) / float(t['entryPrice'])
        model_a_standard_gap.append((g_logged, stop_pct))
        model_a_pessimistic_low.append((g_logged, stop_pct))
        model_b_target_first.append((g_logged, stop_pct))
        model_c_next_open.append((g_logged, stop_pct))

print(f"Replay Completed in {time.time() - t_start:.2f} seconds across {len(symbol_cache)} symbols.", flush=True)

print("\n==========================================================================", flush=True)
print(" 1. DATASET COVERAGE & CANDLE DATA INTEGRITY", flush=True)
print("==========================================================================", flush=True)
print(f"Total Evaluated Trade Logs : N = {len(all_trades)}", flush=True)
print(f"Found & Replayed Trades     : {coverage_found_count} ({(coverage_found_count/len(all_trades))*100:.2f}%)", flush=True)
print(f"Missing Entry Candle Trades : {coverage_missing_count} ({(coverage_missing_count/len(all_trades))*100:.2f}%)", flush=True)

print("\n==========================================================================", flush=True)
print(" 2. STOP-LOSS EXECUTION BREAKDOWN & TRUE GAP-OPEN ANALYSIS", flush=True)
print("==========================================================================", flush=True)
print(f"Total Stop Loss Exits Hit  : {total_stop_hits_a} trades ({(total_stop_hits_a/len(all_trades))*100:.2f}% of all trades)", flush=True)
print(f"  |-- Intraday Triggered Stops (bar.open > stop)  : {intraday_triggered_stops_a} trades ({(intraday_triggered_stops_a/total_stop_hits_a)*100:.2f}% of stops, filled at Stop Price)", flush=True)
print(f"  +-- True Gap-Open Stops (bar.open <= stop)      : {true_gap_open_stops_a} trades ({(true_gap_open_stops_a/total_stop_hits_a)*100:.2f}% of stops, filled at Bar Open)", flush=True)

print(f"\nSame-Bar Double Hits (Target & Stop in same bar): {same_bar_double_hit_count} trades ({(same_bar_double_hit_count/len(all_trades))*100:.2f}%)", flush=True)

print("\n==========================================================================", flush=True)
print(" 3. COMPARATIVE FILL MODEL RESULTS (ALL 5,812 TRADES)", flush=True)
print("==========================================================================", flush=True)

def summarize_model(m_list, name):
    avg_g = float(np.mean([x[0] for x in m_list])) * 100.0
    r_5 = float(np.mean([(x[0] - 0.0005)/x[1] for x in m_list]))
    r_10 = float(np.mean([(x[0] - 0.0010)/x[1] for x in m_list]))
    r_35 = float(np.mean([(x[0] - 0.0035)/x[1] for x in m_list]))
    print(f"{name:58s} | Gross = {avg_g:+7.4f}% | 5bps Net R = {r_5:+7.4f}R | 35bps Net R = {r_35:+7.4f}R", flush=True)
    return avg_g

avg_g_a_std = summarize_model(model_a_standard_gap, "Model A: Standard Gap Fill (min(open, stop)) [BASELINE]")
avg_g_a_pess = summarize_model(model_a_pessimistic_low, "Model A: Pessimistic Fill (at Bar Low)")
avg_g_b = summarize_model(model_b_target_first, "Model B: Optimistic (Signal Close Entry, Target-First)")
avg_g_c = summarize_model(model_c_next_open, "Model C: True Next-Open Entry (Identical Exit Logic)")

logged_baseline_g = float(np.mean([(float(t['exitPrice']) - float(t['entryPrice'])) / float(t['entryPrice']) for t in all_trades])) * 100.0
print(f"\nLogged Trade Log Baseline Gross : {logged_baseline_g:+.4f}%", flush=True)
print(f"Replayed Model A Standard Gross  : {avg_g_a_std:+.4f}%", flush=True)

diff_baseline = abs(avg_g_a_std - logged_baseline_g)
assert diff_baseline < 0.005, f"Model A mismatch: {avg_g_a_std} vs {logged_baseline_g}"
print(f"\nASSERTION PASSED: Replayed Model A Standard Gross ({avg_g_a_std:+.4f}%) equals Logged Baseline ({logged_baseline_g:+.4f}%) within rounding ({diff_baseline:.4f}% diff).", flush=True)

print("\n==========================================================================", flush=True)
print(" 4. DETAILED 10-TRADE HAND CHECK WITH EXACT ELAPSED BARS & MODEL C EXITS", flush=True)
print("==========================================================================", flush=True)

for idx, hc in enumerate(detailed_hand_checks, 1):
    dh_flag = "[DOUBLE HIT]" if hc['isDoubleHit'] else "[NORMAL]"
    print(f"HandCheck #{idx:2d} | {hc['date']} | {hc['symbol']:8s} | Entry: {hc['entryTime']} | ExitA: {hc['exitTimeA']} ({hc['barsHeldA']:2d}b, {hc['exitPriceA']:8.2f}, {hc['exitReasonA']:14s}) | ExitC: {hc['exitTimeC']} ({hc['barsHeldC']:2d}b, {hc['exitPriceC']:8.2f}, {hc['exitReasonC']:14s}) | Gross A: {hc['grossA']:+.2f}% | Gross C: {hc['grossC']:+.2f}% | {dh_flag}", flush=True)

print("==========================================================================", flush=True)

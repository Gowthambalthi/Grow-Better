import os
import sys
import json
import math
import numpy as np
import pandas as pd

# Add workspace root and strategies/mine to path
ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from strategies.mine.config import (
    FRICTION_BPS, FRICTION_DECIMAL, OOS_SPLIT_DATE, MIN_TURNOVER_CR, REQUIRE_NIFTY_BULL,
    BASE_LOOKBACK, MACRO_LOOKBACK, MIN_BASE_DEPTH, MAX_BASE_DEPTH, MIN_CEIL_AGE,
    MAX_PRIOR_20D_RUN, MAX_PRIOR_5D_RUN, MAX_PRIOR_3D_RUN, MIN_DIST_52W, MAX_PRE_RANGE_3D,
    ALLOW_INTERMEDIATE_BASE, INTERMEDIATE_BASE_MIN_DIST_52W, INTERMEDIATE_BASE_MAX_DIST_EMA200,
    MIN_TOUCHES, PENETRATION_BUFFER_ATR, MIN_BODY_RATIO, MIN_CLOSE_LOC, MAX_UPPER_WICK,
    MIN_RVOL, MAX_RVOL, MAX_CHASE_PCT, INITIAL_STOP_ATR, MIN_RISK_PCT, MAX_RISK_PCT,
    TARGET_1_R, TRANCHE_1_TARGET_PCT, EARLY_INVALIDATION_PCT,
    BREAKEVEN_TRIGGER_R, BREAKEVEN_BUFFER_PCT,
    MAX_CONCURRENT_POSITIONS, CAPITAL_PER_POSITION, STARTING_CAPITAL, MAX_HOLD_BARS
)
from strategies.mine.scripts.data_loader import load_clean_market_data, get_project_root

def calculate_wilson_ci(wins, total, confidence=0.95):
    if total == 0:
        return 0.0, 0.0, 0.0
    z = 1.95996
    p_hat = wins / total
    denom = 1 + (z**2) / total
    center = (p_hat + (z**2) / (2 * total)) / denom
    margin = (z * math.sqrt((p_hat * (1 - p_hat) / total) + ((z**2) / (4 * (total**2))))) / denom
    return p_hat, max(0.0, center - margin), min(1.0, center + margin)

def calculate_r_ci(r_list, confidence=0.95):
    if len(r_list) < 2:
        return 0.0, 0.0, 0.0
    arr = np.array(r_list)
    mean_r = float(np.mean(arr))
    se = float(np.std(arr, ddof=1) / math.sqrt(len(arr)))
    z = 1.95996
    return mean_r, mean_r - z * se, mean_r + z * se

def extract_all_signals(stock_data, nifty_map):
    """
    Extracts candidate breakout signals strictly at Day t Close.
    Incorporates V5 Anti-Sprint, VCP Tightness, and 52W Proximity gates.
    """
    signals = []
    
    for sym, d in stock_data.items():
        mat = d['mat']
        dates = d['dates']
        v_sma = d['v_sma']
        atr = d['atr']
        ema20 = d['ema20']
        ema200 = d['ema200']
        n = len(dates)
        
        c = mat[:, 3]
        o = mat[:, 0]
        h = mat[:, 1]
        l = mat[:, 2]
        v = mat[:, 4]
        
        for i in range(MACRO_LOOKBACK, n - 1):
            sig_date = dates[i]
            
            # 1. Market Gate (NIFTY 50 > 50 EMA on sig_date)
            if REQUIRE_NIFTY_BULL:
                if sig_date not in nifty_map:
                    continue
                if not nifty_map[sig_date]['bull']:
                    continue
                    
            # 2. Stock Trend & Liquidity Gates
            cur_c, cur_o, cur_h, cur_l, cur_v = c[i], o[i], h[i], l[i], v[i]
            sma_v, cur_atr = v_sma[i], atr[i]
            if np.isnan(sma_v) or sma_v <= 0 or np.isnan(cur_atr) or cur_atr <= 0:
                continue
            if cur_c < ema200[i]:
                continue
                
            # 3. Base Consolidation & Macro True Resistance
            base_window = mat[i-BASE_LOOKBACK : i, :]
            ceil_40 = np.max(base_window[:, 1])
            floor_40 = np.min(base_window[:, 2])
            
            h_60 = np.max(h[i-MACRO_LOOKBACK : i])
            true_ceil = max(ceil_40, h_60)
            
            base_depth = (true_ceil - floor_40) / true_ceil
            if not (MIN_BASE_DEPTH <= base_depth <= MAX_BASE_DEPTH):
                continue
                
            # Close must exceed True Ceiling + ATR buffer
            if cur_c < true_ceil + PENETRATION_BUFFER_ATR * cur_atr:
                continue
                
            # Base Symmetry: >= 25% of closes in upper half (allows cup-with-handle & ascending bases)
            mid_base = floor_40 + 0.5 * (true_ceil - floor_40)
            upper_half_pct = np.sum(c[i-BASE_LOOKBACK : i] >= mid_base) / float(BASE_LOOKBACK)
            if upper_half_pct < 0.25:
                continue
                
            # Ceiling Age: Allow fresh 52W high breakout or established resistance >= MIN_CEIL_AGE
            w52 = max(0, i - 250)
            high_52w = np.max(h[w52 : i])
            dist_52w = (cur_c - high_52w) / high_52w
            
            ceil_bar_idx = np.argmax(h[i-MACRO_LOOKBACK : i])
            ceil_age = MACRO_LOOKBACK - ceil_bar_idx
            if ceil_age < MIN_CEIL_AGE and dist_52w < -0.02:
                # Check if recent high is just a pre-breakout test wick of an earlier established resistance
                earlier_touches = [k for k in range(MACRO_LOOKBACK - 3) if h[i-MACRO_LOOKBACK + k] >= true_ceil * 0.985]
                if earlier_touches:
                    ceil_age = MACRO_LOOKBACK - earlier_touches[0]
            if ceil_age < MIN_CEIL_AGE and dist_52w < -0.02:
                continue
                
            # Anti-Runaway: Prior 20-day return <= MAX_PRIOR_20D_RUN (18%)
            prior_20d_ret = (cur_c - c[i-20]) / c[i-20]
            if prior_20d_ret > MAX_PRIOR_20D_RUN:
                continue
                
            # --- V5 ANTI-EXHAUSTION & DUAL-GATE 52W / BASE PROXIMITY ---
            # Gate 1: 52-Week High Proximity or Multi-Week Base Launch
            dist_200 = (cur_c - ema200[i]) / ema200[i]
            
            passed_proximity = False
            if dist_52w >= MIN_DIST_52W:
                passed_proximity = True  # Case 1: Pure Blue Sky (within 5% of 52w high)
            elif ALLOW_INTERMEDIATE_BASE and (dist_52w >= INTERMEDIATE_BASE_MIN_DIST_52W) and (dist_200 <= INTERMEDIATE_BASE_MAX_DIST_EMA200):
                passed_proximity = True  # Case 2: Multi-Week Stage 2 base launch near 200 EMA (e.g. RELIANCE)
                
            if not passed_proximity:
                continue
                
            # Gate 2: Multi-Window Anti-Sprint (KILLS ADANIPORTS EXHAUSTION SPRINT)
            prior_5d = (cur_c - c[max(0, i-5)]) / c[max(0, i-5)]
            prior_3d = (cur_c - c[max(0, i-3)]) / c[max(0, i-3)]
            if prior_5d > MAX_PRIOR_5D_RUN or prior_3d > MAX_PRIOR_3D_RUN:
                continue
                
            # Gate 3: Pre-Breakout Tightness / VCP Consolidation
            pre_h3 = np.max(h[max(0, i-3) : i])
            pre_l3 = np.min(l[max(0, i-3) : i])
            if (pre_h3 - pre_l3) / pre_l3 > MAX_PRE_RANGE_3D:
                continue
                
            # Touches near True Ceiling (within 1.5%) - required for range bases, waived for ATH blue sky
            touches = int(np.sum(h[i-MACRO_LOOKBACK : i] >= true_ceil * 0.985))
            if touches < MIN_TOUCHES and dist_52w < -0.02:
                continue
                
            # 4. Candle Microstructure & RVOL
            rng = max(cur_h - cur_l, 1e-4)
            body = cur_c - cur_o
            body_ratio = body / rng
            close_loc = (cur_c - cur_l) / rng
            upper_wick = (cur_h - max(cur_o, cur_c)) / rng
            
            if cur_c <= cur_o or body_ratio < MIN_BODY_RATIO or close_loc < MIN_CLOSE_LOC or upper_wick > MAX_UPPER_WICK:
                continue
                
            rvol = cur_v / sma_v
            if rvol < MIN_RVOL or rvol > MAX_RVOL:
                continue
                
            signals.append({
                'symbol': sym,
                'sig_idx': i,
                'sig_date': sig_date,
                'entry_date': dates[i+1],
                'true_ceil': true_ceil,
                'cur_atr': cur_atr,
                'cur_l': cur_l,
                'cur_c': cur_c,
                'rvol': rvol,
                'turnover': d['turnover']
            })
            
    signals.sort(key=lambda s: (s['sig_date'], -s['rvol']))
    print(f"Total Calibrated V5 Signals Generated: {len(signals)}")
    return signals

def run_portfolio_simulation(signals, stock_data, model_type='E'):
    """
    Executes dated daily portfolio simulation with zero lookahead.
    Model A: Original (-1.0R Stop, T1 +1.5R, 20 EMA Trail)
    Model B: Next-Bar Breakeven (+1.0R trigger confirms on Close -> active Next Bar)
    Model C: MAE Invalidation Cut at -0.65R
    Model E: V5 Institutional Flagship:
             - Tranche 1: 50% locked in at +2.5% (reached by 40.2% of large caps)
             - Stop moved to Breakeven (+0.2% buffer)
             - Early Invalidation: If price drops <= -1.5%, cut immediately
             - Tranche 2: 50% trailed via 20 EMA Close
    """
    all_dates = sorted(list(set(d for sd in stock_data.values() for d in sd['dates'])))
    
    cash = STARTING_CAPITAL
    max_positions = MAX_CONCURRENT_POSITIONS
    pos_allocation = CAPITAL_PER_POSITION
    
    open_positions = []
    closed_trades = []
    daily_equity = []
    
    signals_by_entry_date = {}
    for s in signals:
        ed = s['entry_date']
        signals_by_entry_date.setdefault(ed, []).append(s)
        
    for current_date in all_dates:
        # A. Process Exits on Open Positions
        remaining_positions = []
        
        for pos in open_positions:
            sym = pos['symbol']
            sd = stock_data[sym]
            s_dates = sd['dates']
            mat = sd['mat']
            ema20 = sd['ema20']
            
            if current_date not in s_dates:
                remaining_positions.append(pos)
                continue
                
            bar_idx = s_dates.index(current_date)
            b_o, b_h, b_l, b_c = mat[bar_idx, 0], mat[bar_idx, 1], mat[bar_idx, 2], mat[bar_idx, 3]
            pos['bars_held'] += 1
            pos['highs'].append(b_h)
            pos['lows'].append(b_l)
            
            active_stop = pos['current_stop']
            
            # Model B Breakeven Activation from previous bar
            if model_type == 'B' and pos['be_triggered_prev_day']:
                active_stop = max(active_stop, pos['entry_p'] * (1.0 + BREAKEVEN_BUFFER_PCT))
                pos['current_stop'] = active_stop
                
            exit_occurred = False
            exit_price = 0.0
            exit_reason = ''
            
            # --- MODEL E (V5 INSTITUTIONAL) EXIT LOGIC ---
            if model_type == 'E':
                t1_p = pos['entry_p'] * (1.0 + TRANCHE_1_TARGET_PCT)
                inval_p = pos['entry_p'] * (1.0 - EARLY_INVALIDATION_PCT)
                
                # Check Tranche 1 Hit (+2.5%)
                if not pos['hit_t1'] and b_h >= t1_p:
                    pos['hit_t1'] = True
                    pos['t1_price'] = max(b_o, t1_p)
                    # Ratchet stop to Breakeven + buffer for remaining 50%
                    pos['current_stop'] = max(pos['current_stop'], pos['entry_p'] * (1.0 + BREAKEVEN_BUFFER_PCT))
                    active_stop = pos['current_stop']
                    
                # 1. Check Stop Loss / Breakeven Hit
                if b_l <= active_stop:
                    exit_price = min(b_o, active_stop)
                    exit_reason = 'Stop Loss Hit' if active_stop <= pos['initial_stop'] * 1.001 else 'Breakeven Trailed'
                    exit_occurred = True
                # 2. Early Invalidation: if price drops to -1.5% before T1
                elif not pos['hit_t1'] and b_l <= inval_p:
                    exit_price = min(b_o, inval_p)
                    exit_reason = 'Early Invalidation (-1.5%)'
                    exit_occurred = True
                # 3. Max Hold
                elif pos['bars_held'] >= MAX_HOLD_BARS:
                    exit_price = b_c
                    exit_reason = 'Max Hold Expired (45d)'
                    exit_occurred = True
                # 4. Trailing 20 EMA for remaining 50%
                elif pos['hit_t1']:
                    if pos.get('ema20_exit_signal_yesterday', False):
                        exit_price = b_o
                        exit_reason = '20 EMA Trailing Exit'
                        exit_occurred = True
                    elif b_c < ema20[bar_idx]:
                        pos['ema20_exit_signal_yesterday'] = True
                        
            # --- MODELS A / B / C EXIT LOGIC ---
            else:
                # Model C Invalidation cut at -0.65R
                if model_type == 'C' and not pos['hit_t1']:
                    inval_level = pos['entry_p'] - 0.65 * pos['risk']
                    if b_l <= inval_level:
                        exit_price = min(b_o, inval_level)
                        exit_reason = 'Model C Invalidation (-0.65R)'
                        exit_occurred = True
                        
                if not exit_occurred and b_l <= active_stop:
                    exit_price = min(b_o, active_stop)
                    exit_reason = 'Stop Loss Hit' if active_stop <= pos['initial_stop'] * 1.001 else 'Breakeven Trailed'
                    exit_occurred = True
                    
                if not exit_occurred and not pos['hit_t1']:
                    if b_h >= pos['t1_p']:
                        pos['hit_t1'] = True
                        pos['current_stop'] = max(pos['current_stop'], pos['entry_p'] * (1.0 + BREAKEVEN_BUFFER_PCT))
                        
                if model_type == 'B' and not pos['be_triggered_prev_day']:
                    if b_h >= pos['entry_p'] + BREAKEVEN_TRIGGER_R * pos['risk']:
                        pos['be_triggered_prev_day'] = True
                        
                if not exit_occurred and pos['hit_t1']:
                    if pos.get('ema20_exit_signal_yesterday', False):
                        exit_price = b_o
                        exit_reason = '20 EMA Trailing Exit'
                        exit_occurred = True
                    elif b_c < ema20[bar_idx]:
                        pos['ema20_exit_signal_yesterday'] = True
                        
                if not exit_occurred and pos['bars_held'] >= MAX_HOLD_BARS:
                    exit_price = b_c
                    exit_reason = 'Max Hold Expired (45d)'
                    exit_occurred = True
                    
            if exit_occurred:
                r_friction = (FRICTION_DECIMAL * pos['entry_p']) / pos['risk']
                
                if model_type == 'E':
                    if pos['hit_t1']:
                        t1_ret = (pos['t1_price'] - pos['entry_p']) / pos['entry_p']
                        t2_ret = (exit_price - pos['entry_p']) / pos['entry_p']
                        gross_ret = 0.5 * t1_ret + 0.5 * t2_ret
                        net_ret = gross_ret - FRICTION_DECIMAL
                        r_mult = net_ret / pos['risk_pct']
                    else:
                        gross_ret = (exit_price - pos['entry_p']) / pos['entry_p']
                        net_ret = gross_ret - FRICTION_DECIMAL
                        r_mult = net_ret / pos['risk_pct']
                else:
                    if pos['hit_t1']:
                        t1_ret = (pos['t1_p'] - pos['entry_p']) / pos['entry_p']
                        t2_ret = (exit_price - pos['entry_p']) / pos['entry_p']
                        gross_ret = 0.3333 * t1_ret + 0.6667 * t2_ret
                        net_ret = gross_ret - FRICTION_DECIMAL
                        r_mult = 0.3333 * TARGET_1_R + 0.6667 * ((exit_price - pos['entry_p']) / pos['risk']) - r_friction
                    else:
                        gross_ret = (exit_price - pos['entry_p']) / pos['entry_p']
                        net_ret = gross_ret - FRICTION_DECIMAL
                        r_mult = (exit_price - pos['entry_p']) / pos['risk'] - r_friction
                        
                trade_proceeds = pos['position_val'] * (1.0 + net_ret)
                cash += trade_proceeds
                
                closed_trades.append({
                    'symbol': sym,
                    'sig_date': pos['sig_date'],
                    'entry_date': pos['entry_date'],
                    'entry_p': pos['entry_p'],
                    'exit_date': current_date,
                    'exit_p': exit_price,
                    'net_pnl': net_ret,
                    'r_mult': r_mult,
                    'win': bool(net_ret > 0),
                    'exit_reason': exit_reason,
                    'is_oos': pos['entry_date'] >= OOS_SPLIT_DATE,
                    'mfe_pct': (max(pos['highs']) - pos['entry_p']) / pos['entry_p'] * 100.0,
                    'mae_pct': (min(pos['lows']) - pos['entry_p']) / pos['entry_p'] * 100.0
                })
            else:
                remaining_positions.append(pos)
                
        open_positions = remaining_positions
        
        # B. Process New Entries for current_date
        if current_date in signals_by_entry_date:
            candidates = signals_by_entry_date[current_date]
            
            for s in candidates:
                if len(open_positions) >= max_positions:
                    break
                    
                sym = s['symbol']
                if any(p['symbol'] == sym for p in open_positions):
                    continue
                    
                sd = stock_data[sym]
                s_dates = sd['dates']
                mat = sd['mat']
                
                if current_date not in s_dates:
                    continue
                    
                b_idx = s_dates.index(current_date)
                day_open = mat[b_idx, 0]
                day_high = mat[b_idx, 1]
                day_low = mat[b_idx, 2]
                
                # Day t+1 Execution: Buy at Open capped at max chase pct (2%) above Day t Close
                max_allowed_open = s['cur_c'] * (1.0 + MAX_CHASE_PCT)
                if day_open > max_allowed_open:
                    continue  # Gapped up excessively above breakout close
                fill_price = day_open
                    
                raw_stop = s['cur_l']
                risk_distance = fill_price - raw_stop
                risk_pct = risk_distance / fill_price
                
                if risk_pct > MAX_RISK_PCT or risk_pct < MIN_RISK_PCT:
                    continue
                    
                initial_stop = raw_stop
                t1_p = fill_price * (1.0 + TRANCHE_1_TARGET_PCT) if model_type == 'E' else fill_price + TARGET_1_R * risk_distance
                
                allocated_capital = cash * pos_allocation
                cash -= allocated_capital
                
                open_positions.append({
                    'symbol': sym,
                    'sig_date': s['sig_date'],
                    'entry_date': current_date,
                    'entry_p': fill_price,
                    'initial_stop': initial_stop,
                    'current_stop': initial_stop,
                    'risk': risk_distance,
                    'risk_pct': risk_pct,
                    't1_p': t1_p,
                    'hit_t1': False,
                    't1_price': 0.0,
                    'be_triggered_prev_day': False,
                    'bars_held': 0,
                    'highs': [day_high],
                    'lows': [day_low],
                    'position_val': allocated_capital
                })
                
        # C. Track Daily Portfolio Equity
        invested_val = 0.0
        for pos in open_positions:
            sym = pos['symbol']
            sd = stock_data[sym]
            s_dates = sd['dates']
            mat = sd['mat']
            if current_date in s_dates:
                b_idx = s_dates.index(current_date)
                cur_close = mat[b_idx, 3]
                unrealized_pnl = (cur_close - pos['entry_p']) / pos['entry_p']
                invested_val += pos['position_val'] * (1.0 + unrealized_pnl)
            else:
                invested_val += pos['position_val']
                
        daily_equity.append({
            'date': current_date,
            'cash': cash,
            'invested_val': invested_val,
            'total_equity': cash + invested_val,
            'open_positions_count': len(open_positions)
        })
        
    return closed_trades, daily_equity

def compute_portfolio_metrics(closed_trades, daily_equity):
    total_trades = len(closed_trades)
    if total_trades == 0:
        return {}
        
    wins = [t for t in closed_trades if t['r_mult'] > 0]
    losses = [t for t in closed_trades if t['r_mult'] <= 0]
    
    win_rate = len(wins) / total_trades * 100.0
    p_hat, w_low, w_high = calculate_wilson_ci(len(wins), total_trades)
    
    r_list = [t['r_mult'] for t in closed_trades]
    pos_r = [r for r in r_list if r > 0]
    neg_r = [abs(r) for r in r_list if r <= 0]
    gross_win_r = sum(pos_r)
    gross_loss_r = sum(neg_r)
    pf = gross_win_r / gross_loss_r if gross_loss_r > 0 else 999.0
    
    mean_r, r_low, r_high = calculate_r_ci(r_list)
    
    pos_pnls = [t['net_pnl'] for t in wins]
    neg_pnls = [abs(t['net_pnl']) for t in losses]
    avg_win_pct = np.mean(pos_pnls) * 100.0 if len(pos_pnls) > 0 else 0.0
    avg_loss_pct = -np.mean(neg_pnls) * 100.0 if len(neg_pnls) > 0 else 0.0
    
    eq_arr = np.array([d['total_equity'] for d in daily_equity])
    cummax = np.maximum.accumulate(eq_arr)
    drawdowns = (cummax - eq_arr) / np.maximum(cummax, 1e-4)
    max_dd = float(np.max(drawdowns)) * 100.0
    
    total_days = len(daily_equity)
    total_return = (eq_arr[-1] - eq_arr[0]) / eq_arr[0]
    years = total_days / 252.0
    cagr = ((1.0 + total_return) ** (1.0 / years) - 1.0) * 100.0 if years > 0 and (1.0 + total_return) > 0 else -100.0
    
    return {
        'total_trades': total_trades,
        'wins': len(wins),
        'losses': len(losses),
        'win_rate': win_rate,
        'wilson_ci': (w_low * 100.0, w_high * 100.0),
        'pf': pf,
        'mean_r': mean_r,
        'r_ci': (r_low, r_high),
        'avg_win': avg_win_pct,
        'avg_loss': avg_loss_pct,
        'max_dd': max_dd,
        'cagr': cagr,
        'total_return': total_return * 100.0
    }

def run_all_models_simulation():
    stock_data, nifty_map = load_clean_market_data()
    signals = extract_all_signals(stock_data, nifty_map)
    
    models = ['A', 'B', 'C', 'E']
    model_names = {
        'A': 'Model A (Original)',
        'B': 'Model B (+1R BE Next-Bar)',
        'C': 'Model C (-0.65R Cut)',
        'E': 'Model E (V5 Institutional Flagship)'
    }
    
    summary = {}
    
    for m in models:
        trades, daily_eq = run_portfolio_simulation(signals, stock_data, model_type=m)
        all_metrics = compute_portfolio_metrics(trades, daily_eq)
        
        train_trades = [t for t in trades if not t['is_oos']]
        oos_trades = [t for t in trades if t['is_oos']]
        
        train_daily = [d for d in daily_eq if d['date'] < OOS_SPLIT_DATE]
        oos_daily = [d for d in daily_eq if d['date'] >= OOS_SPLIT_DATE]
        
        train_metrics = compute_portfolio_metrics(train_trades, train_daily) if train_daily else {}
        oos_metrics = compute_portfolio_metrics(oos_trades, oos_daily) if oos_daily else {}
        
        summary[m] = {
            'all': all_metrics,
            'train': train_metrics,
            'oos': oos_metrics,
            'trades': trades
        }
        
    root = get_project_root()
    out_path = os.path.join(root, 'strategies', 'mine', 'data', 'portfolio_simulation_results.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump({
            m: {
                'all': summary[m]['all'],
                'train': summary[m]['train'],
                'oos': summary[m]['oos'],
                'trades': summary[m]['trades']
            } for m in models
        }, f, indent=2, default=float)
        
    print(f"Results written to {out_path}")
    
    print("\n" + "="*115)
    print(f"      TRUE DATED PORTFOLIO SIMULATION RESULTS (FRICTION = {FRICTION_BPS:.2f} BPS, MAX {MAX_CONCURRENT_POSITIONS} CONCURRENT POS)      ")
    print("="*115)
    
    print(f"{'Metric':<30} | {'Model A (Original)':<18} | {'Model B (+1R BE)':<18} | {'Model C (-0.65R Cut)':<18} | {'Model E (V5 Flagship)':<18}")
    print("-" * 115)
    
    def fmt(m, key, fmt_str):
        val = summary[m]['all'].get(key, 0)
        return fmt_str.format(val)
        
    def fmt_sub(m, sub, key, fmt_str):
        val = summary[m][sub].get(key, 0)
        return fmt_str.format(val)
        
    print(f"{'Total Executed Trades':<30} | {fmt('A', 'total_trades', '{:d}'):<18} | {fmt('B', 'total_trades', '{:d}'):<18} | {fmt('C', 'total_trades', '{:d}'):<18} | {fmt('E', 'total_trades', '{:d}'):<18}")
    print(f"{'Win Rate (%)':<30} | {fmt('A', 'win_rate', '{:.2f}%'):<18} | {fmt('B', 'win_rate', '{:.2f}%'):<18} | {fmt('C', 'win_rate', '{:.2f}%'):<18} | {fmt('E', 'win_rate', '{:.2f}%'):<18}")
    print(f"{'Profit Factor (PF)':<30} | {fmt('A', 'pf', '{:.2f}'):<18} | {fmt('B', 'pf', '{:.2f}'):<18} | {fmt('C', 'pf', '{:.2f}'):<18} | {fmt('E', 'pf', '{:.2f}'):<18}")
    print(f"{'Expectancy E(R)':<30} | {fmt('A', 'mean_r', '{:+.3f}R'):<18} | {fmt('B', 'mean_r', '{:+.3f}R'):<18} | {fmt('C', 'mean_r', '{:+.3f}R'):<18} | {fmt('E', 'mean_r', '{:+.3f}R'):<18}")
    print(f"{'Average Win (%)':<30} | {fmt('A', 'avg_win', '{:+.2f}%'):<18} | {fmt('B', 'avg_win', '{:+.2f}%'):<18} | {fmt('C', 'avg_win', '{:+.2f}%'):<18} | {fmt('E', 'avg_win', '{:+.2f}%'):<18}")
    print(f"{'Average Loss (%)':<30} | {fmt('A', 'avg_loss', '{:+.2f}%'):<18} | {fmt('B', 'avg_loss', '{:+.2f}%'):<18} | {fmt('C', 'avg_loss', '{:+.2f}%'):<18} | {fmt('E', 'avg_loss', '{:+.2f}%'):<18}")
    print(f"{'True Portfolio Max DD (%)':<30} | {fmt('A', 'max_dd', '{:.2f}%'):<18} | {fmt('B', 'max_dd', '{:.2f}%'):<18} | {fmt('C', 'max_dd', '{:.2f}%'):<18} | {fmt('E', 'max_dd', '{:.2f}%'):<18}")
    print(f"{'True Annualized CAGR (%)':<30} | {fmt('A', 'cagr', '{:+.2f}%'):<18} | {fmt('B', 'cagr', '{:+.2f}%'):<18} | {fmt('C', 'cagr', '{:+.2f}%'):<18} | {fmt('E', 'cagr', '{:+.2f}%'):<18}")
    print(f"{'Total Portfolio Return (%)':<30} | {fmt('A', 'total_return', '{:+.2f}%'):<18} | {fmt('B', 'total_return', '{:+.2f}%'):<18} | {fmt('C', 'total_return', '{:+.2f}%'):<18} | {fmt('E', 'total_return', '{:+.2f}%'):<18}")
    
    print("\n" + "-" * 115)
    print("      --- OUT-OF-SAMPLE (Holdout: 2025-04-01 onward per README) ---")
    print(f"{'OOS Trades':<30} | {fmt_sub('A', 'oos', 'total_trades', '{:d}'):<18} | {fmt_sub('B', 'oos', 'total_trades', '{:d}'):<18} | {fmt_sub('C', 'oos', 'total_trades', '{:d}'):<18} | {fmt_sub('E', 'oos', 'total_trades', '{:d}'):<18}")
    print(f"{'OOS Win Rate (%)':<30} | {fmt_sub('A', 'oos', 'win_rate', '{:.2f}%'):<18} | {fmt_sub('B', 'oos', 'win_rate', '{:.2f}%'):<18} | {fmt_sub('C', 'oos', 'win_rate', '{:.2f}%'):<18} | {fmt_sub('E', 'oos', 'win_rate', '{:.2f}%'):<18}")
    print(f"{'OOS Profit Factor':<30} | {fmt_sub('A', 'oos', 'pf', '{:.2f}'):<18} | {fmt_sub('B', 'oos', 'pf', '{:.2f}'):<18} | {fmt_sub('C', 'oos', 'pf', '{:.2f}'):<18} | {fmt_sub('E', 'oos', 'pf', '{:.2f}'):<18}")
    print(f"{'OOS Expectancy E(R)':<30} | {fmt_sub('A', 'oos', 'mean_r', '{:+.3f}R'):<18} | {fmt_sub('B', 'oos', 'mean_r', '{:+.3f}R'):<18} | {fmt_sub('C', 'oos', 'mean_r', '{:+.3f}R'):<18} | {fmt_sub('E', 'oos', 'mean_r', '{:+.3f}R'):<18}")
    print("="*115)

if __name__ == '__main__':
    run_all_models_simulation()

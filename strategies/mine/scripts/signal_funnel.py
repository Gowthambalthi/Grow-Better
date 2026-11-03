import os
import sys
import json
import numpy as np
import pandas as pd

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from strategies.mine.config import (
    MIN_TURNOVER_CR, REQUIRE_NIFTY_BULL, BASE_LOOKBACK, MACRO_LOOKBACK,
    MIN_BASE_DEPTH, MAX_BASE_DEPTH, MIN_CEIL_AGE, MAX_PRIOR_20D_RUN,
    MAX_PRIOR_5D_RUN, MAX_PRIOR_3D_RUN, MIN_DIST_52W, MAX_PRE_RANGE_3D,
    MIN_TOUCHES, PENETRATION_BUFFER_ATR, MIN_BODY_RATIO, MIN_CLOSE_LOC,
    MAX_UPPER_WICK, MIN_RVOL, MAX_RVOL, MAX_CHASE_PCT, INITIAL_STOP_ATR,
    MIN_RISK_PCT, MAX_RISK_PCT, MAX_CONCURRENT_POSITIONS
)

def run_funnel_audit():
    root = ROOT_DIR
    with open(os.path.join(root, 'data/universe_filtered.json'), 'r', encoding='utf-8') as f:
        univ = json.load(f)
    stocks_meta = {s['symbol']: s for s in univ['stocks']}
    symbols = list(stocks_meta.keys())
    
    # NIFTY
    nifty_p = os.path.join(root, 'data/ohlcv_3y/NIFTYBEES.json')
    nifty_map = {}
    if os.path.exists(nifty_p):
        with open(nifty_p, 'r', encoding='utf-8') as f:
            nd = json.load(f)
        ncandles = nd.get('candles', [])
        ndates = [c[0][:10] for c in ncandles]
        ncloses = np.array([c[4] for c in ncandles], dtype=np.float64)
        alpha50 = 2.0 / 51.0
        nema50 = np.zeros(len(ncloses))
        nema50[0] = ncloses[0]
        for t in range(1, len(ncloses)):
            nema50[t] = alpha50 * ncloses[t] + (1.0 - alpha50) * nema50[t-1]
        for d, c, e in zip(ndates, ncloses, nema50):
            nifty_map[d] = bool(c >= e)
            
    # Funnel Counters
    counts = {
        '0_total_universe_symbols': len(symbols),
        '1_turnover_ge_50cr_symbols': 0,
        '2_total_candidate_bars': 0,
        '3_passed_nifty_bull_gate': 0,
        '4_passed_stock_ema200_gate': 0,
        '5_passed_base_depth_4_to_18_pct': 0,
        '6_passed_close_gt_40d_ceil': 0,
        '7_passed_macro_60d_true_ceil': 0,
        '8_passed_base_symmetry_ge_40pct': 0,
        '9_passed_ceil_age_ge_8bars': 0,
        '10_passed_anti_runaway_20d_le_10pct': 0,
        '11_passed_touches_ge_2': 0,
        '12_passed_candle_shape': 0,
        '13_passed_rvol_1_5_to_5_5': 0,
        '14_passed_52w_proximity_blue_sky': 0,
        '15_passed_anti_sprint_5d_and_3d': 0,
        '16_passed_vcp_tightness_3d': 0,
        '17_passed_stop_limit_fill_rule': 0,
        '18_passed_risk_bounds': 0,
        '19_executed_portfolio_5_slot_cap': 0
    }
    
    liquid_symbols = []
    for sym in symbols:
        turnover = stocks_meta[sym].get('avgTurnoverCr', 0.0)
        if turnover >= MIN_TURNOVER_CR:
            counts['1_turnover_ge_50cr_symbols'] += 1
            liquid_symbols.append(sym)
            
    all_signals = []
    
    for sym in liquid_symbols:
        p = os.path.join(root, 'data/ohlcv_3y', f'{sym}.json')
        if not os.path.exists(p): continue
        with open(p, 'r', encoding='utf-8') as f:
            d = json.load(f)
        candles = d.get('candles', [])
        if len(candles) < 220: continue
        
        dates = [c[0][:10] for c in candles]
        arr = np.array([[c[1], c[2], c[3], c[4], c[5]] for c in candles], dtype=np.float64)
        n = len(dates)
        c, o, h, l, v = arr[:, 3], arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 4]
        
        v_sma = np.convolve(v, np.ones(20)/20.0, mode='valid')
        v_sma = np.pad(v_sma, (19, 0), constant_values=np.nan)
        tr = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])))
        tr = np.pad(tr, (1, 0), constant_values=h[0]-l[0])
        atr = np.convolve(tr, np.ones(14)/14.0, mode='valid')
        atr = np.pad(atr, (13, 0), constant_values=np.nan)
        
        alpha200 = 2.0 / 201.0
        ema200 = np.zeros(n)
        ema200[0] = c[0]
        for t in range(1, n):
            ema200[t] = alpha200 * c[t] + (1.0 - alpha200) * ema200[t-1]
            
        for i in range(MACRO_LOOKBACK, n - 1):
            dt = dates[i]
            counts['2_total_candidate_bars'] += 1
            
            # Benchmark Gate
            if dt not in nifty_map or not nifty_map[dt]: continue
            counts['3_passed_nifty_bull_gate'] += 1
            
            # 200 EMA Gate
            if c[i] <= ema200[i]: continue
            counts['4_passed_stock_ema200_gate'] += 1
            
            ceil_40 = np.max(h[i-BASE_LOOKBACK : i])
            floor_40 = np.min(l[i-BASE_LOOKBACK : i])
            h_60 = np.max(h[i-MACRO_LOOKBACK : i])
            true_ceil = max(ceil_40, h_60)
            cur_atr = atr[i]
            if np.isnan(cur_atr) or cur_atr <= 0: continue
            
            base_depth = (true_ceil - floor_40) / true_ceil
            if not (MIN_BASE_DEPTH <= base_depth <= MAX_BASE_DEPTH): continue
            counts['5_passed_base_depth_4_to_18_pct'] += 1
            
            if c[i] <= ceil_40: continue
            counts['6_passed_close_gt_40d_ceil'] += 1
            
            if c[i] < true_ceil + PENETRATION_BUFFER_ATR * cur_atr: continue
            counts['7_passed_macro_60d_true_ceil'] += 1
            
            mid_base = floor_40 + 0.5 * (true_ceil - floor_40)
            if (np.sum(c[i-BASE_LOOKBACK : i] >= mid_base) / float(BASE_LOOKBACK)) < 0.40: continue
            counts['8_passed_base_symmetry_ge_40pct'] += 1
            
            ceil_bar_idx = np.argmax(h[i-MACRO_LOOKBACK : i])
            if (MACRO_LOOKBACK - ceil_bar_idx) < MIN_CEIL_AGE: continue
            counts['9_passed_ceil_age_ge_8bars'] += 1
            
            prior_20d_ret = (c[i] - c[i-20]) / c[i-20]
            if prior_20d_ret > MAX_PRIOR_20D_RUN: continue
            counts['10_passed_anti_runaway_20d_le_10pct'] += 1
            
            if np.sum(h[i-MACRO_LOOKBACK : i] >= true_ceil * 0.985) < MIN_TOUCHES: continue
            counts['11_passed_touches_ge_2'] += 1
            
            rng = max(h[i] - l[i], 1e-4)
            if c[i] <= o[i] or ((c[i] - o[i])/rng) < MIN_BODY_RATIO or ((c[i] - l[i])/rng) < MIN_CLOSE_LOC or ((h[i] - c[i])/rng) > MAX_UPPER_WICK: continue
            counts['12_passed_candle_shape'] += 1
            
            cur_vsma = v_sma[i]
            if np.isnan(cur_vsma) or cur_vsma <= 0: continue
            rvol = v[i] / cur_vsma
            if not (MIN_RVOL <= rvol <= MAX_RVOL): continue
            counts['13_passed_rvol_1_5_to_5_5'] += 1
            
            # --- NEW V5 GATES ---
            # 14. 52-Week High Proximity (Blue Sky)
            w52 = max(0, i - 250)
            high_52w = np.max(h[w52 : i])
            dist_52w = (c[i] - high_52w) / high_52w
            if dist_52w < MIN_DIST_52W: continue
            counts['14_passed_52w_proximity_blue_sky'] += 1
            
            # 15. Anti-Sprint (5d and 3d)
            prior_5d = (c[i] - c[max(0, i-5)]) / c[max(0, i-5)]
            prior_3d = (c[i] - c[max(0, i-3)]) / c[max(0, i-3)]
            if prior_5d > MAX_PRIOR_5D_RUN or prior_3d > MAX_PRIOR_3D_RUN: continue
            counts['15_passed_anti_sprint_5d_and_3d'] += 1
            
            # 16. Pre-Breakout Tightness / VCP
            pre_h3 = np.max(h[max(0, i-3) : i])
            pre_l3 = np.min(l[max(0, i-3) : i])
            if (pre_h3 - pre_l3) / pre_l3 > MAX_PRE_RANGE_3D: continue
            counts['16_passed_vcp_tightness_3d'] += 1
            
            # Signal generated!
            all_signals.append({
                'symbol': sym,
                'sig_date': dt,
                'entry_date': dates[i+1],
                'true_ceil': true_ceil,
                'sig_low': l[i],
                'sig_close': c[i],
                'next_open': o[i+1],
                'next_high': h[i+1],
                'next_low': l[i+1],
                'rvol': rvol
            })
            
    # Sort signals chronologically
    all_signals.sort(key=lambda s: (s['sig_date'], -s['rvol']))
    
    # 17. Stop-Limit Fill & Risk
    filled_signals = []
    for s in all_signals:
        ceil_p = s['true_ceil']
        limit_p = ceil_p * (1.0 + MAX_CHASE_PCT)
        bo = s['next_open']
        bh = s['next_high']
        
        filled = False
        fill_p = 0.0
        if bo > limit_p:
            filled = False
        elif bo >= ceil_p:
            filled = True
            fill_p = bo
        elif bo < ceil_p and bh >= ceil_p:
            filled = True
            fill_p = ceil_p
            
        if not filled: continue
        counts['17_passed_stop_limit_fill_rule'] += 1
        
        raw_stop = s['sig_low']
        risk_pct = (fill_p - raw_stop) / fill_p
        if not (MIN_RISK_PCT <= risk_pct <= MAX_RISK_PCT): continue
        counts['18_passed_risk_bounds'] += 1
        
        s['fill_p'] = fill_p
        s['eff_risk'] = risk_pct
        filled_signals.append(s)
        
    print("\n" + "="*80)
    print("      V5 ROBUST BREAKOUT ENGINE SIGNAL FUNNEL AUDIT")
    print("="*80)
    for k, v in counts.items():
        print(f"  {k:<45} : {v:>8,d}")
    print(f"  {'Total Valid Filled Signals':<45} : {len(filled_signals):>8,d}")
    print("="*80)

if __name__ == '__main__':
    run_funnel_audit()

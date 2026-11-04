"""
scripts/deep_research_all_patterns_fast.py
--------------------------------------------
Fast parallel quantitative research and multi-pattern backtest across 997 liquid NSE stocks.
"""

import os, json, math, time, glob
import numpy as np
import pandas as pd
from concurrent.futures import ProcessPoolExecutor

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = "data/ohlcv_3y/NIFTYBEES.json"
FRICTION_DECIMAL = 0.0028 # 0.28% round-trip delivery friction

def calculate_rsi(series, period=14):
    delta = pd.Series(series).diff()
    gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
    rs = gain / (loss + 1e-9)
    return (100 - (100 / (1 + rs))).values

def wilson_interval(wins, total, z=1.96):
    if total == 0: return (0.0, 0.0)
    p = wins / total
    denom = 1 + z**2 / total
    center = (p + z**2 / (2 * total)) / denom
    margin = z * math.sqrt((p * (1 - p) / total) + (z**2 / (4 * total**2))) / denom
    return (round(max(0.0, center - margin) * 100, 1), round(min(1.0, center + margin) * 100, 1))

def simulate_trade(entry_price, stop_price, target_price, highs, lows, closes, start_idx, max_hold=25):
    effective_entry = entry_price * (1.0 + FRICTION_DECIMAL / 2.0)
    n = len(closes)
    
    t1 = effective_entry * 1.050
    t2 = max(target_price, effective_entry * 1.090)
    cur_stop = stop_price
    t1_hit = False
    
    for k in range(start_idx, min(start_idx + max_hold, n)):
        h = highs[k]
        l = lows[k]
        c = closes[k]
        
        if l <= cur_stop:
            exit_p = min(cur_stop, c) * (1.0 - FRICTION_DECIMAL / 2.0)
            if t1_hit:
                pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
            else:
                pnl = (exit_p - effective_entry) / effective_entry
            return {'pnl': pnl, 'bars': k - start_idx + 1, 'exit_reason': 'STOP', 'win': pnl > 0}
            
        if not t1_hit and h >= t1:
            t1_hit = True
            cur_stop = max(cur_stop, effective_entry * 1.002)
            
        if t1_hit and h >= t2:
            exit_p = t2 * (1.0 - FRICTION_DECIMAL / 2.0)
            pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
            return {'pnl': pnl, 'bars': k - start_idx + 1, 'exit_reason': 'TARGET_FULL', 'win': True}
            
    exit_p = closes[min(start_idx + max_hold - 1, n - 1)] * (1.0 - FRICTION_DECIMAL / 2.0)
    if t1_hit:
        pnl = 0.5 * ((t1 - effective_entry) / effective_entry) + 0.5 * ((exit_p - effective_entry) / effective_entry)
    else:
        pnl = (exit_p - effective_entry) / effective_entry
    return {'pnl': pnl, 'bars': max_hold, 'exit_reason': 'TIME_EXIT', 'win': pnl > 0}

with open(NIFTY_PATH, 'r') as f:
    n_candles = json.load(f)['candles']
n_dates = [c[0][:10] for c in n_candles]
n_closes = np.array([float(c[4]) for c in n_candles])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def scan_symbol_file(f_path):
    sym = os.path.basename(f_path).replace('.json', '')
    try:
        with open(f_path, 'r') as fp:
            d = json.load(fp)
        candles = d.get('candles', [])
        if len(candles) < 220:
            return []

        dates = [c[0][:10] for c in candles]
        opens = np.array([float(c[1]) for c in candles])
        highs = np.array([float(c[2]) for c in candles])
        lows = np.array([float(c[3]) for c in candles])
        closes = np.array([float(c[4]) for c in candles])
        volumes = np.array([float(c[5]) for c in candles])
        n = len(dates)

        ema20 = pd.Series(closes).ewm(span=20).mean().values
        ema50 = pd.Series(closes).ewm(span=50).mean().values
        ema200 = pd.Series(closes).ewm(span=200).mean().values
        rsi14 = calculate_rsi(closes, 14)
        vol_sma20 = pd.Series(volumes).rolling(20).mean().values

        signals = []
        last_trade_idx = -999

        for i in range(85, n - 26):
            if i - last_trade_idx < 15:
                continue

            dt = dates[i]
            if dt not in n_map or not n_map[dt]['bull']:
                continue

            c_now = closes[i]
            v_now = volumes[i]
            avg_v = vol_sma20[i - 1]
            if np.isnan(avg_v) or avg_v <= 0 or v_now < avg_v * 1.35:
                continue

            # Stage 2 Trend Gate & Anti-Climax Gate
            if c_now < ema50[i] or ema20[i] < ema50[i]:
                continue
            if c_now > ema200[i] * 1.45: # Anti-Climax exhaustion filter
                continue

            # Relative Strength Gate (60-day outperformance >= +10% vs NIFTY)
            if i >= 60 and dt in n_map and dates[i-60] in n_map:
                s_ret = (c_now - closes[i-60]) / closes[i-60]
                n_ret = (n_map[dt]['close'] - n_map[dates[i-60]]['close']) / n_map[dates[i-60]]['close']
                if (s_ret - n_ret) * 100 < 10.0:
                    continue
            else:
                continue

            rsi_now = rsi14[i]
            if np.isnan(rsi_now) or rsi_now < 50 or rsi_now > 75:
                continue

            detected = None
            sl_price = None
            target_price = None

            # -------------------------------------------------------------
            # 1. CLASSIC CUP & HANDLE (Macro U-Shape + VDU Handle)
            # -------------------------------------------------------------
            for cup_len in [40, 55, 75]:
                for handle_len in [8, 14, 20]:
                    total_len = cup_len + handle_len
                    if i < total_len: continue
                    cup_start = i - total_len
                    cup_end = i - handle_len
                    
                    left_rim = np.max(highs[cup_start : cup_start + 12])
                    left_idx = cup_start + np.argmax(highs[cup_start : cup_start + 12])
                    
                    right_rim = np.max(highs[cup_end - 8 : cup_end + 1])
                    right_idx = cup_end - 8 + np.argmax(highs[cup_end - 8 : cup_end + 1])
                    
                    # Separation between left rim and right rim must be >= 25 days!
                    if right_idx - left_idx < 25: continue
                    
                    # Rim horizontal symmetry: within 2.5%
                    if abs(right_rim - left_rim) / left_rim > 0.025: continue
                    
                    rim = max(left_rim, right_rim)
                    
                    # Cup bottom
                    cup_slice = lows[left_idx : right_idx + 1]
                    if len(cup_slice) < 15: continue
                    cup_bot = np.min(cup_slice)
                    bot_local_idx = np.argmin(cup_slice)
                    bot_ratio = bot_local_idx / len(cup_slice)
                    
                    # Centered bottom: between 25% and 75%
                    if bot_ratio < 0.25 or bot_ratio > 0.75: continue
                    
                    depth = (rim - cup_bot) / rim
                    if depth < 0.10 or depth > 0.35: continue
                    
                    # Bottom roundness: spend >= 4 days in bottom 25% zone
                    bot_zone = cup_bot + 0.25 * (rim - cup_bot)
                    bot_days = np.sum(cup_slice <= bot_zone)
                    if bot_days < 4: continue
                    
                    # Handle: shallow pullback in upper half of cup
                    handle_lows = lows[cup_end : i]
                    handle_highs = highs[cup_end : i]
                    handle_bot = np.min(handle_lows)
                    h_depth = (rim - handle_bot) / rim
                    if h_depth < 0.025 or h_depth > depth * 0.45 or h_depth > 0.12: continue
                    
                    # Handle volume contraction
                    handle_vols = volumes[cup_end : i]
                    cup_vols = volumes[cup_start : cup_end]
                    if np.mean(handle_vols) > np.mean(cup_vols) * 1.05: continue
                    
                    # Breakout
                    if c_now > rim and closes[i-1] <= rim * 1.008:
                        detected = 'CUP_AND_HANDLE'
                        sl_price = max(handle_bot, c_now * 0.94)
                        target_price = c_now * (1.0 + depth * 0.70)
                        break
                if detected: break

            # -------------------------------------------------------------
            # 2. ASCENDING TRIANGLE (Horizontal Ceiling + Rising Swing Lows)
            # -------------------------------------------------------------
            if not detected and i >= 50:
                base_len = 45
                w_highs = highs[i - base_len : i]
                w_lows = lows[i - base_len : i]
                tri_ceil = np.max(w_highs)
                
                # Ceiling touches within 2.0%
                ceil_hits = [p for p in range(len(w_highs)) if w_highs[p] >= tri_ceil * 0.980]
                if len(ceil_hits) >= 2:
                    # Minimum 12 days between first and last ceiling touch
                    if ceil_hits[-1] - ceil_hits[0] >= 12:
                        # Clear pullback between touches
                        mid_trough = np.min(w_lows[ceil_hits[0] : ceil_hits[-1] + 1])
                        if (tri_ceil - mid_trough) / tri_ceil >= 0.035:
                            # Higher swing lows
                            first_half_low = np.min(w_lows[:22])
                            second_half_low = np.min(w_lows[22:])
                            if second_half_low >= first_half_low * 1.015:
                                if c_now > tri_ceil and closes[i-1] <= tri_ceil * 1.008:
                                    detected = 'ASCENDING_TRIANGLE'
                                    sl_price = max(second_half_low, c_now * 0.94)
                                    target_price = c_now * 1.10

            # -------------------------------------------------------------
            # 3. RECTANGLE CONSOLIDATION (Horizontal Range Box)
            # -------------------------------------------------------------
            if not detected and i >= 40:
                box_len = 35
                b_highs = highs[i - box_len : i]
                b_lows = lows[i - box_len : i]
                box_top = np.max(b_highs)
                box_bot = np.min(b_lows)
                box_height_pct = (box_top - box_bot) / box_bot * 100.0
                
                if 4.0 <= box_height_pct <= 12.0:
                    # At least 2 ceiling touches separated by >= 10 days
                    top_touches = [p for p in range(len(b_highs)) if b_highs[p] >= box_top * 0.985]
                    bot_touches = [p for p in range(len(b_lows)) if b_lows[p] <= box_bot * 1.015]
                    
                    if len(top_touches) >= 2 and len(bot_touches) >= 2:
                        if top_touches[-1] - top_touches[0] >= 10 and bot_touches[-1] - bot_touches[0] >= 10:
                            if c_now > box_top and closes[i-1] <= box_top * 1.008:
                                detected = 'RECTANGLE'
                                sl_price = max(box_bot, c_now * 0.945)
                                target_price = c_now + (box_top - box_bot)

            # -------------------------------------------------------------
            # 4. INVERSE HEAD & SHOULDERS (LS, Head, RS)
            # -------------------------------------------------------------
            if not detected and i >= 65:
                ihs_len = 60
                w = ihs_len // 3
                ls_slice = lows[i - ihs_len : i - ihs_len + w]
                head_slice = lows[i - ihs_len + w : i - w]
                rs_slice = lows[i - w : i]
                
                ls = np.min(ls_slice)
                head = np.min(head_slice)
                rs = np.min(rs_slice)
                
                # Head must be strictly lower than both shoulders by at least 2.5%
                if head < ls * 0.975 and head < rs * 0.975:
                    # Shoulders within 5% symmetry
                    if abs(rs - ls) / ls <= 0.05:
                        neckline = max(np.max(highs[i - ihs_len : i - ihs_len + w]), np.max(highs[i - w : i]))
                        if c_now > neckline and closes[i-1] <= neckline * 1.008:
                            detected = 'INVERSE_HS'
                            sl_price = max(rs, c_now * 0.94)
                            target_price = c_now + (neckline - head) * 0.75

            # -------------------------------------------------------------
            # 5. SYMMETRICAL TRIANGLE / BULLISH COIL
            # -------------------------------------------------------------
            if not detected and i >= 40:
                coil_len = 35
                c_highs = highs[i - coil_len : i]
                c_lows = lows[i - coil_len : i]
                
                h1 = np.max(c_highs[:18])
                h2 = np.max(c_highs[18:])
                l1 = np.min(c_lows[:18])
                l2 = np.min(c_lows[18:])
                
                # Higher low and flat/lower high (volatility contraction)
                if l2 >= l1 * 1.02 and h2 <= h1 * 1.005 and (h1 - l1) > (h2 - l2):
                    pivot_res = max(h1, h2)
                    if c_now > pivot_res and closes[i-1] <= pivot_res * 1.008:
                        detected = 'SYMMETRICAL_TRIANGLE'
                        sl_price = max(l2, c_now * 0.94)
                        target_price = c_now * 1.09

            if detected and sl_price is not None:
                # Ensure sensible stop distance (between 2.5% and 6.0%)
                stop_dist_pct = (c_now - sl_price) / c_now * 100.0
                if stop_dist_pct < 2.5:
                    sl_price = c_now * 0.965
                elif stop_dist_pct > 6.0:
                    sl_price = c_now * 0.940

                sim = simulate_trade(c_now, sl_price, target_price, highs, lows, closes, i + 1)
                signals.append({
                    'sym': sym,
                    'pattern': detected,
                    'date': dt,
                    'entry_price': round(float(c_now), 2),
                    'stop_price': round(float(sl_price), 2),
                    'risk_pct': round(float((c_now - sl_price) / c_now * 100), 2),
                    'pnl_pct': round(float(sim['pnl'] * 100), 2),
                    'win': bool(sim['win']),
                    'bars': int(sim['bars']),
                    'exit_reason': sim['exit_reason']
                })
                last_trade_idx = i

        return signals
    except Exception as e:
        return []

def main():
    print("=" * 90)
    print("  PARALLEL MULTI-PATTERN 3-YEAR RESEARCH & BACKTEST (997 STOCKS)")
    print("=" * 90)

    t0 = time.time()
    files = glob.glob(os.path.join(OHLCV_DIR, "*.json"))
    files = [f for f in files if "NIFTYBEES" not in f]
    print(f"Scanning {len(files)} stocks with 12 parallel CPU cores...")

    all_trades = []
    with ProcessPoolExecutor(max_workers=12) as executor:
        results = executor.map(scan_symbol_file, files)
        for res in results:
            all_trades.extend(res)

    print(f"Scan complete in {time.time() - t0:.2f}s! Total trades found: {len(all_trades)}")

    # Sort trades by date
    all_trades.sort(key=lambda x: x['date'])

    # Save to JSON
    with open('data/deep_research_all_patterns_trades.json', 'w') as fp:
        json.dump(all_trades, fp, indent=2)

    # Compute Overall Stats
    tot = len(all_trades)
    if tot == 0:
        print("No trades found!")
        return

    wins = [t for t in all_trades if t['win']]
    losses = [t for t in all_trades if not t['win']]
    wr = len(wins) / tot * 100.0
    w_low, w_high = wilson_interval(len(wins), tot)

    pnls = [t['pnl_pct'] for t in all_trades]
    gross_gains = sum(p for p in pnls if p > 0)
    gross_losses = abs(sum(p for p in pnls if p < 0))
    pf = (gross_gains / gross_losses) if gross_losses > 0 else 999.0
    avg_win = np.mean([p for p in pnls if p > 0]) if wins else 0
    avg_loss = np.mean([p for p in pnls if p < 0]) if losses else 0
    net_pnl = sum(pnls)

    print("\n" + "=" * 90)
    print(f"  OVERALL SYSTEM PERFORMANCE (3 YEARS: SEP 2023 - SEP 2026)")
    print("=" * 90)
    print(f"  Total Trades Executed : {tot} (~{tot/3:.0f} trades/year | ~{tot/150:.1f} trades/week)")
    print(f"  Win Rate              : {wr:.2f}%  (95% Wilson CI: [{w_low}%, {w_high}%])")
    print(f"  Profit Factor         : {pf:.2f}")
    print(f"  Average Winner        : +{avg_win:.2f}%")
    print(f"  Average Loser         : {avg_loss:.2f}%")
    print(f"  Win/Loss Payoff Ratio : {abs(avg_win / (avg_loss + 1e-9)):.2f}x")
    print(f"  Net Cumulative PnL    : {net_pnl:+.2f}%  (After 0.28% Zerodha Friction)")
    print("=" * 90)

    # Breakdown by Pattern
    patterns = sorted(list(set(t['pattern'] for t in all_trades)))
    print("\n" + "=" * 90)
    print(f"  {'Pattern Name':22s} | {'Trades':6s} | {'Win Rate':9s} | {'95% CI':14s} | {'PF':5s} | {'AvgWin%':7s} | {'AvgLoss%':8s} | {'NetPnL%':8s}")
    print("-" * 90)

    pat_summary = {}
    for p_name in patterns:
        p_trades = [t for t in all_trades if t['pattern'] == p_name]
        p_tot = len(p_trades)
        p_wins = [t for t in p_trades if t['win']]
        p_losses = [t for t in p_trades if not t['win']]
        p_wr = len(p_wins) / p_tot * 100.0
        p_low, p_high = wilson_interval(len(p_wins), p_tot)
        
        p_pnls = [t['pnl_pct'] for t in p_trades]
        p_gain = sum(x for x in p_pnls if x > 0)
        p_loss = abs(sum(x for x in p_pnls if x < 0))
        p_pf = (p_gain / p_loss) if p_loss > 0 else 999.0
        p_avg_win = np.mean([x for x in p_pnls if x > 0]) if p_wins else 0
        p_avg_loss = np.mean([x for x in p_pnls if x < 0]) if p_losses else 0
        p_net = sum(p_pnls)

        pat_summary[p_name] = {
            'trades': p_tot,
            'win_rate': round(p_wr, 2),
            'ci_low': p_low,
            'ci_high': p_high,
            'pf': round(p_pf, 2),
            'avg_win': round(float(p_avg_win), 2),
            'avg_loss': round(float(p_avg_loss), 2),
            'net_pnl': round(float(p_net), 2)
        }

        print(f"  {p_name:22s} | {p_tot:6d} | {p_wr:7.2f}% | [{p_low}%, {p_high}%] | {p_pf:5.2f} | +{p_avg_win:5.2f}% | {p_avg_loss:6.2f}% | {p_net:+7.1f}%")
    print("=" * 90)

    with open('data/deep_research_pattern_summary.json', 'w') as fp:
        json.dump(pat_summary, fp, indent=2)

if __name__ == "__main__":
    main()

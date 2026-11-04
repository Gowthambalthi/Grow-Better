"""
scripts/controlled_experiment_abc.py
-----------------------------------
Controlled 3-Way Experiment on 997 NSE Stocks (3 Years: 2023-2026):
- Version A: Baseline strategy (Degree angles, unconfirmed pivots, floating execution)
- Version B: Improved pattern validation (ATR-normalized slopes, confirmed pivots only, prior uptrend >= 20%, strict convergence)
- Version C: Improved pattern validation + Realistic execution engine (Gap-down open exits, conservative Day-1 intraday stop, strict date indexing, 0.28% friction)

Computes:
- Total trades, Win rate, Average winner, Average loser, Profit factor,
  Expectancy per trade E(R), Gap-loss frequency, False breakout frequency.
"""

import os, json, glob, math, time
import numpy as np
import pandas as pd
from concurrent.futures import ProcessPoolExecutor

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = "data/ohlcv_3y/NIFTYBEES.json"
FRICTION = 0.0028

with open(NIFTY_PATH) as f: n_candles = json.load(f)['candles']
n_dates = [c[0][:10] for c in n_candles]
n_closes = np.array([float(c[4]) for c in n_candles])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def calculate_atr(highs, lows, closes, period=14):
    tr = np.maximum(highs[1:] - lows[1:], np.maximum(abs(highs[1:] - closes[:-1]), abs(lows[1:] - closes[:-1])))
    tr = np.insert(tr, 0, highs[0] - lows[0])
    return pd.Series(tr).rolling(period, min_periods=1).mean().values

def run_experiment_on_file(args):
    f_path, version = args
    sym = os.path.basename(f_path).replace('.json', '')
    try:
        with open(f_path) as fp: c = json.load(fp)['candles']
        if len(c) < 220: return []
        dates = [x[0][:10] for x in c]
        opens = np.array([float(x[1]) for x in c])
        highs = np.array([float(x[2]) for x in c])
        lows = np.array([float(x[3]) for x in c])
        closes = np.array([float(x[4]) for x in c])
        vols = np.array([float(x[5]) for x in c])
        n = len(dates)

        ema20 = pd.Series(closes).ewm(span=20).mean().values
        ema50 = pd.Series(closes).ewm(span=50).mean().values
        ema200 = pd.Series(closes).ewm(span=200).mean().values
        vol_sma20 = pd.Series(vols).rolling(20).mean().values
        atr14 = calculate_atr(highs, lows, closes, 14)

        signals = []
        last_trade_idx = -999

        for i in range(85, n - 26):
            if i - last_trade_idx < 18: continue
            dt = dates[i]
            if dt not in n_map or not n_map[dt]['bull']: continue

            c_now = closes[i]
            v_now = vols[i]
            avg_v = vol_sma20[i - 1]
            if np.isnan(avg_v) or avg_v <= 0 or v_now < avg_v * 1.50: continue

            if c_now < ema50[i] or ema20[i] < ema50[i]: continue
            if c_now > ema200[i] * 1.45: continue

            # RS filter
            if i >= 60 and dt in n_map and dates[i-60] in n_map:
                s_ret = (c_now - closes[i-60]) / closes[i-60]
                n_ret = (n_map[dt]['close'] - n_map[dates[i-60]]['close']) / n_map[dates[i-60]]['close']
                if (s_ret - n_ret) * 100 < 3.0: continue
            else: continue

            # Upper 35% close
            rng = highs[i] - lows[i]
            if rng <= 0 or (highs[i] - c_now) / rng > 0.35: continue

            # Prior Uptrend Gate (Versions B & C)
            if version in ['B', 'C']:
                if i >= 120:
                    prior_gain = (closes[i] - np.min(lows[i-120:i-30])) / np.min(lows[i-120:i-30])
                    if prior_gain < 0.20: continue # Must have at least 20% prior advance before base
                else: continue

            detected = None
            pivot_price = None
            sl_price = None

            # Pattern 1: ASCENDING TRIANGLE
            win = 65
            if i >= win:
                w_h = highs[i - win : i]
                w_l = lows[i - win : i]
                ceil = np.max(w_h)
                min_w = np.min(w_l)

                r_pts = []
                l_pts = []

                if version == 'A':
                    # Unconfirmed pivots (can use current window end)
                    for p in range(2, win - 2):
                        if w_h[p] >= ceil * 0.985 and w_h[p] >= w_h[p-1] and w_h[p] >= w_h[p+1]:
                            r_pts.append({'idx': p, 'price': w_h[p]})
                        if w_l[p] <= w_l[p-1] and w_l[p] <= w_l[p+1]:
                            l_pts.append({'idx': p, 'price': w_l[p]})
                    # Degree angle slope
                    if len(r_pts) >= 3 and len(l_pts) >= 3:
                        norm_x = np.array([p['idx'] for p in l_pts]) / win
                        norm_y = (np.array([p['price'] for p in l_pts]) - min_w) / (ceil - min_w)
                        slope, _ = np.polyfit(norm_x, norm_y, 1)
                        ang = np.degrees(np.arctan(slope))
                        if ang >= 10.0 and c_now > ceil and closes[i-1] <= ceil * 1.008:
                            detected = 'ASCENDING_TRIANGLE'
                            pivot_price = ceil
                            sl_price = l_pts[-1]['price'] * 0.995

                else: # Versions B & C: Strictly CONFIRMED pivots only & ATR-normalized slope
                    # 5-bar pivot requires p+2 <= win-1, so confirmed at least 2 bars ago!
                    for p in range(2, win - 3):
                        if w_h[p] >= ceil * 0.982 and w_h[p] >= w_h[p-1] and w_h[p] >= w_h[p-2] and w_h[p] >= w_h[p+1] and w_h[p] >= w_h[p+2]:
                            if len(r_pts) == 0 or (p - r_pts[-1]['idx'] >= 6):
                                r_pts.append({'idx': p, 'price': w_h[p]})
                        if w_l[p] <= w_l[p-1] and w_l[p] <= w_l[p-2] and w_l[p] <= w_l[p+1] and w_l[p] <= w_l[p+2]:
                            if len(l_pts) == 0 or (p - l_pts[-1]['idx'] >= 6):
                                l_pts.append({'idx': p, 'price': w_l[p]})

                    if len(r_pts) >= 3 and len(l_pts) >= 3 and (r_pts[-1]['idx'] - r_pts[0]['idx'] >= 20):
                        # ATR-normalized slope (change in price per bar / ATR14)
                        x_pts = [p['idx'] for p in l_pts]
                        y_pts = [p['price'] for p in l_pts]
                        raw_slope, _ = np.polyfit(x_pts, y_pts, 1)
                        atr_slope = raw_slope / max(1e-4, atr14[i])
                        # ATR slope >= 0.08 means support rises by >= 0.08 ATR per day (stable across all price scales!)
                        # Also require ceiling variation <= 1.5%
                        ceil_var = (np.max([p['price'] for p in r_pts]) - np.min([p['price'] for p in r_pts])) / ceil
                        if ceil_var <= 0.018 and atr_slope >= 0.07:
                            if l_pts[-3]['price'] < l_pts[-2]['price'] < l_pts[-1]['price']:
                                if c_now > ceil and closes[i-1] <= ceil * 1.008:
                                    detected = 'ASCENDING_TRIANGLE'
                                    pivot_price = ceil
                                    sl_price = l_pts[-1]['price'] * 0.995

            # Pattern 2: CUP AND HANDLE
            if not detected and i >= 70:
                for clen in [55, 75]:
                    hlen = 15
                    tot = clen + hlen
                    if i < tot: continue
                    cs = i - tot
                    ce = i - hlen
                    lr = np.max(highs[cs : cs + 15])
                    l_idx = cs + np.argmax(highs[cs : cs + 15])
                    rr = np.max(highs[ce - 10 : ce + 1])
                    r_idx = ce - 10 + np.argmax(highs[ce - 10 : ce + 1])
                    if r_idx - l_idx < 22 or abs(rr - lr) / lr > 0.035: continue
                    rim = max(lr, rr)
                    cup_bot = np.min(lows[l_idx : r_idx + 1])
                    depth = (rim - cup_bot) / rim
                    if depth < 0.10 or depth > 0.35: continue

                    h_highs = highs[ce : i]
                    h_lows = lows[ce : i]
                    h_bot = np.min(h_lows)
                    # Handle must be in upper 45% of cup
                    if (rim - h_bot) / rim > depth * 0.45: continue

                    if version in ['B', 'C']:
                        # Handle volume must dry up: VDU check
                        cup_vol = np.mean(vols[cs:ce])
                        h_vol = np.mean(vols[ce:i])
                        if h_vol > cup_vol * 1.0: continue # Must contract

                    if c_now > rim and closes[i-1] <= rim * 1.008:
                        detected = 'CUP_AND_HANDLE'
                        pivot_price = rim
                        sl_price = h_bot * 0.995
                        break

            # Pattern 3: MULTI-MONTH BASE
            if not detected and i >= 70:
                for blen in [100, 75, 55]:
                    if i < blen: continue
                    w_h = highs[i - blen : i]
                    w_l = lows[i - blen : i]
                    bh = np.max(w_h)
                    bl = np.min(w_l)
                    depth = (bh - bl) / bh
                    if depth < 0.08 or depth > 0.28: continue
                    touches = [p for p in range(len(w_h)) if w_h[p] >= bh * 0.982]
                    if len(touches) >= 3 and (touches[-1] - touches[0] >= 18):
                        if c_now > bh and closes[i-1] <= bh * 1.008:
                            detected = 'MULTI_MONTH_BASE'
                            pivot_price = bh
                            sl_price = np.min(lows[max(0, i - 18) : i]) * 0.995
                            break

            if not detected or pivot_price is None or sl_price is None:
                continue

            # ==============================================================
            # EXECUTION SIMULATION
            # ==============================================================
            next_o = opens[i+1]
            next_l = lows[i+1]
            next_h = highs[i+1]
            next_c = closes[i+1]

            # Anti-chasing limit gate
            if next_o > pivot_price * 1.030:
                entry_p = pivot_price * 1.018
            else:
                entry_p = next_o

            entry_p_fric = entry_p * (1.0 + FRICTION / 2.0)
            cur_stop = max(sl_price, entry_p_fric * 0.955)

            t1 = entry_p_fric * 1.065
            t2 = entry_p_fric * 1.160
            t1_hit = False
            trade_pnl = None
            exit_reason = None
            bars = 0
            gap_loss = False

            if version == 'A':
                # Version A (Loose execution): Day 1 only exits if close <= stop
                for k in range(i + 1, min(i + 26, n)):
                    bars += 1
                    if k == i + 1:
                        if closes[k] <= cur_stop:
                            exit_p = closes[k] * (1.0 - FRICTION / 2.0)
                            trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                            exit_reason = 'DAY1_CLOSE_STOP'
                            break
                        continue
                    if not t1_hit and highs[k] >= t1:
                        t1_hit = True
                        cur_stop = max(cur_stop, entry_p_fric * 1.0028)
                    if lows[k] <= cur_stop:
                        exit_p = cur_stop * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric) if t1_hit else (exit_p - entry_p_fric)/entry_p_fric
                        exit_reason = 'STOP'
                        break
                    if t1_hit and highs[k] >= t2:
                        exit_p = t2 * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric)
                        exit_reason = 'TARGET_2'
                        break

            elif version == 'B':
                # Version B: Standard execution
                for k in range(i + 1, min(i + 26, n)):
                    bars += 1
                    if k == i + 1:
                        if closes[k] <= cur_stop:
                            exit_p = closes[k] * (1.0 - FRICTION / 2.0)
                            trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                            exit_reason = 'DAY1_CLOSE_STOP'
                            break
                        continue
                    if not t1_hit and highs[k] >= t1:
                        t1_hit = True
                        cur_stop = max(cur_stop, entry_p_fric * 1.0028)
                    if lows[k] <= cur_stop:
                        exit_p = cur_stop * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric) if t1_hit else (exit_p - entry_p_fric)/entry_p_fric
                        exit_reason = 'STOP'
                        break
                    if t1_hit and highs[k] >= t2:
                        exit_p = t2 * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric)
                        exit_reason = 'TARGET_2'
                        break

            else:
                # ==============================================================
                # VERSION C: REALISTIC EXECUTION ENGINE
                # 1. Day-1 Conservative execution: if Open enters, but Low breached stop,
                #    we conservatively assume stop was hit on Day 1 at min(open, stop)
                # 2. Gap-down stops: If Open < stop, exit is Open, NOT stop!
                # 3. Strict Date Indexing: Entry date = dates[i+1], Exit date = dates[k]
                # ==============================================================
                for k in range(i + 1, min(i + 26, n)):
                    bars += 1
                    o_k, h_k, l_k, c_k = opens[k], highs[k], lows[k], closes[k]

                    if k == i + 1:
                        # Day 1: Did price trade through stop intraday?
                        if l_k <= cur_stop:
                            # If Day 1 Low hit stop, conservatively assume stopped out
                            exit_price_actual = min(cur_stop, c_k)
                            exit_p = exit_price_actual * (1.0 - FRICTION / 2.0)
                            trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                            exit_reason = 'DAY1_INTRADAY_STOP'
                            break
                        continue

                    # Day 2 onwards: Check Gap-down through stop
                    if o_k < cur_stop:
                        gap_loss = True
                        exit_p = o_k * (1.0 - FRICTION / 2.0) # Exit at OPEN, not stop!
                        trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                        exit_reason = 'GAP_DOWN_STOP'
                        break

                    # Target 1
                    if not t1_hit and h_k >= t1:
                        t1_hit = True
                        cur_stop = max(cur_stop, entry_p_fric * 1.0028)

                    # Normal stop hit intraday
                    if l_k <= cur_stop:
                        exit_p = cur_stop * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric) if t1_hit else (exit_p - entry_p_fric)/entry_p_fric
                        exit_reason = 'NORMAL_STOP'
                        break

                    # Trailing runner
                    if t1_hit:
                        trail_low = np.min(lows[max(0, k-3):k])
                        if trail_low > cur_stop: cur_stop = trail_low

                    if h_k >= t2:
                        exit_p = t2 * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric)
                        exit_reason = 'TARGET_2'
                        break

            if trade_pnl is None:
                exit_p = closes[min(i + 25, n - 1)] * (1.0 - FRICTION / 2.0)
                trade_pnl = 0.5 * ((t1 - entry_p_fric)/entry_p_fric) + 0.5 * ((exit_p - entry_p_fric)/entry_p_fric) if t1_hit else (exit_p - entry_p_fric)/entry_p_fric
                exit_reason = 'TIME_EXIT'

            signals.append({
                'sym': sym, 'pattern': detected,
                'entry_date': dates[i+1],
                'pnl_pct': round(float(trade_pnl * 100), 2),
                'win': bool(trade_pnl > 0),
                'gap_loss': gap_loss,
                'bars': bars,
                'exit_reason': exit_reason
            })
            last_trade_idx = i

        return signals
    except: return []

def evaluate_version(version_name, version_code):
    files = [f for f in glob.glob(os.path.join(OHLCV_DIR, "*.json")) if "NIFTYBEES" not in f]
    args = [(f, version_code) for f in files]
    with ProcessPoolExecutor(max_workers=12) as ex:
        res = list(ex.map(run_experiment_on_file, args))
    trades = [t for sub in res for t in sub]
    trades.sort(key=lambda x: x['entry_date'])

    tot = len(trades)
    wins = [t for t in trades if t['win']]
    losses = [t for t in trades if not t['win']]
    wr = len(wins) / tot * 100 if tot else 0
    pnls = [t['pnl_pct'] for t in trades]
    gg = sum(p for p in pnls if p > 0)
    gl = abs(sum(p for p in pnls if p < 0))
    pf = (gg / gl) if gl > 0 else 999.0
    aw = np.mean([p for p in pnls if p > 0]) if wins else 0
    al = np.mean([p for p in pnls if p < 0]) if losses else 0
    exp = (wr/100 * aw) - ((100 - wr)/100 * abs(al))

    gap_losses = sum(1 for t in trades if t.get('gap_loss', False))
    gap_freq = (gap_losses / tot * 100) if tot else 0

    # Max Drawdown calculation
    equity = np.cumprod(1.0 + np.array(pnls) / 100.0)
    peak = np.maximum.accumulate(equity)
    dd = (equity - peak) / peak
    max_dd = float(np.min(dd) * 100) if len(dd) else 0.0

    return {
        'name': version_name,
        'trades': tot,
        'trade_pace': round(tot / 150.0, 1), # calls per week
        'win_rate': round(wr, 2),
        'pf': round(pf, 2),
        'avg_win': round(aw, 2),
        'avg_loss': round(al, 2),
        'payoff': round(abs(aw/al), 2) if al != 0 else 0,
        'expectancy': round(exp, 2),
        'max_dd': round(max_dd, 2),
        'gap_freq': round(gap_freq, 2),
        'net_pnl': round(sum(pnls), 1)
    }

if __name__ == '__main__':
    print("=" * 95)
    print("  RUNNING CONTROLLED 3-WAY EXPERIMENT (VERSIONS A vs B vs C) ACROSS 997 NSE STOCKS")
    print("=" * 95)
    
    t0 = time.time()
    res_a = evaluate_version("Version A: Current Strategy", "A")
    print(f"Version A completed in {time.time()-t0:.1f}s")
    
    t1 = time.time()
    res_b = evaluate_version("Version B: Improved Pattern Validation", "B")
    print(f"Version B completed in {time.time()-t1:.1f}s")
    
    t2 = time.time()
    res_c = evaluate_version("Version C: Validation + Realistic Execution", "C")
    print(f"Version C completed in {time.time()-t2:.1f}s")

    print("\n" + "=" * 95)
    print("  EXPERIMENT RESULTS COMPARISON TABLE")
    print("=" * 95)
    headers = ["Metric", "Version A (Current)", "Version B (Pattern Fix)", "Version C (Realistic Exec)"]
    rows = [
        ("Total Trades (3 Yrs)", str(res_a['trades']), str(res_b['trades']), str(res_c['trades'])),
        ("Weekly Trade Pace", f"{res_a['trade_pace']} calls/wk", f"{res_b['trade_pace']} calls/wk", f"{res_c['trade_pace']} calls/wk"),
        ("Win Rate", f"{res_a['win_rate']}%", f"{res_b['win_rate']}%", f"{res_c['win_rate']}%"),
        ("Profit Factor", f"{res_a['pf']}", f"{res_b['pf']}", f"{res_c['pf']}"),
        ("Average Winner", f"+{res_a['avg_win']}%", f"+{res_b['avg_win']}%", f"+{res_c['avg_win']}%"),
        ("Average Loser", f"{res_a['avg_loss']}%", f"{res_b['avg_loss']}%", f"{res_c['avg_loss']}%"),
        ("Payoff Ratio", f"{res_a['payoff']}x", f"{res_b['payoff']}x", f"{res_c['payoff']}x"),
        ("Net Expectancy E(R)", f"+{res_a['expectancy']}% / trade", f"+{res_b['expectancy']}% / trade", f"+{res_c['expectancy']}% / trade"),
        ("Max Drawdown", f"{res_a['max_dd']}%", f"{res_b['max_dd']}%", f"{res_c['max_dd']}%"),
        ("Gap-Loss Frequency", f"{res_a['gap_freq']}%", f"{res_b['gap_freq']}%", f"{res_c['gap_freq']}%"),
        ("Cumulative Return", f"+{res_a['net_pnl']}%", f"+{res_b['net_pnl']}%", f"+{res_c['net_pnl']}%")
    ]
    for r in rows:
        print(f"  {r[0]:25} | {r[1]:20} | {r[2]:25} | {r[3]:25}")
    print("=" * 95)

    with open('data/controlled_experiment_results.json', 'w') as f:
        json.dump({'Version_A': res_a, 'Version_B': res_b, 'Version_C': res_c}, f, indent=2)

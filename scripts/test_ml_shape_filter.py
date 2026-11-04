"""
scripts/test_ml_shape_filter.py
--------------------------------
Deep Machine Learning Evaluation for Chart Pattern Classification & Filtering:
1. Ingests all historical pattern breakout setups across 997 NSE stocks (2023-2026).
2. Extracts high-dimensional shape & price-action features:
   - Geometric: Base depth %, Base length, Support angle, Resistance angle, Convergence ratio
   - Momentum: RSI(14), RS vs NIFTY(60d), Distance to 20/50/200 EMA
   - Volume: Breakout volume surge, Pre-breakout 5-day volume contraction (VDU)
   - Candlestick anatomy: Body %, Upper wick %, Lower wick %
3. Strict Train / Test Split:
   - In-Sample (Train): 2023-09 to 2025-04 (~70% of data)
   - Out-of-Sample (Holdout): 2025-04 to 2026-09 (~30% of data)
4. Trains Scikit-Learn / Gradient Boosting & Random Forest classifiers.
5. Verifies if ML improves Out-of-Sample Win Rate, Expectancy, and Profit Factor.
"""

import os, json, glob, math, time
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import classification_report, accuracy_score, precision_score
from concurrent.futures import ProcessPoolExecutor

OHLCV_DIR = "data/ohlcv_3y"
NIFTY_PATH = "data/ohlcv_3y/NIFTYBEES.json"
FRICTION = 0.0028

with open(NIFTY_PATH) as f: n_candles = json.load(f)['candles']
n_dates = [c[0][:10] for c in n_candles]
n_closes = np.array([float(c[4]) for c in n_candles])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def calculate_angle(x_pts, y_pts, total_bars, min_p, max_p):
    if len(x_pts) < 2 or max_p <= min_p or total_bars <= 0: return 0.0
    norm_x = np.array(x_pts) / total_bars
    norm_y = (np.array(y_pts) - min_p) / (max_p - min_p)
    slope, _ = np.polyfit(norm_x, norm_y, 1)
    return float(np.degrees(np.arctan(slope)))

def extract_features_and_trades(f_path):
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

        records = []
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

            # RS
            if i >= 60 and dt in n_map and dates[i-60] in n_map:
                s_ret = (c_now - closes[i-60]) / closes[i-60]
                n_ret = (n_map[dt]['close'] - n_map[dates[i-60]]['close']) / n_map[dates[i-60]]['close']
                rs_val = (s_ret - n_ret) * 100
                if rs_val < 3.0: continue
            else: continue

            rng = highs[i] - lows[i]
            if rng <= 0 or (highs[i] - c_now) / rng > 0.35: continue

            # Pattern detection
            detected = None
            pivot_price = None
            sl_price = None
            base_len = 0
            depth_pct = 0.0
            ang_res = 0.0
            ang_sup = 0.0

            # 1. Multi-Month Base
            for blen in [100, 75, 55, 35]:
                if i < blen: continue
                w_h = highs[i - blen : i]
                w_l = lows[i - blen : i]
                bh = np.max(w_h)
                bl = np.min(w_l)
                d = (bh - bl) / bh
                if d < 0.07 or d > 0.30: continue
                touches = [p for p in range(len(w_h)) if w_h[p] >= bh * 0.980]
                if len(touches) >= 2 and (touches[-1] - touches[0] >= 12):
                    if c_now > bh and closes[i-1] <= bh * 1.008:
                        detected = 'MULTI_MONTH_BASE'
                        pivot_price = bh
                        sl_price = np.min(lows[max(0, i - 20) : i]) * 0.995
                        base_len = blen
                        depth_pct = d * 100
                        break

            # 2. Cup & Handle
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
                    if r_idx - l_idx < 22 or abs(rr - lr) / lr > 0.038: continue
                    rim = max(lr, rr)
                    cup_bot = np.min(lows[l_idx : r_idx + 1])
                    d = (rim - cup_bot) / rim
                    if d < 0.10 or d > 0.35: continue
                    h_highs = highs[ce : i]
                    h_bot = np.min(lows[ce : i])
                    if (rim - h_bot) / rim > d * 0.48: continue
                    ang_h = calculate_angle(list(range(len(h_highs))), h_highs, hlen, h_bot, rim)
                    if ang_h <= 2.5:
                        if c_now > rim and closes[i-1] <= rim * 1.008:
                            detected = 'CUP_AND_HANDLE'
                            pivot_price = rim
                            sl_price = h_bot * 0.995
                            base_len = tot
                            depth_pct = d * 100
                            ang_res = ang_h
                            break

            if detected and pivot_price is not None and sl_price is not None:
                next_o = opens[i+1]
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

                for k in range(i + 1, min(i + 26, n)):
                    h = highs[k]
                    l = lows[k]
                    c = closes[k]

                    if k == i + 1:
                        if c <= cur_stop:
                            exit_p = c * (1.0 - FRICTION / 2.0)
                            trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                            break
                        continue

                    if not t1_hit and h >= t1:
                        t1_hit = True
                        cur_stop = max(cur_stop, entry_p_fric * 1.0028)

                    if l <= cur_stop:
                        exit_p = cur_stop * (1.0 - FRICTION / 2.0)
                        if t1_hit:
                            trade_pnl = 0.5 * ((t1 - entry_p_fric) / entry_p_fric) + 0.5 * ((exit_p - entry_p_fric) / entry_p_fric)
                        else:
                            trade_pnl = (exit_p - entry_p_fric) / entry_p_fric
                        break

                    if t1_hit:
                        trail_low = np.min(lows[max(0, k - 3) : k])
                        if trail_low > cur_stop: cur_stop = trail_low

                    if h >= t2:
                        exit_p = t2 * (1.0 - FRICTION / 2.0)
                        trade_pnl = 0.5 * ((t1 - entry_p_fric) / entry_p_fric) + 0.5 * ((exit_p - entry_p_fric) / entry_p_fric)
                        break

                if trade_pnl is None:
                    exit_p = closes[min(i + 25, n - 1)] * (1.0 - FRICTION / 2.0)
                    if t1_hit:
                        trade_pnl = 0.5 * ((t1 - entry_p_fric) / entry_p_fric) + 0.5 * ((exit_p - entry_p_fric) / entry_p_fric)
                    else:
                        trade_pnl = (exit_p - entry_p_fric) / entry_p_fric

                # Feature Extraction
                vol_surge = v_now / avg_v
                vdu_5d = np.mean(vols[i-5:i]) / avg_v if i >= 5 else 1.0
                body_pct = abs(c_now - opens[i]) / rng
                upper_wick = (highs[i] - max(c_now, opens[i])) / rng
                lower_wick = (min(c_now, opens[i]) - lows[i]) / rng
                dist_ema20 = (c_now - ema20[i]) / ema20[i] * 100
                dist_ema50 = (c_now - ema50[i]) / ema50[i] * 100
                dist_ema200 = (c_now - ema200[i]) / ema200[i] * 100

                records.append({
                    'sym': sym,
                    'date': dates[i+1],
                    'pattern': detected,
                    'features': [
                        base_len, depth_pct, vol_surge, vdu_5d,
                        body_pct, upper_wick, lower_wick,
                        dist_ema20, dist_ema50, dist_ema200, rs_val
                    ],
                    'pnl_pct': float(trade_pnl * 100),
                    'win': int(trade_pnl > 0)
                })
                last_trade_idx = i

        return records
    except: return []

def main():
    print("=" * 80)
    print("  MACHINE LEARNING / DEEP CLASSIFICATION EVALUATION ON CHART PATTERNS")
    print("=" * 80)
    files = [f for f in glob.glob(os.path.join(OHLCV_DIR, "*.json")) if "NIFTYBEES" not in f]
    print(f"Extracting features across all {len(files)} NSE stock files...")

    with ProcessPoolExecutor(max_workers=12) as ex:
        res = list(ex.map(extract_features_and_trades, files))

    trades = [t for sub in res for t in sub]
    trades.sort(key=lambda x: x['date'])
    print(f"Total pattern instances extracted: {len(trades)}")

    # Split: Train (< 2025-04-01) vs Test (>= 2025-04-01)
    train_trades = [t for t in trades if t['date'] < '2025-04-01']
    test_trades = [t for t in trades if t['date'] >= '2025-04-01']

    X_train = np.array([t['features'] for t in train_trades])
    y_train = np.array([t['win'] for t in train_trades])
    X_test = np.array([t['features'] for t in test_trades])
    y_test = np.array([t['win'] for t in test_trades])

    print(f"In-Sample (Train) Trades   : {len(train_trades)}")
    print(f"Out-of-Sample (Test) Trades: {len(test_trades)}")

    # Baseline Out-of-Sample Performance (Without ML)
    base_wins = sum(y_test)
    base_wr = base_wins / len(y_test) * 100.0
    base_pnls = [t['pnl_pct'] for t in test_trades]
    base_gg = sum(p for p in base_pnls if p > 0)
    base_gl = abs(sum(p for p in base_pnls if p < 0))
    base_pf = (base_gg / base_gl) if base_gl > 0 else 999.0
    base_aw = np.mean([p for p in base_pnls if p > 0])
    base_al = np.mean([p for p in base_pnls if p < 0])
    base_exp = (base_wr/100 * base_aw) - ((100 - base_wr)/100 * abs(base_al))

    print("\n" + "-" * 80)
    print("  BASELINE (NO ML) OUT-OF-SAMPLE PERFORMANCE:")
    print("-" * 80)
    print(f"  Trades: {len(test_trades)} | Win Rate: {base_wr:.2f}% | Profit Factor: {base_pf:.2f}")
    print(f"  Avg Win: +{base_aw:.2f}% | Avg Loss: {base_al:.2f}% | Expectancy: +{base_exp:.2f}%/trade")

    # 1. Gradient Boosting Classifier
    gb = GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.05, random_state=42)
    gb.fit(X_train, y_train)
    gb_preds_proba = gb.predict_proba(X_test)[:, 1]

    # Evaluate ML thresholds (Conf >= 0.50, 0.55, 0.60)
    print("\n" + "-" * 80)
    print("  MACHINE LEARNING (GRADIENT BOOSTING) OUT-OF-SAMPLE RESULTS:")
    print("-" * 80)
    feature_names = [
        'base_len', 'depth_pct', 'vol_surge', 'vdu_5d',
        'body_pct', 'upper_wick', 'lower_wick',
        'dist_ema20', 'dist_ema50', 'dist_ema200', 'rs_val'
    ]
    imp = gb.feature_importances_
    print("Top Feature Importances from ML Model:")
    for f_idx in np.argsort(imp)[::-1][:5]:
        print(f"  - {feature_names[f_idx]}: {imp[f_idx]*100:.1f}%")

    for thresh in [0.50, 0.53, 0.56]:
        ml_indices = [idx for idx, prob in enumerate(gb_preds_proba) if prob >= thresh]
        if len(ml_indices) == 0: continue
        ml_trades = [test_trades[idx] for idx in ml_indices]
        ml_wins = [t for t in ml_trades if t['win'] == 1]
        ml_wr = len(ml_wins) / len(ml_trades) * 100.0
        ml_pnls = [t['pnl_pct'] for t in ml_trades]
        ml_gg = sum(p for p in ml_pnls if p > 0)
        ml_gl = abs(sum(p for p in ml_pnls if p < 0))
        ml_pf = (ml_gg / ml_gl) if ml_gl > 0 else 999.0
        ml_aw = np.mean([p for p in ml_pnls if p > 0]) if ml_wins else 0
        ml_al = np.mean([p for p in ml_pnls if p < 0]) if (len(ml_trades) - len(ml_wins)) else 0
        ml_exp = (ml_wr/100 * ml_aw) - ((100 - ml_wr)/100 * abs(ml_al))
        print(f"\nML Filter (Probability >= {thresh:.2f}):")
        print(f"  Trades Picked : {len(ml_trades)} (Filtered out {len(test_trades) - len(ml_trades)} low-confidence trades)")
        print(f"  Win Rate      : {ml_wr:.2f}% (vs Baseline {base_wr:.2f}%)")
        print(f"  Profit Factor : {ml_pf:.2f} (vs Baseline {base_pf:.2f})")
        print(f"  Avg Win       : +{ml_aw:.2f}% | Avg Loss: {ml_al:.2f}%")
        print(f"  Expectancy    : +{ml_exp:.2f}%/trade (vs Baseline +{base_exp:.2f}%/trade)")
        print(f"  Net PnL       : +{sum(ml_pnls):.1f}%")

if __name__ == '__main__':
    main()

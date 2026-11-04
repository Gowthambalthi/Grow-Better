"""
strategies/mine/train_ml_filter.py
----------------------------------
Authoritative Machine Learning Training & Reproducibility Pipeline.

AUDIT SPECIFICATION:
1. Target Label Construction:
   - Binary Target: y = 1 if Net Realized PnL > 0 (after 0.28% Zerodha friction), y = 0 otherwise.
2. Feature Generation:
   - 11 normalized price-action, volume, and geometric variables computed strictly at signal bar i.
   - Zero look-ahead: all features are known before entry at bar i+1 Open.
3. Train / Test Split:
   - In-Sample (Train): Historical trades before 2025-04-01 (~60% of data)
   - Out-of-Sample (Holdout): Unseen trades from 2025-04-01 to 2026-09-01 (~40% of data)
4. Model Architecture:
   - GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.05, random_state=42)
5. Out-of-Sample Calibration & Threshold Evaluation.
"""

import os, json, glob, pickle, time
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import classification_report, accuracy_score, precision_score
from concurrent.futures import ProcessPoolExecutor

try:
    from .config import CONFIG
    from .patterns import detect_pattern
    from .entry_exit import TradeExecutionEngine
    from .backtest import calculate_wilder_rsi, n_map
except ImportError:
    from config import CONFIG
    from patterns import detect_pattern
    from entry_exit import TradeExecutionEngine
    from backtest import calculate_wilder_rsi, n_map

OHLCV_DIR = CONFIG["OHLCV_DIR"]
MODEL_SAVE_PATH = os.path.join(os.path.dirname(__file__), "model_gb.pkl")

def extract_trade_features(f_path):
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
        vol_sma20 = pd.Series(vols).rolling(CONFIG["VOL_SMA_PERIOD"]).mean().values
        rsi_series = calculate_wilder_rsi(closes, CONFIG["RSI_PERIOD"])

        engine = TradeExecutionEngine()
        records = []
        last_trade_idx = -999

        for i in range(85, n - 26):
            if i - last_trade_idx < 18: continue
            dt = dates[i]

            if CONFIG["REQUIRE_NIFTY_BULL"]:
                if dt not in n_map or not n_map[dt]['bull']: continue

            c_now = closes[i]
            v_now = vols[i]
            avg_v = vol_sma20[i - 1]
            if np.isnan(avg_v) or avg_v <= 0 or v_now < avg_v * CONFIG["MIN_BREAKOUT_VOL_SURGE"]: continue

            if c_now < ema50[i] or ema20[i] < ema50[i]: continue
            if c_now > ema200[i] * (1.0 + CONFIG["MAX_200_EMA_EXTENSION"]): continue

            cur_rsi = rsi_series[i]
            if cur_rsi < CONFIG["RSI_MIN"] or cur_rsi > CONFIG["RSI_MAX"]: continue

            lb = CONFIG["RS_LOOKBACK_BARS"]
            if i >= lb and dt in n_map and dates[i - lb] in n_map:
                s_ret = (c_now - closes[i - lb]) / closes[i - lb]
                n_ret = (n_map[dt]['close'] - n_map[dates[i - lb]]['close']) / n_map[dates[i - lb]]['close']
                rs_val = (s_ret - n_ret) * 100.0
                if rs_val < CONFIG["MIN_RS_OUTPERFORMANCE"]: continue
            else: continue

            rng = highs[i] - lows[i]
            if rng <= 0 or (highs[i] - c_now) / rng > CONFIG["MAX_UPPER_WICK_RATIO"]: continue

            sub_h = highs[:i+1]
            sub_l = lows[:i+1]
            sub_c = closes[:i+1]
            sub_v = vols[:i+1]

            detected = detect_pattern(sub_h, sub_l, sub_c, sub_v)
            if not detected: continue

            order_setup = engine.prepare_order(detected, c_now)
            if not order_setup: continue

            trade = engine.simulate_trade(dates, opens, highs, lows, closes, i, order_setup)
            if not trade: continue

            # Extract 11 Normalized Features Known at Signal Bar i
            base_len = detected.get('base_len', 50)
            depth_pct = detected.get('depth_pct', 15.0)
            vol_surge = v_now / avg_v
            vdu_5d = np.mean(vols[i-5:i]) / avg_v if i >= 5 else 1.0
            body_pct = abs(c_now - opens[i]) / rng
            upper_wick = (highs[i] - max(c_now, opens[i])) / rng
            lower_wick = (min(c_now, opens[i]) - lows[i]) / rng
            dist_ema20 = (c_now - ema20[i]) / ema20[i] * 100.0
            dist_ema50 = (c_now - ema50[i]) / ema50[i] * 100.0
            dist_ema200 = (c_now - ema200[i]) / ema200[i] * 100.0

            records.append({
                'sym': sym,
                'entry_date': trade['entry_date'],
                'features': [
                    base_len, depth_pct, vol_surge, vdu_5d,
                    body_pct, upper_wick, lower_wick,
                    dist_ema20, dist_ema50, dist_ema200, rs_val
                ],
                'pnl_pct': trade['pnl_pct'],
                'win': int(trade['win'])
            })
            last_trade_idx = i

        return records
    except: return []

def train_and_evaluate():
    print("=" * 95)
    print("  TRAINING & OUT-OF-SAMPLE ML VALIDATION PIPELINE")
    print("=" * 95)
    files = [f for f in glob.glob(os.path.join(OHLCV_DIR, "*.json")) if "NIFTYBEES" not in f]

    with ProcessPoolExecutor(max_workers=12) as ex:
        res = list(ex.map(extract_trade_features, files))

    dataset = [t for sub in res for t in sub]
    dataset.sort(key=lambda x: x['entry_date'])
    print(f"Total confirmed trade events extracted: {len(dataset)}")

    # Strict Walk-Forward Split
    split_date = "2025-04-01"
    train_set = [d for d in dataset if d['entry_date'] < split_date]
    test_set = [d for d in dataset if d['entry_date'] >= split_date]

    X_train = np.array([d['features'] for d in train_set])
    y_train = np.array([d['win'] for d in train_set])
    X_test = np.array([d['features'] for d in test_set])
    y_test = np.array([d['win'] for d in test_set])

    print(f"In-Sample (Train) Trades   : {len(train_set)} (Before {split_date})")
    print(f"Out-of-Sample (Holdout)    : {len(test_set)} (On or After {split_date})")

    # Baseline Out-of-Sample Performance (No ML)
    base_wr = np.mean(y_test) * 100.0
    base_pnls = [d['pnl_pct'] for d in test_set]
    base_gg = sum(p for p in base_pnls if p > 0)
    base_gl = abs(sum(p for p in base_pnls if p < 0))
    base_pf = (base_gg / base_gl) if base_gl > 0 else 999.0

    print("\n" + "-" * 95)
    print(f"BASELINE OUT-OF-SAMPLE PERFORMANCE (No ML Filter):")
    print(f"  Trades: {len(test_set)} | Win Rate: {base_wr:.2f}% | Profit Factor: {base_pf:.2f}")
    print("-" * 95)

    # Train Model
    gb = GradientBoostingClassifier(n_estimators=100, max_depth=3, learning_rate=0.05, random_state=42)
    gb.fit(X_train, y_train)

    # Save Model
    with open(MODEL_SAVE_PATH, "wb") as f:
        pickle.dump(gb, f)
    print(f"Serialized trained model to: {MODEL_SAVE_PATH}")

    # Out-of-Sample Evaluation Across Thresholds
    probs = gb.predict_proba(X_test)[:, 1]
    print("\nOUT-OF-SAMPLE ML PERFORMANCE AT CALIBRATED THRESHOLDS:")
    print("-" * 95)
    print(f"{'Threshold':12} | {'Trades':8} | {'Win Rate':10} | {'Profit Factor':14} | {'Net PnL%'}")
    print("-" * 95)

    for thresh in [0.48, 0.52, 0.55]:
        picked = [idx for idx, p in enumerate(probs) if p >= thresh]
        if not picked: continue
        p_trades = [test_set[idx] for idx in picked]
        p_wins = sum(d['win'] for d in p_trades)
        p_wr = (p_wins / len(p_trades)) * 100.0
        p_pnls = [d['pnl_pct'] for d in p_trades]
        p_gg = sum(p for p in p_pnls if p > 0)
        p_gl = abs(sum(p for p in p_pnls if p < 0))
        p_pf = (p_gg / p_gl) if p_gl > 0 else 999.0
        print(f"Conf >= {thresh:.2f}  | {len(p_trades):8d} | {p_wr:9.2f}% | {p_pf:13.2f}  | {sum(p_pnls):+8.1f}%")

if __name__ == '__main__':
    train_and_evaluate()

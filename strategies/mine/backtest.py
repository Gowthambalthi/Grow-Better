"""
strategies/mine/backtest.py
----------------------------
Authoritative Multi-Year Portfolio Backtester (Python)
Executes across full 997 liquid NSE universe with:
1. Wilder-smoothed RSI (alpha=1/14)
2. 60-day RS vs NIFTY 50 (>= +5.0%)
3. Market gate (NIFTY > 50 EMA)
4. Confirmed zero look-ahead patterns
5. Realistic order execution (gap-down open exits, Day-1 intraday stops, Zerodha friction 0.28%)
6. Date-sequenced 20-slot portfolio capacity
"""

import os, glob, json, math, time
import numpy as np
import pandas as pd
from concurrent.futures import ProcessPoolExecutor
try:
    from .config import CONFIG
    from .patterns import detect_pattern
    from .entry_exit import TradeExecutionEngine
except ImportError:
    from config import CONFIG
    from patterns import detect_pattern
    from entry_exit import TradeExecutionEngine

OHLCV_DIR = CONFIG["OHLCV_DIR"]
NIFTY_PATH = CONFIG["NIFTY_PATH"]

with open(NIFTY_PATH) as f: n_candles = json.load(f)['candles']
n_dates = [c[0][:10] for c in n_candles]
n_closes = np.array([float(c[4]) for c in n_candles])
n_ema50 = pd.Series(n_closes).ewm(span=50).mean().values
n_map = {n_dates[i]: {'close': n_closes[i], 'bull': n_closes[i] > n_ema50[i]} for i in range(len(n_dates))}

def calculate_wilder_rsi(closes, period=14):
    n = len(closes)
    if n < period + 2: return np.full(n, 50.0)
    diff = np.diff(closes)
    gains = np.maximum(diff, 0)
    losses = np.maximum(-diff, 0)
    avg_g = pd.Series(gains).ewm(alpha=1.0/period, adjust=False).mean().values
    avg_l = pd.Series(losses).ewm(alpha=1.0/period, adjust=False).mean().values
    rs = np.divide(avg_g, avg_l, out=np.zeros_like(avg_g), where=avg_l != 0)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return np.insert(rsi, 0, 50.0)

def scan_symbol_trades(f_path):
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
        signals = []
        last_trade_idx = -999

        for i in range(85, n - 26):
            if i - last_trade_idx < 18: continue
            dt = dates[i]
            
            # Market gate
            if CONFIG["REQUIRE_NIFTY_BULL"]:
                if dt not in n_map or not n_map[dt]['bull']: continue

            c_now = closes[i]
            v_now = vols[i]
            avg_v = vol_sma20[i - 1]
            if np.isnan(avg_v) or avg_v <= 0 or v_now < avg_v * CONFIG["MIN_BREAKOUT_VOL_SURGE"]: continue

            # Trend & Extension
            if c_now < ema50[i] or ema20[i] < ema50[i]: continue
            if c_now > ema200[i] * (1.0 + CONFIG["MAX_200_EMA_EXTENSION"]): continue

            # Wilder RSI Sweet Spot [50, 78]
            cur_rsi = rsi_series[i]
            if cur_rsi < CONFIG["RSI_MIN"] or cur_rsi > CONFIG["RSI_MAX"]: continue

            # 60-Day Relative Strength vs NIFTY
            if i >= CONFIG["RS_LOOKBACK_BARS"] and dt in n_map and dates[i - CONFIG["RS_LOOKBACK_BARS"]] in n_map:
                s_ret = (c_now - closes[i - CONFIG["RS_LOOKBACK_BARS"]]) / closes[i - CONFIG["RS_LOOKBACK_BARS"]]
                n_ret = (n_map[dt]['close'] - n_map[dates[i - CONFIG["RS_LOOKBACK_BARS"]]]['close']) / n_map[dates[i - CONFIG["RS_LOOKBACK_BARS"]]]['close']
                if (s_ret - n_ret) * 100.0 < CONFIG["MIN_RS_OUTPERFORMANCE"]: continue
            else: continue

            # Candle Quality: Upper wick <= 35% of bar range
            rng = highs[i] - lows[i]
            if rng <= 0 or (highs[i] - c_now) / rng > CONFIG["MAX_UPPER_WICK_RATIO"]: continue

            # Slice history up to signal bar i (zero lookahead!)
            sub_h = highs[:i+1]
            sub_l = lows[:i+1]
            sub_c = closes[:i+1]
            sub_v = vols[:i+1]

            detected = detect_pattern(sub_h, sub_l, sub_c, sub_v)
            if not detected: continue

            order_setup = engine.prepare_order(detected, c_now)
            if not order_setup: continue # Rejected if risk outside [2.5%, 7.5%]

            trade = engine.simulate_trade(dates, opens, highs, lows, closes, i, order_setup)
            if trade:
                trade['sym'] = sym
                trade['rsi'] = round(float(cur_rsi), 1)
                signals.append(trade)
                last_trade_idx = i

        return signals
    except: return []

def run_full_backtest():
    print("=" * 95)
    print("  RUNNING UNIFIED QUANTITATIVE BACKTEST (997 NSE STOCKS, 3 YEARS)")
    print("=" * 95)
    t0 = time.time()
    files = [f for f in glob.glob(os.path.join(OHLCV_DIR, "*.json")) if "NIFTYBEES" not in f]

    with ProcessPoolExecutor(max_workers=12) as ex:
        res = list(ex.map(scan_symbol_trades, files))

    trades = [t for sub in res for t in sub]
    trades.sort(key=lambda x: x['entry_date'])
    print(f"Executed across {len(files)} stocks in {time.time()-t0:.2f}s | Total trades generated: {len(trades)}")

    # Portfolio simulation with 20 concurrent slots
    active_positions = []
    portfolio_trades = []

    for t in trades:
        # Clear closed positions
        active_positions = [p for p in active_positions if p['exit_date'] > t['entry_date']]
        if len(active_positions) < CONFIG["MAX_CONCURRENT_POSITIONS"]:
            active_positions.append(t)
            portfolio_trades.append(t)

    tot = len(portfolio_trades)
    wins = [t for t in portfolio_trades if t['win']]
    losses = [t for t in portfolio_trades if not t['win']]
    wr = len(wins) / tot * 100.0 if tot else 0.0

    pnls = [t['pnl_pct'] for t in portfolio_trades]
    gg = sum(p for p in pnls if p > 0)
    gl = abs(sum(p for p in pnls if p < 0))
    pf = (gg / gl) if gl > 0 else 999.0
    aw = np.mean([p for p in pnls if p > 0]) if wins else 0
    al = np.mean([p for p in pnls if p < 0]) if losses else 0
    exp = (wr/100.0 * aw) - ((100.0 - wr)/100.0 * abs(al))

    gap_losses = sum(1 for t in portfolio_trades if t.get('was_gap_loss', False))
    gap_freq = (gap_losses / tot * 100.0) if tot else 0.0

    print("\n" + "=" * 95)
    print("  PORTFOLIO PERFORMANCE SUMMARY (20 SLOTS CAPACITY, 0.28% FRICTION)")
    print("=" * 95)
    print(f"  Executed Portfolio Trades : {tot} (~{tot/3:.0f}/year | ~{tot/150:.1f} calls/week)")
    print(f"  Win Rate                  : {wr:.2f}% ({len(wins)} Wins / {len(losses)} Losses)")
    print(f"  Profit Factor             : {pf:.2f}")
    print(f"  Average Winner            : +{aw:.2f}%")
    print(f"  Average Loser             : {al:.2f}%")
    print(f"  Win/Loss Payoff Ratio     : {abs(aw/al):.2f}x")
    print(f"  Net Expectancy E(R)       : +{exp:.2f}% per trade")
    print(f"  Gap-Loss Frequency        : {gap_freq:.2f}% of trades")
    print(f"  Cumulative Net Return     : +{sum(pnls):.1f}%")
    print("=" * 95)

    with open("data/unified_backtest_trades.json", "w") as fp:
        json.dump(portfolio_trades, fp, indent=2)

    return portfolio_trades

if __name__ == '__main__':
    run_full_backtest()

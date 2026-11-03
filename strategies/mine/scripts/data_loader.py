import os
import json
import numpy as np
from strategies.mine.config import MIN_TURNOVER_CR

def get_project_root():
    curr = os.path.abspath(os.path.dirname(__file__))
    while curr and os.path.dirname(curr) != curr:
        if os.path.exists(os.path.join(curr, 'data', 'universe_filtered.json')):
            return curr
        curr = os.path.dirname(curr)
    return os.path.abspath('.')

def load_clean_market_data():
    root = get_project_root()
    univ_path = os.path.join(root, 'data', 'universe_filtered.json')
    if not os.path.exists(univ_path):
        raise FileNotFoundError(f"Universe file not found at {univ_path}")
        
    with open(univ_path, 'r', encoding='utf-8') as f:
        univ = json.load(f)
        
    stocks_meta = {s['symbol']: s for s in univ['stocks']}
    
    # 1. Load NIFTY 50 Benchmark (from NIFTYBEES)
    nifty_p = os.path.join(root, 'data', 'ohlcv_3y', 'NIFTYBEES.json')
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
            nifty_map[d] = {'close': float(c), 'ema50': float(e), 'bull': bool(c >= e)}
            
    # 2. Load Stock Candles
    stock_data = {}
    for sym, meta in stocks_meta.items():
        turnover = meta.get('avgTurnoverCr', 0.0)
        if turnover < MIN_TURNOVER_CR:
            continue
            
        p = os.path.join(root, 'data', 'ohlcv_3y', f'{sym}.json')
        if not os.path.exists(p):
            continue
            
        try:
            with open(p, 'r', encoding='utf-8') as f:
                d = json.load(f)
            candles = d.get('candles', [])
            if len(candles) < 220:
                continue
                
            dates = [c[0][:10] for c in candles]
            arr = np.array([[c[1], c[2], c[3], c[4], c[5]] for c in candles], dtype=np.float64) # O, H, L, C, V
            n = len(dates)
            
            c = arr[:, 3]
            h = arr[:, 1]
            l = arr[:, 2]
            v = arr[:, 4]
            
            # Volume SMA20
            v_sma = np.convolve(v, np.ones(20)/20.0, mode='valid')
            v_sma = np.pad(v_sma, (19, 0), constant_values=np.nan)
            
            # ATR14
            tr = np.zeros(n)
            tr[0] = h[0] - l[0]
            tr[1:] = np.maximum(h[1:] - l[1:], np.maximum(np.abs(h[1:] - c[:-1]), np.abs(l[1:] - c[:-1])))
            atr = np.convolve(tr, np.ones(14)/14.0, mode='valid')
            atr = np.pad(atr, (13, 0), constant_values=np.nan)
            
            # EMAs
            def calc_ema(period):
                alpha = 2.0 / (period + 1.0)
                res = np.zeros(n)
                res[0] = c[0]
                for t in range(1, n):
                    res[t] = alpha * c[t] + (1.0 - alpha) * res[t-1]
                return res
                
            ema20 = calc_ema(20)
            ema50 = calc_ema(50)
            ema200 = calc_ema(200)
            
            stock_data[sym] = {
                'dates': dates,
                'mat': arr,
                'v_sma': v_sma,
                'atr': atr,
                'ema20': ema20,
                'ema50': ema50,
                'ema200': ema200,
                'turnover': turnover
            }
        except Exception:
            continue
            
    print(f"Loaded {len(stock_data)} liquid large-cap stocks (Turnover >= Rs {MIN_TURNOVER_CR} Cr).")
    return stock_data, nifty_map

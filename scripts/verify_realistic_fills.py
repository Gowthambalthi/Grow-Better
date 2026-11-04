import os, json, numpy as np
with open('data/calibrated_500_trades.json', 'r') as fp:
    trades = json.load(fp)

OHLCV_DIR = 'data/ohlcv_3y'
FRICTION = 0.0028

corrected_trades = []
for t in trades:
    sym = t['sym']
    dt = t['date']
    ep = t['entry_price']
    sl = t['stop_price']
    pat = t['pattern']
    
    p = f'{OHLCV_DIR}/{sym}.json'
    if not os.path.exists(p): continue
    with open(p, 'r') as fp:
        candles = json.load(fp)['candles']
    dates = [c[0][:10] for c in candles]
    if dt not in dates: continue
    start_idx = dates.index(dt)
    
    t1 = ep * 1.055
    t2 = ep * 1.105
    cur_stop = sl
    t1_hit = False
    pnl = None
    exit_reason = None
    
    for k in range(start_idx, min(start_idx + 25, len(candles))):
        o = float(candles[k][1])
        h = float(candles[k][2])
        l = float(candles[k][3])
        c = float(candles[k][4])
        
        prev_c = float(candles[k-1][4]) if k > 0 else o
        if o < prev_c * 0.70: # Corporate action demerger/split anomaly
            break
            
        if l <= cur_stop:
            fill_p = min(o, cur_stop) * (1.0 - FRICTION / 2.0)
            if t1_hit:
                pnl = 0.5 * ((t1 - ep)/ep) + 0.5 * ((fill_p - ep)/ep)
            else:
                pnl = (fill_p - ep) / ep
            exit_reason = 'STOP'
            break
            
        if not t1_hit and h >= t1:
            t1_hit = True
            cur_stop = ep * 1.002
            
        if t1_hit and h >= t2:
            fill_p = t2 * (1.0 - FRICTION / 2.0)
            pnl = 0.5 * ((t1 - ep)/ep) + 0.5 * ((fill_p - ep)/ep)
            exit_reason = 'TARGET_2'
            break
            
    if pnl is None and exit_reason != 'CORPORATE_ACTION':
        exit_p = float(candles[min(start_idx + 24, len(candles)-1)][4]) * (1.0 - FRICTION / 2.0)
        if t1_hit:
            pnl = 0.5 * ((t1 - ep)/ep) + 0.5 * ((exit_p - ep)/ep)
        else:
            pnl = (exit_p - ep) / ep
        exit_reason = 'TIME_EXIT'
        
    if pnl is not None:
        corrected_trades.append({
            'sym': sym, 'pat': pat, 'date': dt,
            'pnl': pnl * 100, 'win': pnl > 0,
            'reason': exit_reason
        })

print(f"Total Valid Trades: {len(corrected_trades)}")
wins = [x for x in corrected_trades if x['win']]
losses = [x for x in corrected_trades if not x['win']]
wr = len(wins) / len(corrected_trades) * 100
gains = sum(x['pnl'] for x in wins)
loss_sum = abs(sum(x['pnl'] for x in losses))
pf = gains / loss_sum if loss_sum > 0 else 999
print(f"Win Rate: {wr:.2f}% | Profit Factor: {pf:.2f}")
print(f"Avg Win: +{np.mean([x['pnl'] for x in wins]):.2f}% | Avg Loss: {np.mean([x['pnl'] for x in losses]):.2f}%")
print(f"Net PnL: {sum(x['pnl'] for x in corrected_trades):+.1f}%")

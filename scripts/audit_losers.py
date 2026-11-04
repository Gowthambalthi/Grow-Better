import json

with open('data/calibrated_1h_cup_trades.json') as fp:
    trades = json.load(fp)

losers = [t for t in trades if t['net_pct'] <= 0]
winners = [t for t in trades if t['net_pct'] > 0]

print("="*80)
print(f"AUDIT OF LOSING STOCKS (Total Losers: {len(losers)} / Total Trades: {len(trades)})")
print("="*80)
for t in sorted(losers, key=lambda x: x['net_pct']):
    sym = t['symbol']
    dt = t['date']
    ep = t['entry_p']
    sl = t['sl_p']
    xp = t['exit_p']
    net = t['net_pct']
    rsn = t['exit_reason']
    bh = t['bars_held']
    print(f"Symbol: {sym:12s} | Entry: {dt} @ Rs {ep:7.2f} | SL: Rs {sl:7.2f} | Out: Rs {xp:7.2f} | Net: {net:+6.2f}% | Held: {bh:2d}h | Exit: {rsn}")

print("\n" + "="*80)
print(f"AUDIT OF WINNING STOCKS (Total Winners: {len(winners)})")
print("="*80)
for t in sorted(winners, key=lambda x: x['net_pct'], reverse=True):
    sym = t['symbol']
    dt = t['date']
    ep = t['entry_p']
    sl = t['sl_p']
    xp = t['exit_p']
    net = t['net_pct']
    rsn = t['exit_reason']
    bh = t['bars_held']
    print(f"Symbol: {sym:12s} | Entry: {dt} @ Rs {ep:7.2f} | SL: Rs {sl:7.2f} | Out: Rs {xp:7.2f} | Net: {net:+6.2f}% | Held: {bh:2d}h | Exit: {rsn}")

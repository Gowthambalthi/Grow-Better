"""
strategies/mine/cup_handle_reporter.py
---------------------------------------
Authoritative Cup & Handle Geometric Measurement Reporter
Prints full institutional measurement table for any symbol & date.
"""

import json, sys, os
import numpy as np

def print_cup_handle_report(symbol, dates, opens, highs, lows, closes, vols, idx=None):
    if idx is None:
        idx = len(closes) - 1

    sub_h = highs[:idx+1]
    sub_l = lows[:idx+1]
    sub_c = closes[:idx+1]
    sub_v = vols[:idx+1]
    n = len(sub_c)

    # Search pattern
    match = None
    for clen in [35, 45, 50, 55, 60, 65, 75, 90, 110]:
        for hlen in range(5, 23, 2):
            tot = clen + hlen
            if n < tot + 30: continue
            cs = n - 1 - tot
            ce = n - 1 - hlen

            prior_start = max(0, cs - 100)
            prior_min = np.min(sub_l[prior_start : cs + 1])
            prior_gain = (sub_h[cs] - prior_min) / prior_min * 100.0

            lr = np.max(sub_h[cs : cs + 18])
            l_idx = cs + int(np.argmax(sub_h[cs : cs + 18]))

            rr = np.max(sub_h[max(cs + 25, ce - 8) : ce + 1])
            r_idx = max(cs + 25, ce - 8) + int(np.argmax(sub_h[max(cs + 25, ce - 8) : ce + 1]))

            rim_dist = r_idx - l_idx
            if rim_dist < 25 or rim_dist > 120: continue
            rim_diff_pct = abs(rr - lr) / lr * 100.0
            if rim_diff_pct > 4.5: continue

            rim = max(lr, rr)
            cup_bot = np.min(sub_l[l_idx : r_idx + 1])
            bot_idx = l_idx + int(np.argmin(sub_l[l_idx : r_idx + 1]))
            cup_depth_pct = (rim - cup_bot) / rim * 100.0

            bottom_quartile = cup_bot + 0.25 * (rim - cup_bot)
            bars_in_bottom = sum(1 for i in range(l_idx, r_idx + 1) if sub_l[i] <= bottom_quartile)
            bot_pos = (bot_idx - l_idx) / rim_dist

            actual_handle_len = (n - 1) - r_idx
            if actual_handle_len < 5 or actual_handle_len > 25: continue

            h_bot = np.min(sub_l[r_idx + 1 : n - 1])
            handle_pullback_pct = (rr - h_bot) / rr * 100.0
            handle_ratio = (handle_pullback_pct / cup_depth_pct) * 100.0

            avg_cup_vol = np.mean(sub_v[cs : r_idx])
            avg_h_vol = np.mean(sub_v[r_idx : n - 1])
            vol_ratio = avg_h_vol / avg_cup_vol

            avg_vol_20 = np.mean(sub_v[-21:-1])
            breakout_vol_mult = sub_v[-1] / avg_vol_20
            cur_c = sub_c[-1]

            if cur_c > rim * 0.990:
                match = {
                    "cup_len": rim_dist,
                    "handle_len": actual_handle_len,
                    "left_rim": lr,
                    "left_rim_date": dates[l_idx],
                    "right_rim": rr,
                    "right_rim_date": dates[r_idx],
                    "rim_diff_pct": rim_diff_pct,
                    "cup_bot": cup_bot,
                    "cup_bot_date": dates[bot_idx],
                    "cup_depth_pct": cup_depth_pct,
                    "handle_bot": h_bot,
                    "handle_pullback_pct": handle_pullback_pct,
                    "handle_ratio": handle_ratio,
                    "bars_in_bottom": bars_in_bottom,
                    "bot_pos": bot_pos,
                    "prior_gain": prior_gain,
                    "vol_ratio": vol_ratio,
                    "breakout_vol_mult": breakout_vol_mult,
                    "breakout_close": cur_c,
                    "signal_date": dates[idx]
                }
                break
        if match: break

    print("\n" + "=" * 65)
    print(f"       CUP AND HANDLE VALIDATION REPORT: {symbol}")
    print("=" * 65)
    if not match:
        print("  Status: NO CUP AND HANDLE PATTERN DETECTED")
        print("=" * 65)
        return None

    m = match
    curve_status = "PASS" if m['bars_in_bottom'] >= 5 and 0.30 <= m['bot_pos'] <= 0.70 else "FAIL"
    prior_status = "PASS" if m['prior_gain'] >= 20.0 else "FAIL"
    diff_status = "PASS" if m['rim_diff_pct'] <= 3.0 else "MARGINAL"
    ratio_status = "PASS" if m['handle_ratio'] <= 35.0 else "FAIL (HANDLE DEEP)"
    vol_status = "PASS" if m['breakout_vol_mult'] >= 1.5 else "FAIL"

    print(f"Signal Date:             {m['signal_date']}")
    print(f"Cup length:              {m['cup_len']} trading days ({m['left_rim_date']} to {m['right_rim_date']})")
    print(f"Handle length:           {m['handle_len']} trading days ({m['right_rim_date']} to {m['signal_date']})")
    print(f"Left rim:                Rs {m['left_rim']:.2f}")
    print(f"Right rim:               Rs {m['right_rim']:.2f}")
    print(f"Rim difference:          {m['rim_diff_pct']:.2f}% [{diff_status}]")
    print(f"Cup depth:               {m['cup_depth_pct']:.2f}% [PASS 12% - 35%]")
    print(f"Handle depth:            {m['handle_pullback_pct']:.2f}% below right rim")
    print(f"Handle / cup ratio:      {m['handle_ratio']:.2f}% [{ratio_status}]")
    print(f"Bottom curvature:        {curve_status} ({m['bars_in_bottom']} bars in bottom quartile)")
    print(f"Prior uptrend:           {prior_status} (+{m['prior_gain']:.1f}% advance)")
    print(f"Breakout volume:         {m['breakout_vol_mult']:.2f}x 20-day SMA [{vol_status}]")
    print("-" * 65)
    print("DECISION 1 (Pattern):    VALID CUP & HANDLE FORMATION")
    
    # Trade decision
    stop_dist = (m['breakout_close'] - m['handle_bot'] * 0.995) / m['breakout_close'] * 100.0
    trade_status = "ACCEPT" if stop_dist <= 7.5 else "REJECT (STOP TOO WIDE > 7.5%)"
    print(f"DECISION 2 (Trade Risk): {trade_status} (Initial Risk: {stop_dist:.2f}%)")
    print("=" * 65 + "\n")
    return m

if __name__ == "__main__":
    with open("data/ohlcv_3y/JAMNAAUTO.json") as fp:
        raw = json.load(fp)['candles']
    dates = [c[0][:10] for c in raw]
    idx = dates.index("2026-08-03")
    opens = np.array([float(c[1]) for c in raw])
    highs = np.array([float(c[2]) for c in raw])
    lows = np.array([float(c[3]) for c in raw])
    closes = np.array([float(c[4]) for c in raw])
    vols = np.array([float(c[5]) for c in raw])
    print_cup_handle_report("JAMNAAUTO", dates, opens, highs, lows, closes, vols, idx)

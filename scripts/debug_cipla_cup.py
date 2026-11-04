import json
import numpy as np

with open('data/ohlcv_3y/CIPLA.json', 'r') as fp:
    candles = json.load(fp)['candles']

dates = [c[0][:10] for c in candles]
highs = np.array([float(c[2]) for c in candles])
lows = np.array([float(c[3]) for c in candles])
closes = np.array([float(c[4]) for c in candles])

# Find the peak around March 2024 and breakout around Aug 2024
left_peak_date = '2024-03-11'
right_peak_date = '2024-06-19'
breakout_date = '2024-08-13'

i_left = dates.index(left_peak_date)
i_right = dates.index(right_peak_date)
i_break = dates.index(breakout_date)

print(f"Left Rim: {dates[i_left]} at Rs.{highs[i_left]}")
print(f"Right Rim: {dates[i_right]} at Rs.{highs[i_right]}")
print(f"Breakout: {dates[i_break]} at Rs.{closes[i_break]} (High: Rs.{highs[i_break]})")
print(f"Gap from Left Rim to Right Rim: {i_right - i_left} trading days")
print(f"Gap from Right Rim to Breakout (Handle): {i_break - i_right} trading days")
print(f"Total Base Span: {i_break - i_left} trading days")

rim_diff = abs(highs[i_right] - highs[i_left]) / max(highs[i_left], highs[i_right])
print(f"Rim Diff: {rim_diff * 100:.2f}% (Left=1519, Right=1582)")

# Notice: Left Rim was 1519 and Right Rim was 1582!
# Difference is (1582 - 1519) / 1582 = 3.98%!

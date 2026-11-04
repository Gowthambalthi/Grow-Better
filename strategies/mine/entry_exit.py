"""
strategies/mine/entry_exit.py
------------------------------
Authoritative Order Execution and Trade Lifecycle Engine (Python)
Matches strategies/mine/entry_exit.js 1:1.
"""

try:
    from .config import CONFIG
except ImportError:
    from config import CONFIG

class TradeExecutionEngine:
    def __init__(self, config=None):
        self.cfg = {**CONFIG, **(config or {})}

    def prepare_order(self, detected_pattern, current_close):
        if not detected_pattern or 'level' not in detected_pattern or 'stop_level' not in detected_pattern:
            return None

        pivot = detected_pattern['level']
        struct_stop = detected_pattern['stop_level']
        risk_pct = ((current_close - struct_stop) / current_close) * 100.0

        # FIX BUG: DO NOT CLAMP STRUCTURAL STOP. REJECT UNHEALTHY RISK.
        if risk_pct < self.cfg['MIN_STRUCTURAL_RISK_PCT'] or risk_pct > self.cfg['MAX_STRUCTURAL_RISK_PCT']:
            return None # Reject trade completely

        return {
            'pattern': detected_pattern['pattern'],
            'pivot_price': pivot,
            'structural_stop': struct_stop,
            'signal_close': current_close,
            'initial_risk_pct': risk_pct
        }

    def simulate_trade(self, dates, opens, highs, lows, closes, signal_idx, order_setup):
        n = len(dates)
        if signal_idx + 1 >= n:
            return None

        pivot = order_setup['pivot_price']
        next_o = opens[signal_idx + 1]
        next_l = lows[signal_idx + 1]
        is_limit = False

        # Anti-chasing limit gate
        max_gap = pivot * (1.0 + self.cfg['MAX_GAP_BUY_POCKET_PCT'] / 100.0)
        if next_o > max_gap:
            limit_price = pivot * (1.0 + self.cfg['LIMIT_RETEST_LEVEL_PCT'] / 100.0)
            if next_l <= limit_price:
                entry_price = limit_price
                is_limit = True
            else:
                return None
        else:
            entry_price = next_o

        friction_half = self.cfg['FRICTION_ROUND_TRIP'] / 2.0
        entry_p_fric = entry_price * (1.0 + friction_half)
        cur_stop = order_setup['structural_stop']

        t1_price = entry_p_fric * (1.0 + self.cfg['TARGET_1_PCT'] / 100.0)
        t2_price = entry_p_fric * (1.0 + self.cfg['TARGET_2_PCT'] / 100.0)

        t1_hit = False
        trade_pnl = None
        exit_reason = None
        exit_bar_idx = None
        exit_price_actual = None
        bars_held = 0
        was_gap_loss = False

        for k in range(signal_idx + 1, min(signal_idx + 1 + self.cfg['MAX_HOLD_BARS'], n)):
            bars_held += 1
            o, h, l, c = opens[k], highs[k], lows[k], closes[k]

            # DAY 1: Intraday ambiguity
            if k == signal_idx + 1:
                if l <= cur_stop:
                    exit_price_actual = min(cur_stop, c)
                    trade_pnl = (exit_price_actual * (1.0 - friction_half) - entry_p_fric) / entry_p_fric
                    exit_reason = "DAY1_INTRADAY_STOP"
                    exit_bar_idx = k
                    break
                continue

            # DAY 2+:
            # 1. Gap-down stop
            if o < cur_stop:
                was_gap_loss = True
                exit_price_actual = o
                trade_pnl = (exit_price_actual * (1.0 - friction_half) - entry_p_fric) / entry_p_fric
                exit_reason = "GAP_DOWN_STOP"
                exit_bar_idx = k
                break

            # 2. Target 1
            if not t1_hit and h >= t1_price:
                t1_hit = True
                cur_stop = max(cur_stop, entry_p_fric * (1.0 + self.cfg['FRICTION_ROUND_TRIP']))

            # 3. Stop loss hit
            if l <= cur_stop:
                exit_price_actual = cur_stop
                exit_net = exit_price_actual * (1.0 - friction_half)
                if t1_hit:
                    trade_pnl = 0.5 * ((t1_price * (1.0 - friction_half) - entry_p_fric) / entry_p_fric) + \
                               0.5 * ((exit_net - entry_p_fric) / entry_p_fric)
                    exit_reason = "RUNNER_STOP_BE"
                else:
                    trade_pnl = (exit_net - entry_p_fric) / entry_p_fric
                    exit_reason = "NORMAL_STOP"
                exit_bar_idx = k
                break

            # 4. Trailing runner
            if t1_hit and k >= signal_idx + 4:
                trail_low = min(lows[k-3:k])
                if trail_low > cur_stop: cur_stop = trail_low

                # 5. Target 2
                if h >= t2_price:
                    exit_price_actual = t2_price
                    trade_pnl = 0.5 * ((t1_price * (1.0 - friction_half) - entry_p_fric) / entry_p_fric) + \
                               0.5 * ((t2_price * (1.0 - friction_half) - entry_p_fric) / entry_p_fric)
                    exit_reason = "TARGET_2"
                    exit_bar_idx = k
                    break

        if trade_pnl is None:
            last_k = min(signal_idx + self.cfg['MAX_HOLD_BARS'], n - 1)
            exit_price_actual = closes[last_k]
            exit_net = exit_price_actual * (1.0 - friction_half)
            if t1_hit:
                trade_pnl = 0.5 * ((t1_price * (1.0 - friction_half) - entry_p_fric) / entry_p_fric) + \
                           0.5 * ((exit_net - entry_p_fric) / entry_p_fric)
            else:
                trade_pnl = (exit_net - entry_p_fric) / entry_p_fric
            exit_reason = "TIME_EXIT"
            exit_bar_idx = last_k

        return {
            'pattern': order_setup['pattern'],
            'entry_date': dates[signal_idx + 1],
            'entry_price': round(float(entry_price), 2),
            'stop_price': round(float(order_setup['structural_stop']), 2),
            'exit_date': dates[exit_bar_idx],
            'exit_price': round(float(exit_price_actual), 2),
            'pnl_pct': round(float(trade_pnl * 100.0), 2),
            'win': bool(trade_pnl > 0),
            'bars_held': bars_held,
            'exit_reason': exit_reason,
            'was_gap_loss': was_gap_loss,
            'is_limit_order': is_limit
        }

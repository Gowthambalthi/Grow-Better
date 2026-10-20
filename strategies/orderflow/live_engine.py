"""orderflow/live_engine.py - High-Performance Real-Time Institutional Strategy Engine in Python.

Features:
1. Fast in-memory 1-minute OHLCV, Delta, CVD, and VWAP aggregation across ~700 Indian stocks.
2. High-speed vectorized setup scan every 60 seconds (every minute).
3. Institutional confluence:
   - Fair Value Gap (FVG) Displacement & Support
   - Order Flow Delta Footprint & CVD turnaround
   - Volume Surge (>1.3x baseline)
   - VWAP Defense (Pullback within 0.05% - 0.85%)
   - Anti-Climax Guard (rejects vertical spikes > 2.5x ATR near HOD - Anti-Patanjali Trap)
   - Strict Target Floor: Minimum Target >= 0.70% to 1.20% (70-120 bps) with R:R >= 1:1.60
4. Sub-second tick monitoring: Target Hit (WON) and Stop Loss Hit (LOST) evaluation.
5. Instant Telegram dispatch to @GBTerminalAlertsBot for new calls, target hits, and stop hits.
6. Dynamic Scorecard calculation: Total recommendations, Won, Lost, Win Rate %, Net INR, Net Verdict.
"""

import os
import sys
import json
import time
import math
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Optional, Any
import requests

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

IST = timezone(timedelta(hours=5, minutes=30))
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'orderflow')
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'notification_settings.json')
POSITION_NOTIONAL = float(os.environ.get('GB_POSITION_NOTIONAL', 50000.0))

# ---- FVG STRUCTURAL RULES (research/fvg/FVG_DEEP_RESEARCH.md, Part 6.1) -------------
# Same four rules as the Node engine, ported 1:1 for parity:
#   F1 QUALITY  gap >= max(8 bps, 0.10 x ATR) and the displacement candle's body is
#               >= 60% of its own range (published tool defaults, not optima).
#   F2 CE       a short must sell INTO the imbalance: price at or above the 50% midpoint.
#   F3 LIVENESS a COMPLETED close beyond the distal wick kills the gap.
#   F4 STOP FIT the structural stop (beyond the distal wick) must fit the 1:1.50 mandate.
# Everything reads only bars already seen — the block is CAUSAL by construction.
# SHIPPED DEFAULT: measurement ON, VETO OFF — identical to the Node engine. Measured
# causally across 8 sessions the veto cut trades 51 -> 10 on the 5 older days and made the
# mean worse (-7.7 -> -16.7 bps), and produced ZERO trades on the recent 3 days. The rules are
# computed and reported but do not block an entry until GB_FVG_REQUIRE=1 asks for it.
FVG_STRUCTURAL = os.environ.get('GB_FVG_STRUCTURAL', '1') != '0'
FVG_REQUIRE = os.environ.get('GB_FVG_REQUIRE', '0') == '1'
FVG_MIN_ATR_FRAC = float(os.environ.get('GB_FVG_MIN_ATR_FRAC', 0.10))
FVG_MIN_BODY_FRAC = float(os.environ.get('GB_FVG_MIN_BODY_FRAC', 0.60))
FVG_MAX_STOP_BPS = float(os.environ.get('GB_FVG_MAX_STOP_BPS', 55.0))


def fvg_atr(bars: List[Dict[str, Any]]) -> float:
    """Mean true range of the last 8 bars, from the bars themselves."""
    w = bars[-8:]
    if not w:
        return 0.0
    return sum(b['h'] - b['l'] for b in w) / len(w)


def fvg_short_gate(bars: List[Dict[str, Any]], price: float) -> Dict[str, Any]:
    """
    The two entry-state rules that turn a gap into an allow/refuse decision for a SHORT.
    Mirror of fvgShortGate() in orderflow/liveMinuteEngine.js — same names, same order,
    same thresholds, so the two engines cannot drift apart on this rule.

      FVG_DEAD          a completed close above the distal wick killed the gap (F3)
      CE_BELOW_GAP      price has not retraced to the 50% midpoint yet (F2)
      FVG_STOP_TOO_FAR  the structural stop would exceed the 1:1.50 mandate (F4)
      FVG_RECLAIMED     price is back ABOVE the far edge: a short's stop would not be above it
      BEARISH_FVG_CE    live gap, price selling into its upper half — ALLOW
      NONE              no qualifying gap at all
    """
    gap = find_fvg(bars, -1)
    if not gap:
        return {'gate': 'NONE', 'gap': None, 'structuralStopBps': 0.0}
    if gap['dead']:
        return {'gate': 'FVG_DEAD', 'gap': gap, 'structuralStopBps': 0.0}
    if not (price >= gap['ce']):
        return {'gate': 'CE_BELOW_GAP', 'gap': gap, 'structuralStopBps': 0.0}
    # Above the distal edge the gap has been RECLAIMED. For a SHORT the structural stop has to sit
    # ABOVE the entry; up here the far edge is behind the price, so the arithmetic yields a NEGATIVE
    # stop that sails through the F4 cap and would report a nonsense trade as a qualified one.
    # Found by running the Node<->Python parity grid (scratch/fvg_parity_check.js), not by reading.
    if price > gap['top']:
        return {'gate': 'FVG_RECLAIMED', 'gap': gap, 'structuralStopBps': 0.0}
    structural_stop_bps = ((gap['top'] * (1.0 + 0.00005) - price) / price) * 10000.0
    if structural_stop_bps > FVG_MAX_STOP_BPS:
        return {'gate': 'FVG_STOP_TOO_FAR', 'gap': gap, 'structuralStopBps': round(structural_stop_bps, 1)}
    return {'gate': 'BEARISH_FVG_CE', 'gap': gap, 'structuralStopBps': round(structural_stop_bps, 1)}


def find_fvg(bars: List[Dict[str, Any]], direction: int):
    """
    Locate the most recent FVG in the last 8 completed bars, with its zone.

    direction = -1 -> BEARISH gap (candle 1 low above candle 3 high): zone [c3.high, c1.low]
    direction = +1 -> BULLISH gap (candle 3 low above candle 1 high): zone [c1.high, c3.low]

    Returns None when no gap clears F1, else a dict with top/bottom/ce/gapBps/bodyFrac/
    idx/dead/live. `dead` is F3: a completed bar after the gap closed beyond its far edge.
    """
    if not bars or len(bars) < 3:
        return None
    atr = fvg_atr(bars)
    ref = bars[-1].get('c') or bars[-1].get('h') or 1.0
    atr_bps = (atr / ref) * 10000.0 if ref > 0 else 0.0
    min_gap_bps = max(8.0, atr_bps * FVG_MIN_ATR_FRAC)
    for i in range(len(bars) - 1, max(1, len(bars) - 8), -1):
        if i - 2 < 0:
            continue
        c1, mid, c3 = bars[i - 2], bars[i - 1], bars[i]
        top = bottom = None
        if direction < 0 and c3['h'] < c1['l']:
            bottom, top = c3['h'], c1['l']
        elif direction > 0 and c3['l'] > c1['h']:
            bottom, top = c1['h'], c3['l']
        if top is None or not (top > bottom):
            continue
        gap_bps = ((top - bottom) / (c3.get('c') or c3['h'])) * 10000.0
        if gap_bps < min_gap_bps:
            continue
        rng = mid['h'] - mid['l']
        body_frac = abs(mid['c'] - mid['o']) / rng if rng > 0 else 0.0
        if FVG_STRUCTURAL and body_frac < FVG_MIN_BODY_FRAC:
            continue
        dead = False
        for k in range(i + 1, len(bars)):
            if direction < 0 and bars[k]['c'] > top:
                dead = True
                break
            if direction > 0 and bars[k]['c'] < bottom:
                dead = True
                break
        return {
            'dir': direction, 'top': round(top, 4), 'bottom': round(bottom, 4),
            'ce': round((top + bottom) / 2.0, 4), 'gapBps': round(gap_bps, 1),
            'bodyFrac': round(body_frac, 3), 'idx': i, 'dead': dead, 'live': not dead,
        }
    return None


def get_today_ist() -> str:
    return datetime.now(IST).strftime('%Y-%m-%d')


def net_inr_after_costs(pts: float, entry: float, shares: Any) -> float:
    """THE ONE FRICTION RULE, IN RUPPES — the same rule netBps applies: 15 bps of the
    entry for a full round trip (Rs 20 x 2 brokerage, STT 0.025% sell-side, NSE
    0.00297%, SEBI Rs 10/cr, 18% GST on those, 0.003% stamp on the buy ≈ 13 bps on a
    Rs 50,000 Angel One MIS round trip). Mirrors netInrAfterCosts() in
    liveMinuteEngine.js: a flat Rs 0.20 against a `pts * shares` P&L booked ~Rs 75 of
    real cost as Rs 0.20 and the daily verdict inherited the difference. A call that
    never moved reports 0 (pinned by test/depthOrientation in the Node twin)."""
    sh = int(shares) if shares else 1
    if not pts:
        return 0.0
    notional = (float(entry) or 0.0) * sh
    return round(pts * sh - notional * 0.0015, 2)


def get_ist_time_str() -> str:
    return datetime.now(IST).strftime('%H:%M:%S')


def load_telegram_config() -> Dict[str, Any]:
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {
        "botToken": os.getenv("TELEGRAM_BOT_TOKEN", ""),
        "chatId": os.getenv("TELEGRAM_CHAT_ID", ""),
        "enabled": True
    }


def send_telegram(message: str) -> bool:
    cfg = load_telegram_config()
    token = cfg.get("botToken")
    chat_id = cfg.get("chatId")
    if not token or not chat_id or cfg.get("enabled") is False:
        return False
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
        resp = requests.post(url, json=payload, timeout=6)
        return resp.status_code == 200
    except Exception as e:
        print(f"[PythonEngine] Telegram alert error: {e}", file=sys.stderr)
        return False


class LiveInstitutionalEngine:
    def __init__(self):
        self.today = get_today_ist()
        self.calls: Dict[str, Dict[str, Any]] = {}
        self.closed_calls: List[Dict[str, Any]] = []
        self.sym_bars: Dict[str, List[Dict[str, Any]]] = {}
        self.prev_price: Dict[str, float] = {}
        self.book: Dict[str, Dict[str, Any]] = {}
        self.ask_wall_ratio_min = float(os.environ.get('GB_ASK_WALL_RATIO', 0.0))  # disabled by default per user instruction
        self.max_spread_bps = float(os.environ.get('GB_MAX_SPREAD_BPS', 6.0))
        self.short_target_bps = float(os.environ.get('GB_SHORT_TARGET_BPS', 75.0))  # 1:1.50 scalp geometry mandate
        self.long_enabled = os.environ.get('GB_LONG_ENABLED', '1') != '0'
        self.strict_invalidation = os.environ.get('GB_STRICT_INVALIDATION', '1') != '0'
        self.depth_max_age_ms = 5000
        self.last_scan_time = 0.0
        self.load_existing_calls()

    def load_existing_calls(self):
        calls_file = os.path.join(DATA_DIR, f"daily_calls_{self.today}.json")
        if os.path.exists(calls_file):
            try:
                with open(calls_file, 'r', encoding='utf-8') as f:
                    arr = json.load(f)
                    if isinstance(arr, list):
                        for c in arr:
                            self.calls[c['id']] = c
                            if c.get('status') in ['WON', 'LOST', 'SESSION_CLOSE', 'TIME_EXIT', 'CLOSED']:
                                self.closed_calls.append(c)
                        print(f"[PythonEngine] Loaded {len(arr)} existing calls ({len(self.closed_calls)} closed) for {self.today}")
            except Exception as e:
                print(f"[PythonEngine] Error loading calls: {e}", file=sys.stderr)

    def save_calls(self):
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            calls_file = os.path.join(DATA_DIR, f"daily_calls_{self.today}.json")
            with open(calls_file, 'w', encoding='utf-8') as f:
                json.dump(list(self.calls.values()), f, indent=2)
            
            # Save scorecard summary
            scorecard_file = os.path.join(DATA_DIR, "daily_scorecard.json")
            with open(scorecard_file, 'w', encoding='utf-8') as f:
                json.dump(self.get_daily_net(), f, indent=2)
        except Exception as e:
            print(f"[PythonEngine] Error saving calls: {e}", file=sys.stderr)

    def ingest_tick(self, t: Dict[str, Any], live: bool = True):
        sym = t.get('s')
        price = float(t.get('p', 0.0))
        if not sym or price <= 0:
            return

        ts = int(t.get('t', int(time.time() * 1000)))
        min_key = (ts // 60000) * 60000
        qty = int(t.get('q', 1))

        if sym not in self.sym_bars:
            self.sym_bars[sym] = []
        bars = self.sym_bars[sym]

        # Aggressor side classification with oriented Level 1 depth
        raw_bid = float(t.get('bid', 0.0))
        raw_ask = float(t.get('ask', 0.0))
        bid = min(raw_bid, raw_ask) if raw_bid > 0 and raw_ask > 0 else (raw_bid or raw_ask)
        ask = max(raw_bid, raw_ask) if raw_bid > 0 and raw_ask > 0 else (raw_bid or raw_ask)
        bid_q = int(t.get('bq', 0))
        ask_q = int(t.get('sq', 0))
        self.book[sym] = {
            'bid': bid,
            'ask': ask,
            'bidq': bid_q,
            'askq': ask_q,
            't': ts
        }

        is_buy, is_sell = False, False
        if bid > 0 and ask > bid:
            if price >= ask:
                is_buy = True
            elif price <= bid:
                is_sell = True
        
        prev = self.prev_price.get(sym)
        if not is_buy and not is_sell and prev is not None:
            if price > prev:
                is_buy = True
            elif price < prev:
                is_sell = True
        self.prev_price[sym] = price

        delta_val = qty if is_buy else (-qty if is_sell else 0)

        if not bars or bars[-1]['t'] != min_key:
            bar = {
                't': min_key,
                'o': price,
                'h': price,
                'l': price,
                'c': price,
                'v': qty,
                'delta': delta_val,
                'buyVol': qty if is_buy else 0,
                'sellVol': qty if is_sell else 0
            }
            bars.append(bar)
            if len(bars) > 390:
                bars.pop(0)
        else:
            bar = bars[-1]
            bar['c'] = price
            if price > bar['h']:
                bar['h'] = price
            if price < bar['l']:
                bar['l'] = price
            bar['v'] += qty
            bar['delta'] += delta_val
            if is_buy:
                bar['buyVol'] += qty
            elif is_sell:
                bar['sellVol'] += qty

        if live:
            self.check_position(sym, price)

    def check_position(self, sym: str, live_price: float):
        now_ist = get_ist_time_str()
        changed = False

        for c in self.calls.values():
            if c.get('symbol') != sym or c.get('status') in ['WON', 'LOST', 'SESSION_CLOSE', 'TIME_EXIT', 'CLOSED']:
                continue

            c['ltp'] = live_price
            entry = float(c.get('limitEntry', live_price))
            is_short = 'SELL' in str(c.get('action', '')).upper() or 'SHORT' in str(c.get('side', '')).upper()
            target = float(c.get('target', 0.0))
            stop = float(c.get('stopLoss', 0.0))

            pts = (entry - live_price) if is_short else (live_price - entry)
            pnl_pct = (pts / entry * 100.0) if entry > 0 else 0.0
            c['livePoints'] = round(pts, 2)
            c['livePnLPct'] = round(pnl_pct, 2)
            c['livePnLVal'] = round(pts, 2)
            c['netInr1Lot'] = net_inr_after_costs(pts, entry, c.get('shares'))
            c['mfePct'] = max(float(c.get('mfePct', 0.0)), pnl_pct)

            # DYNAMIC BREAKEVEN LOCK (EXP004):
            # When trade reaches +0.50% profit (50 bps MFE), automatically trail stop to entry + 15 bps friction floor.
            if not c.get('breakevenArmed'):
                if not is_short and pnl_pct >= 0.50:
                    c['breakevenArmed'] = True
                    be_stop = round(entry * 1.0015, 2)
                    if be_stop > stop:
                        c['stopLoss'] = be_stop
                        c['note'] = (c.get('note', '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]')
                        print(f"[PythonEngine] 🛡️ BREAKEVEN LOCKED: {sym} reached +{pnl_pct:.2f}% MFE, trailing SL to ₹{c['stopLoss']}")
                elif is_short and pnl_pct >= 0.50:
                    c['breakevenArmed'] = True
                    be_stop = round(entry * 0.9985, 2)
                    if be_stop < stop:
                        c['stopLoss'] = be_stop
                        c['note'] = (c.get('note', '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]')
                        print(f"[PythonEngine] 🛡️ BREAKEVEN LOCKED: {sym} reached +{pnl_pct:.2f}% MFE, trailing SL to ₹{c['stopLoss']}")

            # 45-MINUTE MOMENTUM STAGNATION STOP (EXP007B):
            # If position active >= 45m and peak MFE < +0.35%, exit immediately.
            call_ts = c.get('timestamp') or (time.time() * 1000)
            elapsed_min = (time.time() - (call_ts / 1000.0)) / 60.0
            if elapsed_min >= 45.0 and float(c.get('mfePct', 0.0)) < 0.35:
                is_won = pts >= 0
                # NOT A WIN, NOT A LOSS — parity with liveMinuteEngine.js: only a level
                # decides a winner; a time exit closes the position and says why, and the
                # scorecard counts it as an exit without a level.
                c['status'] = 'CLOSED'
                c['exitPrice'] = live_price
                c['exitTimeIST'] = now_ist
                c['exitReason'] = 'STAGNATION_EXIT'
                c['grossPoints1Lot'] = round(pts, 2)
                c['netBps'] = round((pts / entry) * 10000.0 - 15.0, 1)
                c['netInr1Lot'] = net_inr_after_costs(pts, entry, c.get('shares'))
                c['note'] = (c.get('note', '') + f" [⏱️ 45M STAGNATION EXIT: Momentum faded (peak +{c.get('mfePct', 0.0):.2f}% MFE)]")
                self.closed_calls.append(c)
                changed = True
                print(f"[PythonEngine] ⏱️ STAGNATION EXIT: {sym} exited at {now_ist} after {elapsed_min:.0f}m (MFE: +{c.get('mfePct', 0.0):.2f}%)")
                self.notify_exit(c, won=is_won)
                continue

            # Target hit -> WON
            if (not is_short and live_price >= target) or (is_short and live_price <= target):
                c['status'] = 'WON'
                c['exitPrice'] = live_price
                c['exitTimeIST'] = now_ist
                c['exitReason'] = 'TARGET_HIT'
                c['grossPoints1Lot'] = round(pts, 2)
                c['netBps'] = round((pts / entry) * 10000.0 - 15.0, 1)
                c['netInr1Lot'] = net_inr_after_costs(pts, entry, c.get('shares'))
                self.closed_calls.append(c)
                changed = True
                print(f"[PythonEngine] 🎯 TARGET REACHED: {sym} WON +{pts:.2f} pts (+{pnl_pct:.2f}%) at {now_ist}")
                self.notify_exit(c, won=True)

            # Stop hit -> LOST or BREAKEVEN
            elif (not is_short and live_price <= stop) or (is_short and live_price >= stop):
                # A BREAKEVEN SCRATCH IS NOT A WIN — parity with liveMinuteEngine.js:
                # the lock closes the trade at its cost floor, so the status is CLOSED and
                # only a real stop is LOST.
                is_be = bool(c.get('breakevenArmed'))
                c['status'] = 'CLOSED' if is_be else 'LOST'
                c['exitPrice'] = live_price
                c['exitTimeIST'] = now_ist
                c['exitReason'] = 'BREAKEVEN_EXIT' if c.get('breakevenArmed') else 'STOP_LOSS_HIT'
                c['grossPoints1Lot'] = round(pts, 2)
                c['netBps'] = round((pts / entry) * 10000.0 - 15.0, 1)
                c['netInr1Lot'] = net_inr_after_costs(pts, entry, c.get('shares'))
                self.closed_calls.append(c)
                changed = True
                print(f"[PythonEngine] {'🛡️ BREAKEVEN SCRATCH' if is_be else '🛑 STOP LOSS HIT'}: {sym} {c['status']} {pts:.2f} pts ({pnl_pct:.2f}%) at {now_ist}")
                self.notify_exit(c, won=is_be)

        if changed:
            self.save_calls()

    def notify_exit(self, c: Dict[str, Any], won: bool):
        # THE TITLE COMES FROM THE EXIT, NOT FROM THE CALLER'S BOOLEAN — parity with
        # liveMinuteEngine.js. `won` was `pts >= 0` on a stagnation exit, so a time exit
        # carrying +0.01 pts was announced as "TARGET 1 REACHED (WON)" while the scorecard
        # on the same book called it an exit without a level.
        reason = str(c.get('exitReason') or '').upper()
        emoji = {"TARGET_HIT": "🎯", "STOP_LOSS_HIT": "🛑", "BREAKEVEN_EXIT": "🛡️",
                 "STAGNATION_EXIT": "⏱️", "SESSION_CLOSE": "📌"}.get(reason, "🎯" if won else "🛑")
        title = {"TARGET_HIT": "TARGET 1 REACHED (WON)", "STOP_LOSS_HIT": "STOP LOSS HIT (LOST)",
                 "BREAKEVEN_EXIT": "BREAKEVEN SCRATCH (CLOSED)",
                 "STAGNATION_EXIT": "45-MIN STAGNATION EXIT (CLOSED)",
                 "SESSION_CLOSE": "SESSION CLOSE (CLOSED)"}.get(
                     reason, "TARGET 1 REACHED (WON)" if won else "STOP LOSS HIT (CLOSED)")
        sign = lambda v: ("+" if float(v) >= 0 else "") + str(v)
        pts = c.get('grossPoints1Lot', 0.0)
        pnl_pct = c.get('livePnLPct', 0.0)
        net_inr = c.get('netInr1Lot', 0.0)
        msg = (
            f"{emoji} <b>{title}</b>\n\n"
            f"Symbol: <b>#{c.get('symbol')}</b>\n"
            f"Action: <b>{c.get('action')}</b>\n"
            f"Entry Price: ₹{float(c.get('limitEntry', 0)):.2f}\n"
            f"Exit Price: <b>₹{float(c.get('exitPrice', 0)):.2f}</b>\n"
            f"Result: <b>{sign(pts)} pts ({sign(pnl_pct)}%)</b>\n"
            f"Net P&L (net of 15 bps costs): <b>{sign(net_inr)}₹{net_inr:.2f}</b>\n"
            f"Exit Time: <b>{c.get('exitTimeIST')} IST</b>\n\n"
            f"<i>Live tracking active on http://localhost:4000/final</i>"
        )
        send_telegram(msg)

    def notify_new_call(self, c: Dict[str, Any]):
        entry = float(c.get('limitEntry', 0))
        target = float(c.get('target', 0))
        stop = float(c.get('stopLoss', 0))
        target_pct = ((target - entry) / entry * 100.0) if entry > 0 else 0.0
        stop_pct = ((entry - stop) / entry * 100.0) if entry > 0 else 0.0

        msg = (
            f"🚀 <b>NEW INSTITUTIONAL BUY CALL</b>\n\n"
            f"Symbol: <b>#{c.get('symbol')}</b>\n"
            f"Action: <b>{c.get('action')} / {c.get('side')}</b>\n"
            f"Entry: <b>₹{entry:.2f}</b>\n"
            f"Stop Loss: <b>₹{stop:.2f}</b> (-{stop_pct:.2f}% / -{c.get('riskBps')} bps)\n"
            f"Target 1: <b>₹{target:.2f}</b> (+{target_pct:.2f}% / +{c.get('targetBps')} bps)\n"
            f"Risk:Reward: <b>{c.get('riskReward')}</b>\n\n"
            f"<b>Institutional Confluence:</b>\n"
            f"• {c.get('note')}\n"
            f"• Time: <b>{c.get('timeIST')} IST</b>\n\n"
            f"<i>Live dashboard on http://localhost:4000/final</i>"
        )
        send_telegram(msg)

    def get_nifty_regime(self) -> Dict[str, Any]:
        nifty_bars = self.sym_bars.get('NIFTY') or self.sym_bars.get('NIFTY 50') or self.sym_bars.get('99926000')
        if not nifty_bars or len(nifty_bars) < 5:
            return {'regime': 'NEUTRAL', 'price': 0.0, 'vwap': 0.0, 'distPct': 0.0}
        cum_num, cum_den = 0.0, 0.0
        for b in nifty_bars:
            typ = (b['h'] + b['l'] + b['c']) / 3.0
            vol = b['v']
            cum_num += typ * vol
            cum_den += vol
        price = nifty_bars[-1]['c']
        # An INDEX feed carries no traded volume, so cum_den is always 0 for Nifty and
        # falling back to `price` made the regime permanently BULLISH (see the Node
        # twin). With nothing to weight by, use the TIME-weighted VWAP: the mean
        # typical price over the session, which a falling index reads below.
        time_vwap = sum((b['h'] + b['l'] + b['c']) / 3.0 for b in nifty_bars) / len(nifty_bars)
        vwap = (cum_num / cum_den) if cum_den > 0 else time_vwap
        dist_pct = ((price - vwap) / vwap) * 100.0
        day_low = min(b['l'] for b in nifty_bars)
        is_cascading = price <= (day_low * 1.0010)
        return {
            'regime': 'BULLISH' if price >= vwap else 'BEARISH',
            'price': price,
            'dayLow': round(day_low, 2),
            'isCascading': is_cascading,
            'vwap': round(vwap, 2),
            'distPct': round(dist_pct, 2)
        }

    def scan_all_stocks(self):
        now_dt = datetime.now(IST)
        minute_ist = now_dt.hour * 60 + now_dt.minute
        if minute_ist >= 14 * 60 + 45:
            return  # Arming cutoff: stop issuing new calls after 14:45 IST

        nifty = self.get_nifty_regime()
        is_nifty_bearish = nifty['regime'] == 'BEARISH'
        is_nifty_cascading = nifty.get('isCascading', False)
        if is_nifty_cascading:
            print(f"[PythonEngine] ⚠️ Nifty is cascading at Day Low (₹{nifty['price']} <= LOD ₹{nifty.get('dayLow')}). Long setups HARD-LOCKED.")

        active_symbols = {c.get('symbol') for c in self.calls.values() if c.get('status') == 'ARMED'}
        current_ist = get_ist_time_str()
        candidates = []

        for sym, bars in self.sym_bars.items():
            if not bars or len(bars) < 15 or sym in active_symbols:
                continue

            current_bar = bars[-1]
            price = current_bar['c']
            if price <= 0:
                continue

            # VWAP & Range
            cum_num, cum_den = 0.0, 0.0
            day_high, day_low = -float('inf'), float('inf')
            for b in bars:
                typ = (b['h'] + b['l'] + b['c']) / 3.0
                vol = b['v']
                cum_num += typ * vol
                cum_den += vol
                if b['h'] > day_high:
                    day_high = b['h']
                if b['l'] < day_low:
                    day_low = b['l']

            vwap = (cum_num / cum_den) if cum_den > 0 else price
            vwap_dist_pct = ((price - vwap) / vwap) * 100.0
            first_price = bars[0]['o'] or price
            day_change_pct = ((price - first_price) / first_price) * 100.0

            # Delta ratio in recent 5 bars
            recent5 = bars[-5:]
            delta5 = sum(b['delta'] for b in recent5)
            vol5 = sum(b['v'] for b in recent5)
            delta_ratio = (delta5 / vol5) if vol5 > 0 else 0.0

            # Volume surge vs baseline
            prior_bars = bars[:-5]
            avg_vol = (sum(b['v'] for b in prior_bars) / len(prior_bars)) if prior_bars else (vol5 / 5.0)
            cur_vol = vol5 / 5.0
            vol_surge = (cur_vol / avg_vol) if avg_vol > 0 else 1.0

            # BULLISH FVG — structural (zone + F1 quality + F3 liveness).
            bull_fvg = find_fvg(bars, 1)
            has_bullish_fvg = bool(bull_fvg and bull_fvg['live'])

            # Liquidity sweep (SSL sweep)
            has_sweep = False
            if len(bars) >= 25:
                swing_low = min(b['l'] for b in bars[-25:-5])
                if any(b['l'] < swing_low for b in bars[-5:]) and price > swing_low:
                    has_sweep = True

            # Anti-Climax Guard
            recent_atr = sum(b['h'] - b['l'] for b in bars[-8:]) / 8.0
            is_climax = (current_bar['h'] - current_bar['l'] > recent_atr * 2.5) and (price >= day_high * 0.998)

            confluence = (1 if has_bullish_fvg else 0) + (1 if has_sweep else 0) + (1 if vol_surge > 1.3 else 0) + (1 if delta_ratio > 0.15 else 0)

            # 1. Trend Alignment (20/50 EMA on 1-min bars)
            ema20 = bars[0]['c']
            ema50 = bars[0]['c']
            k20 = 2.0 / 21.0
            k50 = 2.0 / 51.0
            for b in bars[1:]:
                bc = b['c']
                ema20 = bc * k20 + ema20 * (1.0 - k20)
                ema50 = bc * k50 + ema50 * (1.0 - k50)
            is_long_trend_valid = price >= ema20 and ema20 >= ema50
            is_short_trend_valid = price <= ema20 and ema20 <= ema50

            # 2. Fibonacci Premium / Discount Equilibrium
            day_range = day_high - day_low
            fib_equilibrium = day_low + 0.50 * day_range
            is_long_fib_valid = price <= fib_equilibrium
            is_short_fib_valid = price >= fib_equilibrium

            # 3. Volume Point of Control (POC) Buffer
            tick_poc = 0.10
            bins = {}
            for b in bars:
                v = b['v']
                if v <= 0 or b['h'] < b['l']:
                    continue
                lo = math.floor(b['l'] / tick_poc) * tick_poc
                hi = math.ceil(b['h'] / tick_poc) * tick_poc
                steps = max(1, round((hi - lo) / tick_poc) + 1)
                per = v / steps
                p_cur = lo
                while p_cur <= hi + 1e-9:
                    k_str = f"{p_cur:.2f}"
                    bins[k_str] = bins.get(k_str, 0.0) + per
                    p_cur += tick_poc
            poc = None
            max_vol = -1.0
            for k_str, vol_val in bins.items():
                if vol_val > max_vol:
                    max_vol = vol_val
                    poc = float(k_str)
            dist_to_poc_bps = (((price - poc) / price) * 10000.0) if poc else 0.0
            is_poc_short_blocked = poc is not None and poc < price and dist_to_poc_bps <= 25.0
            is_poc_long_blocked = poc is not None and poc > price and abs(dist_to_poc_bps) <= 25.0

            # High-probability buy setup rules: Nifty beta gate & cascade lock
            required_confluence = 3 if is_nifty_bearish else 2
            min_delta = 0.15 if is_nifty_bearish else 0.05

            # Order book depth & Spread gate
            book_now = self.book.get(sym)
            book_age_ms = (int(time.time() * 1000) - book_now['t']) if book_now else float('inf')
            depth_fresh = book_now is not None and book_age_ms <= self.depth_max_age_ms
            book_bidq = book_now['bidq'] if book_now else 0
            book_askq = book_now['askq'] if book_now else 0

            spread_bps = 0.0
            if book_now and book_now['bid'] > 0 and book_now['ask'] > 0:
                spread_bps = ((book_now['ask'] - book_now['bid']) / book_now['bid']) * 10000.0
            blocked_by_spread = depth_fresh and self.max_spread_bps > 0 and spread_bps > self.max_spread_bps

            ask_wall_ratio = (book_askq / book_bidq) if book_bidq > 0 else (float('inf') if book_askq > 0 else 0.0)
            bid_wall_ratio = (book_bidq / book_askq) if book_askq > 0 else (float('inf') if book_bidq > 0 else 0.0)
            is_absorbing_wall = delta_ratio >= 0.15 and vol_surge >= 1.8
            blocked_by_ask_wall = self.ask_wall_ratio_min > 0 and depth_fresh and ask_wall_ratio >= self.ask_wall_ratio_min and not is_absorbing_wall
            is_absorbing_bid_wall = delta_ratio <= -0.15 and vol_surge >= 1.8
            blocked_by_bid_wall = self.ask_wall_ratio_min > 0 and depth_fresh and bid_wall_ratio >= self.ask_wall_ratio_min and not is_absorbing_bid_wall

            # Direction-Aware Midday Long Filter (EXP010):
            # 12:30-13:45 IST produces severe drag for Longs (-30.8 bps), while Shorts earn (+8.8 bps).
            is_midday_long_window = (12 * 60 + 30) <= minute_ist < (13 * 60 + 45)

            # Invalidation Gates Check:
            long_gates_passed = not self.strict_invalidation or (is_long_trend_valid and is_long_fib_valid and not is_poc_long_blocked)

            if self.long_enabled and long_gates_passed and not is_midday_long_window and not is_nifty_cascading and not blocked_by_spread and not blocked_by_ask_wall and not is_climax and price > vwap and 0.05 <= vwap_dist_pct <= 0.85 and day_change_pct > 0.3 and delta_ratio >= min_delta and confluence >= required_confluence:
                stop_bps = max(45, min(55, round((abs(vwap_dist_pct) + 0.25) * 100)))
                stop_loss = round(price * (1.0 - stop_bps / 10000.0), 2)
                target_bps = round(stop_bps * 1.50)  # Mandate: R:R <= 1:1.50
                target = round(price * (1.0 + target_bps / 10000.0), 2)
                risk_pts = round(price - stop_loss, 2)
                reward_pts = round(target - price, 2)

                candidates.append({
                    'symbol': sym,
                    'action': 'BUY',
                    'side': 'LONG',
                    'limitEntry': price,
                    'stopLoss': stop_loss,
                    'target': target,
                    'riskPts': risk_pts,
                    'rewardPts': reward_pts,
                    'riskBps': stop_bps,
                    'targetBps': target_bps,
                    'riskReward': f"1 : {(reward_pts / risk_pts):.2f}",
                    'vwap': round(vwap, 2),
                    'volSurge': round(vol_surge, 2),
                    'deltaRatio': f"{delta_ratio * 100:.1f}%",
                    'spreadBps': round(spread_bps, 1),
                    'hasBullishFvg': has_bullish_fvg,
                    'hasSweep': has_sweep,
                    'invalidationGates': {
                        'trend': 'EMA_ALIGNED' if is_long_trend_valid else 'COUNTER_TREND',
                        'fib': 'DISCOUNT_ZONE' if is_long_fib_valid else 'PREMIUM_TRAP',
                        'poc': 'OVERHEAD_POC' if is_poc_long_blocked else 'POC_CLEAR',
                        'sweep': 'SSL_SWEPT' if has_sweep else 'NONE',
                        'fvg': 'BULLISH_FVG' if has_bullish_fvg else 'NONE',
                        'delta': f"{delta_ratio * 100:.1f}%"
                    },
                    'score': confluence * 10 + min(vol_surge, 5.0)
                })

            # Short setup evaluation (Sell-side institutional momentum)
            # BEARISH FVG with its zone, then the two entry-state rules (F2, F4).
            fvg_decision = fvg_short_gate(bars, price)
            bear_fvg = fvg_decision['gap']
            fvg_gate = fvg_decision['gate']
            has_bearish_fvg = fvg_gate == 'BEARISH_FVG_CE'
            fvg_short_ok = not (FVG_STRUCTURAL and FVG_REQUIRE) or has_bearish_fvg

            has_bsl_sweep = False
            if len(bars) >= 25:
                swing_high = max(b['h'] for b in bars[-25:-5])
                if any(b['h'] > swing_high for b in bars[-5:]) and price < swing_high:
                    has_bsl_sweep = True

            is_dump_climax = (current_bar['h'] - current_bar['l'] > recent_atr * 2.5) and (price <= day_low * 1.002)
            bear_confluence = (1 if has_bearish_fvg else 0) + (1 if has_bsl_sweep else 0) + (1 if vol_surge > 1.3 else 0) + (1 if delta_ratio < -0.15 else 0)

            short_gates_passed = not self.strict_invalidation or (is_short_trend_valid and is_short_fib_valid and not is_poc_short_blocked)

            if short_gates_passed and fvg_short_ok and not blocked_by_spread and not blocked_by_bid_wall and not is_dump_climax and price < vwap and -0.85 <= vwap_dist_pct <= -0.05 and day_change_pct < -0.3 and delta_ratio < -0.05 and bear_confluence >= 2:
                stop_bps = max(45, min(55, round((abs(vwap_dist_pct) + 0.25) * 100)))
                stop_loss = round(price * (1.0 + stop_bps / 10000.0), 2)
                target_bps = min(round(self.short_target_bps), round(stop_bps * 1.50))  # Mandate: R:R <= 1:1.50
                target = round(price * (1.0 - target_bps / 10000.0), 2)
                risk_pts = round(stop_loss - price, 2)
                reward_pts = round(price - target, 2)

                candidates.append({
                    'symbol': sym,
                    'action': 'SELL',
                    'side': 'SHORT',
                    'limitEntry': price,
                    'stopLoss': stop_loss,
                    'target': target,
                    'riskPts': risk_pts,
                    'rewardPts': reward_pts,
                    'riskBps': stop_bps,
                    'targetBps': target_bps,
                    'riskReward': f"1 : {(reward_pts / risk_pts):.2f}",
                    'vwap': round(vwap, 2),
                    'volSurge': round(vol_surge, 2),
                    'deltaRatio': f"{delta_ratio * 100:.1f}%",
                    'hasBullishFvg': False,
                    'hasSweep': has_bsl_sweep,
                    'hasBearishFvg': has_bearish_fvg,
                    'invalidationGates': {
                        'trend': 'EMA_ALIGNED' if is_short_trend_valid else 'COUNTER_TREND',
                        'fib': 'PREMIUM_ZONE' if is_short_fib_valid else 'DISCOUNT_TRAP',
                        'poc': 'SUPPORT_POC' if is_poc_short_blocked else 'POC_CLEAR',
                        'sweep': 'BSL_SWEPT' if has_bsl_sweep else 'NONE',
                        'fvg': fvg_gate,
                        'fvgZone': bear_fvg,
                        'fvgBlocked': not fvg_short_ok,
                        'delta': f"{delta_ratio * 100:.1f}%"
                    },
                    'score': bear_confluence * 10 + min(vol_surge, 5.0)
                })

        candidates.sort(key=lambda x: (x['score'], x['volSurge']), reverse=True)

        active_count = sum(1 for c in self.calls.values() if c.get('status') == 'ARMED')
        slots = max(0, 6 - active_count)

        if slots > 0 and candidates:
            selected = candidates[:slots]
            for s in selected:
                call_id = f"CALL-{s['symbol']}-{self.today}-{str(len(self.calls) + 1).zfill(3)}"
                new_call = {
                    'id': call_id,
                    'date': self.today,
                    'timeIST': current_ist,
                    'timestamp': int(time.time() * 1000),
                    'symbol': s['symbol'],
                    'side': s['side'],
                    'action': s['action'],
                    'strategyType': 'INTRADAY',
                    'limitEntry': s['limitEntry'],
                    'stopLoss': s['stopLoss'],
                    'target': s['target'],
                    'riskPts': s['riskPts'],
                    'rewardPts': s['rewardPts'],
                    'riskBps': s['riskBps'],
                    'targetBps': s['targetBps'],
                    'riskReward': s['riskReward'],
                    'shares': max(1, math.floor(POSITION_NOTIONAL / float(s['limitEntry']))),
                    'notional': round(max(1, math.floor(POSITION_NOTIONAL / float(s['limitEntry']))) * float(s['limitEntry']), 2),
                    'status': 'ARMED',
                    'marketBreadth': 'BULLISH_CONFLUENCE',
                    'sectorBreadth': 'INSTITUTIONAL_MOMENTUM',
                    'fillPrice': s['limitEntry'],
                    'entryTimeIST': current_ist,
                    'exitPrice': None,
                    'exitTimeIST': None,
                    'exitReason': None,
                    'grossPoints1Lot': None,
                    'netBps': None,
                    'netInr1Lot': 0.0,
                    'note': f"{'FVG Support + ' if s['hasBullishFvg'] else ''}Vol Surge {s['volSurge']}x + Delta {s['deltaRatio']}. Target +{s['targetBps']/100:.2f}% (+{s['targetBps']} bps) net of taxes.",
                    'ltp': s['limitEntry'],
                    'livePoints': 0.0,
                    'livePnLPct': 0.0,
                    'livePnLVal': 0.0
                }
                self.calls[call_id] = new_call
                print(f"[PythonEngine] 🚀 NEW CALL DISPATCHED ({current_ist}): {new_call['symbol']} BUY @ ₹{new_call['limitEntry']} (T1: ₹{new_call['target']} | SL: ₹{new_call['stopLoss']})")
                self.notify_new_call(new_call)

            self.save_calls()

    def get_daily_net(self) -> Dict[str, Any]:
        all_calls = list(self.calls.values())
        closed = self.closed_calls
        won = [c for c in closed if c.get('status') == 'WON']
        lost = [c for c in closed if c.get('status') == 'LOST']
        # ARMED + FILLED + OPEN are all positions (parity with liveMinuteEngine.js):
        # counting only ARMED dropped every call whose entry had actually traded out of
        # the day's total while it was still open on the page.
        active = [c for c in all_calls if c.get('status') in ('ARMED', 'FILLED', 'OPEN')]

        closed_pts = sum(float(c.get('grossPoints1Lot') or 0.0) for c in closed)
        closed_inr = sum(float(c.get('netInr1Lot') or 0.0) for c in closed)

        active_pts = sum(float(c.get('livePoints') or 0.0) for c in active)
        active_inr = sum(float(c.get('netInr1Lot') or 0.0) for c in active)

        total_inr = round(closed_inr + active_inr, 2)
        total_pts = round(closed_pts + active_pts, 2)
        # THE ONE WIN RULE (parity with common/market/callBookHistory.tallyOutcomes): a
        # WIN is a target hit and a LOSS a stop hit; exits that touched neither level are
        # NOT in the denominator, and an empty sample reports null — never 0 or 100.
        decided = [c for c in closed if c.get('status') in ('WON', 'LOST')]
        win_rate = round((len(won) / len(decided) * 100.0), 1) if decided else None

        return {
            'date': self.today,
            'measured': True,
            'totalRecommendations': len(all_calls),
            'totalCalls': len(all_calls),
            'activeCalls': len(active),
            'closedCalls': len(closed),
            'won': len(won),
            'lost': len(lost),
            'winRatePct': win_rate,
            'positiveCalls': len(won) + sum(1 for c in active if float(c.get('livePnLPct') or 0.0) >= 0.0),
            'closedNetInr': round(closed_inr, 2),
            'activeNetInr': round(active_inr, 2),
            'totalNetInr': total_inr,
            'totalPoints': total_pts,
            'isNetPositive': total_inr >= 0,
            'verdict': f"NET POSITIVE (+₹{abs(total_inr):.2f})" if total_inr >= 0 else f"NET NEGATIVE (-₹{abs(total_inr):.2f})",
            'note': f"Live measured today: {len(won)} WON, {len(lost)} LOST, {len(active)} ACTIVE out of {len(all_calls)} calls"
        }

    def run_live_loop(self):
        """Continuously reads ticks from the live tape file and performs 60s scans."""
        tape_file = os.path.join(DATA_DIR, f"ticks-{self.today}.jsonl")
        print(f"[PythonEngine] Starting continuous tape tailing on: {tape_file}")

        file_pos = 0
        if os.path.exists(tape_file):
            print("[PythonEngine] Pre-loading existing ticks...")
            with open(tape_file, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        try:
                            self.ingest_tick(json.loads(line), live=False)
                        except Exception:
                            pass
                file_pos = f.tell()
            print(f"[PythonEngine] Pre-loaded session bars across {len(self.sym_bars)} stocks.")

        # Initial scan
        self.scan_all_stocks()
        self.last_scan_time = time.time()

        print("[PythonEngine] Running live sub-second tick loop...")
        while True:
            try:
                # Check for new ticks
                if os.path.exists(tape_file):
                    with open(tape_file, 'r', encoding='utf-8') as f:
                        f.seek(file_pos)
                        new_lines = f.readlines()
                        file_pos = f.tell()

                        for line in new_lines:
                            line = line.strip()
                            if line:
                                try:
                                    t = json.loads(line)
                                    self.ingest_tick(t, live=True)
                                except Exception:
                                    pass

                # Scan every 60 seconds
                now = time.time()
                if now - self.last_scan_time >= 60.0:
                    self.scan_all_stocks()
                    self.last_scan_time = now

                time.sleep(0.5)
            except KeyboardInterrupt:
                break
            except Exception as e:
                print(f"[PythonEngine] Loop error: {e}", file=sys.stderr)
                time.sleep(1.0)


if __name__ == '__main__':
    engine = LiveInstitutionalEngine()
    engine.run_live_loop()

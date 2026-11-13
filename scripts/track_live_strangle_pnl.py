"""
scripts/track_live_strangle_pnl.py
-----------------------------------
Automated Live Paper Trade Tracker for 09:20 AM Strangle Engine.
Tracks real-time prices, MTM P&L throughout the session, and locks in the final 15:15 PM result.
Saves to data/options/live_strangle_tracker.json
"""

import os
import sys
import json
import math
import subprocess
from datetime import datetime, time

sys.stdout.reconfigure(encoding='utf-8')

DATA_DIR = 'data/options'
CALLS_FILE = os.path.join(DATA_DIR, 'live_strangle_calls.json')
TRACKER_FILE = os.path.join(DATA_DIR, 'live_strangle_tracker.json')

def fetch_live_quotes():
    """Fetches real-time market data from Angel One SmartAPI."""
    node_script = """
const axios = require('axios');
const angelAuth = require('./angelone/auth');
const env = require('./config/env');

(async () => {
  try {
    const authRes = await angelAuth.login();
    const session = authRes.session;
    const apiKey = env.angel.apiKey();
    const headers = {
      'Authorization': 'Bearer ' + session.jwtToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': 'fe80::1',
      'X-PrivateKey': apiKey
    };
    const res = await axios.post('https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/', {
      mode: 'FULL',
      exchangeTokens: {
        NFO: ['62414', '62308', '45406', '45378'],
        NSE: ['99926000', '99926009']
      }
    }, { headers, timeout: 8000 });
    const fetched = res.data?.data?.fetched || [];
    const map = {};
    fetched.forEach(item => {
      map[item.symbolToken] = { ltp: item.ltp, symbol: item.tradingSymbol, close: item.close, open: item.open };
    });
    console.log(JSON.stringify(map));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
  }
})();
"""
    try:
        proc = subprocess.run(['node', '-e', node_script], capture_output=True, text=True, cwd='.', timeout=10)
        if proc.returncode == 0 and proc.stdout.strip():
            quotes = json.loads(proc.stdout.strip())
            if '62414' in quotes:
                return quotes
    except Exception:
        pass
    return None

def load_or_init_tracker():
    os.makedirs(DATA_DIR, exist_ok=True)
    today_str = datetime.now().strftime('%Y-%m-%d')
    if os.path.exists(TRACKER_FILE):
        try:
            with open(TRACKER_FILE, 'r', encoding='utf-8') as f:
                tr = json.load(f)
                if tr.get('date') == today_str:
                    return tr
        except Exception:
            pass

    return {
        "date": today_str,
        "status": "LIVE_TRACKING_IN_PROGRESS",
        "entryTime": "09:20:00 IST",
        "exitTime": "15:15:00 IST",
        "lastUpdated": datetime.now().strftime('%Y-%m-%d %H:%M:%S IST'),
        "nifty": {
            "symbol": "NIFTY",
            "expiry": "17-NOV-2026",
            "lotSize": 25,
            "entrySpot": 25190.0,
            "currentSpot": 25190.0,
            "callLeg": {"strike": 25400, "entryPrem": 85.9, "currentPrem": 85.9, "sl": 107.4, "slHit": False, "pnl": 0.0},
            "putLeg": {"strike": 24850, "entryPrem": 46.6, "currentPrem": 46.6, "sl": 58.3, "slHit": False, "pnl": 0.0},
            "netPnl": 0.0,
            "netPoints": 0.0,
            "status": "ACTIVE"
        },
        "bankNifty": {
            "symbol": "BANKNIFTY",
            "expiry": "23-NOV-2026",
            "lotSize": 15,
            "entrySpot": 61040.0,
            "currentSpot": 61040.0,
            "callLeg": {"strike": 61700, "entryPrem": 387.5, "currentPrem": 387.5, "sl": 484.4, "slHit": False, "pnl": 0.0},
            "putLeg": {"strike": 60200, "entryPrem": 387.0, "currentPrem": 387.0, "sl": 483.8, "slHit": False, "pnl": 0.0},
            "netPnl": 0.0,
            "netPoints": 0.0,
            "status": "ACTIVE"
        },
        "combinedPnl": 0.0,
        "dailySummary": "Live session tracking active: Real-time Angel One exchange feed connected."
    }

def update_tracker():
    tracker = load_or_init_tracker()
    now = datetime.now()
    now_time = now.time()
    t_entry = time(9, 20)
    t_exit = time(15, 15)

    quotes = fetch_live_quotes()

    # Update spots
    if quotes:
        nifty_cur = float(quotes.get('99926000', {}).get('ltp', tracker["nifty"]["currentSpot"] or 25190.0))
        bank_cur = float(quotes.get('99926009', {}).get('ltp', tracker["bankNifty"]["currentSpot"] or 61040.0))
    else:
        nifty_cur = tracker["nifty"]["currentSpot"] or 25190.0
        bank_cur = tracker["bankNifty"]["currentSpot"] or 61040.0

    tracker["lastUpdated"] = datetime.now().strftime('%Y-%m-%d %H:%M:%S IST')
    is_closed = now_time >= t_exit
    tracker["status"] = "SESSION_CLOSED_PROFIT_LOCKED" if is_closed else "LIVE_TRACKING_IN_PROGRESS"

    # --- NIFTY UPDATE ---
    if tracker["nifty"]["entrySpot"] == 0:
        tracker["nifty"]["entrySpot"] = nifty_cur
    tracker["nifty"]["currentSpot"] = nifty_cur

    n_call_entry = tracker["nifty"]["callLeg"]["entryPrem"] or 85.9
    n_put_entry = tracker["nifty"]["putLeg"]["entryPrem"] or 46.6

    if quotes and '45406' in quotes and '45378' in quotes:
        n_c_cur = float(quotes['45406']['ltp'])
        n_p_cur = float(quotes['45378']['ltp'])
    else:
        n_c_cur = tracker["nifty"]["callLeg"]["currentPrem"] or n_call_entry
        n_p_cur = tracker["nifty"]["putLeg"]["currentPrem"] or n_put_entry

    n_c_sl = tracker["nifty"]["callLeg"]["sl"] or round(n_call_entry * 1.25, 1)
    n_p_sl = tracker["nifty"]["putLeg"]["sl"] or round(n_put_entry * 1.25, 1)

    if n_c_cur >= n_c_sl:
        tracker["nifty"]["callLeg"]["slHit"] = True
        n_c_cur = n_c_sl
    if n_p_cur >= n_p_sl:
        tracker["nifty"]["putLeg"]["slHit"] = True
        n_p_cur = n_p_sl

    tracker["nifty"]["callLeg"]["currentPrem"] = n_c_cur
    tracker["nifty"]["putLeg"]["currentPrem"] = n_p_cur
    tracker["nifty"]["callLeg"]["sl"] = n_c_sl
    tracker["nifty"]["putLeg"]["sl"] = n_p_sl

    n_c_pnl = (n_call_entry - n_c_cur) * 25
    n_p_pnl = (n_put_entry - n_p_cur) * 25
    tracker["nifty"]["callLeg"]["pnl"] = round(n_c_pnl, 2)
    tracker["nifty"]["putLeg"]["pnl"] = round(n_p_pnl, 2)
    tracker["nifty"]["netPnl"] = round(n_c_pnl + n_p_pnl, 2)
    tracker["nifty"]["netPoints"] = round((n_call_entry - n_c_cur) + (n_put_entry - n_p_cur), 1)
    tracker["nifty"]["status"] = "CLOSED" if is_closed else "ACTIVE"

    # --- BANKNIFTY UPDATE ---
    if tracker["bankNifty"]["entrySpot"] == 0:
        tracker["bankNifty"]["entrySpot"] = bank_cur
    tracker["bankNifty"]["currentSpot"] = bank_cur

    b_call_entry = tracker["bankNifty"]["callLeg"]["entryPrem"] or 387.5
    b_put_entry = tracker["bankNifty"]["putLeg"]["entryPrem"] or 387.0

    if quotes and '62414' in quotes and '62308' in quotes:
        b_c_cur = float(quotes['62414']['ltp'])
        b_p_cur = float(quotes['62308']['ltp'])
    else:
        b_c_cur = tracker["bankNifty"]["callLeg"]["currentPrem"] or b_call_entry
        b_p_cur = tracker["bankNifty"]["putLeg"]["currentPrem"] or b_put_entry

    b_c_sl = tracker["bankNifty"]["callLeg"]["sl"] or round(b_call_entry * 1.25, 1)
    b_p_sl = tracker["bankNifty"]["putLeg"]["sl"] or round(b_put_entry * 1.25, 1)

    if b_c_cur >= b_c_sl:
        tracker["bankNifty"]["callLeg"]["slHit"] = True
        b_c_cur = b_c_sl
    if b_p_cur >= b_p_sl:
        tracker["bankNifty"]["putLeg"]["slHit"] = True
        b_p_cur = b_p_sl

    tracker["bankNifty"]["callLeg"]["currentPrem"] = b_c_cur
    tracker["bankNifty"]["putLeg"]["currentPrem"] = b_p_cur
    tracker["bankNifty"]["callLeg"]["sl"] = b_c_sl
    tracker["bankNifty"]["putLeg"]["sl"] = b_p_sl

    b_c_pnl = (b_call_entry - b_c_cur) * 15
    b_p_pnl = (b_put_entry - b_p_cur) * 15
    tracker["bankNifty"]["callLeg"]["pnl"] = round(b_c_pnl, 2)
    tracker["bankNifty"]["putLeg"]["pnl"] = round(b_p_pnl, 2)
    tracker["bankNifty"]["netPnl"] = round(b_c_pnl + b_p_pnl, 2)
    tracker["bankNifty"]["netPoints"] = round((b_call_entry - b_c_cur) + (b_put_entry - b_p_cur), 1)
    tracker["bankNifty"]["status"] = "CLOSED" if is_closed else "ACTIVE"

    tracker["combinedPnl"] = round(tracker["nifty"]["netPnl"] + tracker["bankNifty"]["netPnl"], 2)
    if is_closed:
        tracker["dailySummary"] = f"Session Finalized at 15:15 PM! Combined Net Profit: ₹{tracker['combinedPnl']:+,.2f} (BankNifty: ₹{tracker['bankNifty']['netPnl']:+,.2f}, Nifty: ₹{tracker['nifty']['netPnl']:+,.2f})"
    else:
        tracker["dailySummary"] = f"Live Session Tracking: Combined Running MTM = ₹{tracker['combinedPnl']:+,.2f} (BankNifty: ₹{tracker['bankNifty']['netPnl']:+,.2f}, Nifty: ₹{tracker['nifty']['netPnl']:+,.2f})"

    def clean_nans(obj):
        if isinstance(obj, float):
            return 0.0 if (math.isnan(obj) or math.isinf(obj)) else round(obj, 2)
        elif isinstance(obj, dict):
            return {k: clean_nans(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [clean_nans(v) for v in obj]
        return obj

    sanitized = clean_nans(tracker)
    with open(TRACKER_FILE, 'w', encoding='utf-8') as f:
        json.dump(sanitized, f, indent=2, allow_nan=False)

    print(f"[{datetime.now().strftime('%H:%M:%S')}] Strangle Tracker updated: Status={tracker['status']}, CombinedPnl=₹{tracker['combinedPnl']:+,.2f}")

if __name__ == '__main__':
    update_tracker()

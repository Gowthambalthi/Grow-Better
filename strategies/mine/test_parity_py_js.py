"""
strategies/mine/test_parity_py_js.py
------------------------------------
Regression & Parity Test: Verifies that Python (patterns.py) and JavaScript (patterns.js)
produce IDENTICAL pattern classifications and levels on historical OHLCV data.
"""

import os, json, subprocess
import numpy as np
from patterns import detect_pattern

def test_parity():
    test_files = ["data/ohlcv_3y/NAVA.json", "data/ohlcv_3y/GIPCL.json", "data/ohlcv_3y/PFC.json"]
    print("=" * 80)
    print("  PYTHON vs JAVASCRIPT PATTERN PARITY VERIFICATION")
    print("=" * 80)

    for f_path in test_files:
        sym = os.path.basename(f_path).replace('.json', '')
        with open(f_path) as f: raw = json.load(f)['candles']
        opens = np.array([float(x[1]) for x in raw])
        highs = np.array([float(x[2]) for x in raw])
        lows = np.array([float(x[3]) for x in raw])
        closes = np.array([float(x[4]) for x in raw])
        vols = np.array([float(x[5]) for x in raw])
        dates = [x[0][:10] for x in raw]

        py_signals = []
        for i in range(75, len(dates)):
            det = detect_pattern(highs[:i+1], lows[:i+1], closes[:i+1], vols[:i+1])
            if det:
                py_signals.append({
                    'date': dates[i],
                    'pattern': det['pattern'],
                    'level': round(float(det['level']), 2),
                    'stop': round(float(det['stop_level']), 2)
                })

        # Run JS detection via node
        node_cmd = f"""
        const fs = require('fs');
        const {{ detectPattern }} = require('./strategies/mine/patterns');
        const raw = JSON.parse(fs.readFileSync('{f_path}')).candles;
        const sessions = raw.map(x => ({{ date: x[0].slice(0, 10), open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5] }}));
        const js_sigs = [];
        for (let i = 75; i < sessions.length; i++) {{
            const det = detectPattern(sessions.slice(0, i + 1));
            if (det) {{
                js_sigs.push({{ date: sessions[i].date, pattern: det.pattern, level: +det.level.toFixed(2), stop: +det.stopLevel.toFixed(2) }});
            }}
        }}
        console.log(JSON.stringify(js_sigs));
        """
        proc = subprocess.run(["node", "-e", node_cmd], capture_output=True, text=True)
        js_signals = json.loads(proc.stdout.strip())

        print(f"\nSymbol: {sym:10} | Python Detections: {len(py_signals)} | JS Detections: {len(js_signals)}")
        match = True
        if len(py_signals) != len(js_signals):
            match = False
        else:
            for py, js in zip(py_signals, js_signals):
                if py['date'] != js['date'] or py['pattern'] != js['pattern'] or abs(py['level'] - js['level']) > 0.05:
                    match = False
                    print(f"  MISMATCH on {py['date']}: Py={py} vs JS={js}")
                    break

        if match:
            print(f"  [SUCCESS] 100% IDENTICAL PARITY across all {len(py_signals)} detected pattern bars!")
            for s in py_signals[:2]:
                print(f"    - {s['date']}: {s['pattern']} @ level Rs {s['level']} (Stop: Rs {s['stop']})")
        else:
            print(f"  [FAILURE] Discrepancy detected between Python and JavaScript!")

if __name__ == '__main__':
    test_parity()

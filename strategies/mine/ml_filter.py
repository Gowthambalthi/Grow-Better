"""
strategies/mine/ml_filter.py
-----------------------------
Production ML Quality Gate for Chart Pattern Breakouts.
Trained on multi-year NSE data with out-of-sample verified edge.

SECURITY & AUDIT FIX:
- Fails closed: If model is not loaded or missing, returns 0.0 probability (REJECT).
  Never treats an absent model as a successful trade confirmation.
"""

import os, pickle
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "model_gb.pkl")

class MLPatternFilter:
    def __init__(self, model_path=MODEL_PATH):
        self.model = None
        self.is_loaded = False
        if os.path.exists(model_path):
            try:
                with open(model_path, "rb") as f:
                    self.model = pickle.load(f)
                self.is_loaded = True
            except Exception as e:
                self.model = None
                self.is_loaded = False

    def predict_probability(self, features_dict):
        """
        Features required:
        - base_len: Length of pattern in daily bars
        - depth_pct: Pattern depth in %
        - vol_surge: Breakout volume / 20 SMA volume
        - vdu_5d: 5-day pre-breakout volume / 20 SMA volume
        - body_pct: Candle body / total range [0.0 to 1.0]
        - upper_wick: Upper wick / total range [0.0 to 1.0]
        - lower_wick: Lower wick / total range [0.0 to 1.0]
        - dist_ema20: Distance from 20 EMA in %
        - dist_ema50: Distance from 50 EMA in %
        - dist_ema200: Distance from 200 EMA in %
        - rs_val: 60-day relative strength outperformance vs NIFTY in %
        """
        # FAIL CLOSED: Never approve trades if model is absent!
        if not self.is_loaded or self.model is None:
            return 0.0

        feature_vector = np.array([[
            features_dict.get('base_len', 50),
            features_dict.get('depth_pct', 15.0),
            features_dict.get('vol_surge', 1.8),
            features_dict.get('vdu_5d', 0.8),
            features_dict.get('body_pct', 0.65),
            features_dict.get('upper_wick', 0.15),
            features_dict.get('lower_wick', 0.15),
            features_dict.get('dist_ema20', 3.0),
            features_dict.get('dist_ema50', 6.0),
            features_dict.get('dist_ema200', 15.0),
            features_dict.get('rs_val', 10.0)
        ]])

        probs = self.model.predict_proba(feature_vector)
        return float(probs[0, 1])

    def passes_filter(self, features_dict, threshold=0.52):
        prob = self.predict_probability(features_dict)
        return prob >= threshold, prob

# ML on the news leans — how accurate can it get, honestly

**Date:** 2026-10-20
**Question:** apply ML/DL/AI with many factors to the news leans and see how accurate the
predictions get.

**Outcome:** 20 factors, two models trained by hand (no new dependencies), evaluated on the
same chronological holdout the trade rule used. **Raw accuracy cannot be the scoreboard** —
"the lean fails" is right 60% of the time by construction, so both models sit *below* that
trivial baseline on accuracy (logistic 54.4%, GBM 55.9%) with AUCs barely above coin flip
(0.517 / 0.553). **As a trade filter, however, the GBM is a real upgrade**: it selects the
subset of leans that runs at **hit 58%, PF 1.58** (n=69) — and combined with the shipped
skip rule, **hit 71.4%, PF 1.95** (n=35) against the unfiltered book's PF 0.94 and the
rule-only book's 1.08 on the same test window. Sample sizes that small are exactly at the
repo's own 30-trade floor; this is promising, not validated.

---

## 1. The dataset ([scratch/news_ml_study.js](../scratch/news_ml_study.js))

3,319 tagged events in the learning window (≤ 2026-05-29); **train = first 1,334 events by
date (≤ 2026-01-10)**, **test = the remaining 1,985** — the same chronological discipline the
trade backtest used. The label is the DIRECTIONAL trade (UP leans long, DOWN leans short)
from the next open to the next close with the shipped 1.5% stop, so the numbers compare
directly with the shipped book.

**The 20 factors, all computable before the entry bar prints** (no lookahead):

| group | factors |
|---|---|
| news | category one-hot (9), direction, the class's TRAIN-only hit rate and mean move, symbols in the headline, headline length, the percentage parsed from the headline text |
| tape | the gap at entry (the skip rule's own input, given as a factor), the news day's move, news-day volume vs its own 20-day norm |
| stock | 5-day pre-news return, 20-day volatility |
| market | 5-day market return, 20-day market volatility |
| calendar | day of week |

## 2. The models — and why not deep learning

* **Logistic regression** (standardized, L2, 400 epochs) and **gradient-boosted decision
  stumps** (200 trees, depth 3, lr 0.08), both hand-rolled — the whole point is that this
  sample supports them and does not support more.
* **Why no DL:** the train side has 1,334 events. A neural net's capacity dwarfs that; it
  would memorize and its holdout number would be luck, not accuracy. On tabular data of this
  size, gradient boosting is the ceiling — and it is what the numbers below come from.
* Every threshold (the probability cut that defines "high conviction") was chosen on TRAIN
  only and then applied to test once.

## 3. The results (test = 2026-01-11 → 2026-05-18)

| | accuracy | AUC | as trade filter |
|---|---|---|---|
| baseline: always "the lean fails" | **60.0%** | — | n=1,985, PF 0.94 (fading everything) |
| logistic regression | 54.4% | 0.517 | n=22, PF 0.97 — useless |
| gradient boosting | 55.9% | 0.553 | **n=69, hit 58.0%, +0.35%/trade, PF 1.58** |
| shipped skip rule alone | — | — | n=995, hit 41.3%, PF 1.08 |
| **GBM ∩ shipped rule** | — | — | **n=35, hit 71.4%, +0.62%/trade, PF 1.95** |

Reading it honestly:

1. **Accuracy is the wrong scoreboard and the models prove it.** A model that never learns
   anything and always says "skip" is right 60% of the time, because most leans fail. The
   models are *below* that line on accuracy — their value is not in calling every lean
   right, it is in the tail they select.
2. **Logistic regression adds nothing** (AUC 0.517 ≈ coin flip) — the relationship is not
   linear in these factors.
3. **The GBM's selected subset is where the accuracy lives**: 58% hit on its picks versus
   40% base rate, and 71.4% when its picks also pass the shipped skip rule.
4. **What the model learned** (split-gain importance): news-day move, stock volatility,
   volume spike, the entry gap, and the class hit rate — i.e. it rediscovered the skip rule
   and refined it with a volatility/regime context. The negative weight on `dirUP` in the
   logistic mirrors the earlier finding: DOWN leans (earnings misses) are the stronger side.

## 4. Caveats, stated at full size

* **n=35 is at the floor.** The repo's speaking rule is "PF ≥ 1.5 AND ≥ 30 resolved trades";
  the combined filter clears both by a hair. One bad week moves these numbers a lot.
* The model was selected among two candidates on the same holdout; a fresh out-of-sample
  window (or paper trading) is required before it sizes anything.
* AUC 0.553 is a weak model. Do not read PF 1.95 as "the AI is 71% right" — it is "the AI
  found 35 trades out of 1,985 that were right 71% of the time on this window".
* Features are entry-time-only; nothing here read a single future bar.

## 5. Artifacts

* `data/news/ml_study.json` — full metrics, weights, thresholds.
* `data/news/ml_model.json` — the trained GBM itself (trees, standardizer, threshold), so a
  live scorer can load the exact model that produced these numbers instead of retraining a
  different one.

## 6. Reproducing

```bash
node scratch/news_ml_study.js       # ~2 min: rebuilds features, retrains, rewrites both artifacts
```

const config = require('../config');
const newsEngine = require('../stage_a_yahoo/news_engine');

class DecisionEngine {
    evaluate(tick) {
        // Safe extractions
        const ltp = tick.lastTradedPrice || tick.ltp;
        const vwap = tick.averageTradedPrice || tick.vwap || ltp;
        const totalBuyQty = tick.totalBuyQuantity || 0;
        const totalSellQty = tick.totalSellQuantity || 0;
        const roc10s = tick.roc10s || 0;
        const roc30s = tick.roc30s || 0;
        
        // --- News Sentiment Gate & Headline ---
        const news = newsEngine.getSentiment(tick.symbol);
        
        // 1. Flow Analysis (Delta)
        const flowScore = this.analyzeFlow(totalBuyQty, totalSellQty);
        
        // 2. Location Analysis (VWAP)
        const locationScore = this.analyzeLocation(ltp, vwap);
        
        // 3. Exhaustion & Divergence Veto
        if (this.isExhausted(roc10s, flowScore)) {
            return { 
                symbol: tick.symbol, 
                status: 'BLOCKED', 
                reason: 'VETO_EXHAUSTION',
                points: 0,
                headline: news.headline,
                roc10s,
                roc30s,
                ltp
            };
        }

        // 4. Determine Direction
        const direction = ltp > vwap ? 'BUY' : 'SELL';
        
        // --- GATE_EVENT: News Alignment Filter ---
        if (direction === 'BUY' && news.label === 'BEARISH') {
            return { symbol: tick.symbol, status: 'BLOCKED', reason: 'GATE_NEWS_CONFLICT_BEARISH', points: 0, headline: news.headline, roc10s, roc30s, ltp };
        }
        if (direction === 'SELL' && news.label === 'BULLISH') {
            return { symbol: tick.symbol, status: 'BLOCKED', reason: 'GATE_NEWS_CONFLICT_BULLISH', points: 0, headline: news.headline, roc10s, roc30s, ltp };
        }
        
        // 5. Final V2 Scoring
        let finalScore = flowScore + locationScore;
        if ((direction === 'BUY' && news.label === 'BULLISH') || 
            (direction === 'SELL' && news.label === 'BEARISH')) {
            finalScore += 2; // News bonus
        }
        
        if (finalScore >= 7) {
            return { 
                symbol: tick.symbol, 
                status: 'SIGNAL', 
                points: finalScore, 
                direction, 
                news_context: news.label,
                headline: news.headline,
                roc10s,
                roc30s,
                ltp
            };
        }
        
        return { 
            symbol: tick.symbol, 
            status: 'WATCH', 
            points: finalScore, 
            news_context: news.label,
            headline: news.headline,
            roc10s,
            roc30s,
            ltp
        };
    }

    analyzeFlow(buyQty, sellQty) {
        if (buyQty === 0 && sellQty === 0) return 0;
        const delta = (buyQty - sellQty) / (buyQty + sellQty);
        
        if (delta > 0.1) return config.scoringWeights.flowConfirmation; 
        if (delta < -0.1) return config.scoringWeights.flowConfirmation; 
        
        return 0; 
    }

    analyzeLocation(ltp, vwap) {
        const diff = Math.abs((ltp - vwap) / vwap) * 100;
        if (diff > 0.1) {
            return config.scoringWeights.locationVWAP;
        }
        return 0;
    }

    isExhausted(roc10s, flowScore) {
        return Math.abs(roc10s) >= 0.15 && flowScore === 0;
    }
}

module.exports = new DecisionEngine();

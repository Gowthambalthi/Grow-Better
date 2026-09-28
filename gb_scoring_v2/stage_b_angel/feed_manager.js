const EventEmitter = require('events');
const config = require('../config');

class AngelFeedManager extends EventEmitter {
    constructor() {
        super();
        this.subscriptions = new Set();
        // Stores price history for ROC calc: { symbol: [{ price, timestamp }] }
        this.priceHistory = {};
    }

    updateSubscriptions(shortlist) {
        console.log(`[Stage B - ANGEL] Updating active live watchlist for ${shortlist.length} symbols.`);
        this.subscriptions = new Set(shortlist);
        
        // Cleanup old history
        for (const sym of Object.keys(this.priceHistory)) {
            if (!this.subscriptions.has(sym)) {
                delete this.priceHistory[sym];
            }
        }
    }
    
    // Connects to the main Broker/AngelMarketFeed instance
    attachBroker(brokerInstance) {
        brokerInstance.on('tick', (tick) => this.handleTick(tick));
    }

    handleTick(tick) {
        // Fallback identifying property if the raw payload uses 'token'
        const symbol = tick.symbol || tick.token;
        if (!symbol) return;
        
        // In real live mode, only process subscribed tokens. 
        // For development/testing flexibility we process all if subscriptions are empty.
        if (this.subscriptions.size > 0 && !this.subscriptions.has(symbol)) {
            return;
        }

        const ltp = tick.lastTradedPrice || tick.ltp;
        if (!ltp) return;

        this._updateHistory(symbol, ltp, tick.exchangeTimestamp || Date.now());

        // Calculate continuous ROC
        const roc10s = this._calculateROC(symbol, 10);
        const roc30s = this._calculateROC(symbol, 30);

        // Stage B Screener: Apply Fast Filters (ROC, Volume)
        if (this.isHighInterest(roc10s, roc30s)) {
            // Forward the active candidate to Stage C, injecting the ROC data
            this.emit('candidate', { ...tick, symbol, roc10s, roc30s });
        }
    }

    _updateHistory(symbol, price, timestamp) {
        if (!this.priceHistory[symbol]) this.priceHistory[symbol] = [];
        this.priceHistory[symbol].push({ price, timestamp });
        
        // Truncate history older than 60 seconds
        const cutoff = timestamp - 60000;
        this.priceHistory[symbol] = this.priceHistory[symbol].filter(h => h.timestamp >= cutoff);
    }

    _calculateROC(symbol, seconds) {
        const history = this.priceHistory[symbol];
        if (!history || history.length < 2) return 0;
        
        const current = history[history.length - 1];
        const cutoff = current.timestamp - (seconds * 1000);
        
        // Find the closest tick to the cutoff time
        let reference = history[0];
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].timestamp <= cutoff) {
                reference = history[i];
                break;
            }
        }

        return ((current.price - reference.price) / reference.price) * 100;
    }

    isHighInterest(roc10s, roc30s) {
        // Drop logic: Only forward stocks showing strong micro-structure movement
        // We use absolute value so we catch both strong BUY and SELL momentum
        return Math.abs(roc10s) >= config.fastMomentumThresholds.roc10s || 
               Math.abs(roc30s) >= config.fastMomentumThresholds.roc30s;
    }
}

module.exports = new AngelFeedManager();

const EventEmitter = require('events');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const config = require('../config');

class YahooCycler extends EventEmitter {
    constructor() {
        super();
        this.shortlist = new Set();
    }

    start() {
        this.runCycle();
        setInterval(() => this.runCycle(), config.yahooCycleMs);
    }

    async runCycle() {
        console.log('\n[Stage A - YAHOO] Fetching market universe (5-min cycle)...');
        
        try {
            // Fetch live quotes for the configured universe
            const quotes = await yahooFinance.quote(config.universe);
            
            const newShortlist = [];
            
            for (const q of quotes) {
                // Apply broad filters (Stage A)
                const price = q.regularMarketPrice || 0;
                const vol = q.regularMarketVolume || 0;
                
                if (price >= config.filters.minPrice && vol >= config.filters.minVol) {
                    // Extract Angel One token symbol (strip .NS)
                    const symbol = q.symbol.replace('.NS', '');
                    newShortlist.push(symbol + '-EQ'); // Angel One format standard
                }
            }

            this.shortlist = new Set(newShortlist);
            console.log(`[Stage A - YAHOO] Broad filters applied. ${newShortlist.length} stocks passed to Shortlist.`);
            
            this.emit('update', Array.from(this.shortlist));
            
        } catch (error) {
            console.error('[Stage A - YAHOO] Fetch error:', error.message);
        }
    }
}

module.exports = new YahooCycler();

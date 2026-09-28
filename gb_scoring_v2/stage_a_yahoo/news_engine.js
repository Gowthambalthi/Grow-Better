const Parser = require('rss-parser');
const EventEmitter = require('events');

class NewsEngine extends EventEmitter {
    constructor() {
        super();
        this.parser = new Parser();
        // Caches sentiment and headlines: { 'RELIANCE-EQ': { score: 1, label: 'BULLISH', headline: '...' } }
        this.sentimentCache = {};
        
        this.BULLISH_WORDS = ['surge', 'surges', 'jump', 'jumps', 'gain', 'gains', 'rise', 'rises', 'profit', 'up', 'buy', 'positive', 'growth', 'high', 'win', 'wins', 'dividend', 'soars'];
        this.BEARISH_WORDS = ['fall', 'falls', 'drop', 'drops', 'plunge', 'plunges', 'loss', 'down', 'sell', 'negative', 'low', 'crash', 'crashes', 'decline', 'declines', 'penalty', 'weak', 'slips'];
    }

    /**
     * Updates the news sentiment using Live Google News RSS
     */
    async refreshNews(shortlist) {
        console.log(`\n[News Engine] Fetching LIVE news headlines for ${shortlist.length} active candidates...`);
        
        for (const rawSymbol of shortlist) {
            // Convert 'RELIANCE-EQ' to 'RELIANCE'
            const symbol = rawSymbol.split('-')[0];
            
            try {
                // Fetch from Google News RSS for this specific stock
                const url = `https://news.google.com/rss/search?q=${symbol}+stock+NSE&hl=en-IN&gl=IN&ceid=IN:en`;
                const feed = await this.parser.parseURL(url);
                
                if (feed.items && feed.items.length > 0) {
                    // Grab the most recent headline
                    const latestNews = feed.items[0].title;
                    
                    // Simple NLP Sentiment Analysis
                    const titleLower = latestNews.toLowerCase();
                    let score = 0;
                    
                    for (const word of this.BULLISH_WORDS) {
                        if (titleLower.includes(word)) score += 1;
                    }
                    for (const word of this.BEARISH_WORDS) {
                        if (titleLower.includes(word)) score -= 1;
                    }

                    let label = 'NEUTRAL';
                    if (score > 0) label = 'BULLISH';
                    if (score < 0) label = 'BEARISH';

                    this.sentimentCache[rawSymbol] = {
                        score: score,
                        label: label,
                        headline: latestNews,
                        timestamp: Date.now()
                    };
                } else {
                    this.sentimentCache[rawSymbol] = { score: 0, label: 'NEUTRAL', headline: 'No recent news', timestamp: Date.now() };
                }
            } catch (error) {
                // If rate limited or network error, silently fallback to Neutral
                this.sentimentCache[rawSymbol] = { score: 0, label: 'NEUTRAL', headline: 'Error fetching news', timestamp: Date.now() };
            }
        }
        
        console.log(`[News Engine] Live news refresh complete.\n`);
    }

    getSentiment(symbol) {
        return this.sentimentCache[symbol] || { score: 0, label: 'NEUTRAL', headline: 'Waiting for cycle' };
    }
}

module.exports = new NewsEngine();

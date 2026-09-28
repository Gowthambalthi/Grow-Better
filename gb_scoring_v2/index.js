const yahooCycler = require('./stage_a_yahoo/cycler');
const newsEngine = require('./stage_a_yahoo/news_engine');
const angelFeed = require('./stage_b_angel/feed_manager');
const decisionEngine = require('./stage_c_scoring/decision_engine');
const recorder = require('./infrastructure/recorder');

class GBScoringV2 {
    constructor() {
        // Tracks active intraday episodes
        this.activeTrades = {};
    }

    start(brokerInstance) {
        console.log('====================================================');
        console.log(' GB Terminal V2 - 3-Stage Pipeline & Trade Board');
        console.log('====================================================\n');

        if (brokerInstance) {
            angelFeed.attachBroker(brokerInstance);
            console.log('[Init] Stage B successfully attached to live broker feed.');
        }

        // 1. Stage A -> Stage B: Market filter
        yahooCycler.on('update', async (shortlist) => {
            angelFeed.updateSubscriptions(shortlist);
            // Background: Refresh the LIVE news API sentiment
            await newsEngine.refreshNews(shortlist);
        });

        // 2. Stage B -> Stage C
        angelFeed.on('candidate', (tick) => {
            recorder.log('STAGE_B_CANDIDATE', tick);
            
            // 3. Stage C -> Action
            const decision = decisionEngine.evaluate(tick);
            recorder.log('STAGE_C_DECISION', decision);
            
            this.handleDecisionOutput(decision);
        });

        yahooCycler.start();
    }

    handleDecisionOutput(decision) {
        const sym = decision.symbol;
        const roc10Format = (decision.roc10s || 0).toFixed(2);
        const roc30Format = (decision.roc30s || 0).toFixed(2);
        
        // Handle Signal Generation (Open Trade)
        if (decision.status === 'SIGNAL' && !this.activeTrades[sym]) {
            this.activeTrades[sym] = {
                entryPrice: decision.ltp,
                direction: decision.direction,
                maxProfit: 0,
                status: 'OPEN'
            };
            
            console.log(`\n=========================================================`);
            console.log(`🚨 [NEW INTRA TRADE] ${decision.direction} ${sym} @ ₹${decision.ltp}`);
            console.log(`   🏆 Score: ${decision.points}/58 | ROC10s: ${roc10Format}% | ROC30s: ${roc30Format}%`);
            console.log(`   🗞️  LIVE NEWS [${decision.news_context}]: "${decision.headline}"`);
            console.log(`=========================================================\n`);
        } 
        else if (decision.status === 'BLOCKED' && !this.activeTrades[sym]) {
            // Optional: Comment this out if it's too spammy
            // console.log(`🛑 [BLOCKED] ${sym} | Reason: ${decision.reason} | ROC10: ${roc10Format}%`);
        }

        // Update Active Trade Board / Running PnL
        if (this.activeTrades[sym] && this.activeTrades[sym].status === 'OPEN') {
            const trade = this.activeTrades[sym];
            const currentPrice = decision.ltp;
            
            // Calculate Absolute and Percentage PnL
            let pnlPoints = currentPrice - trade.entryPrice;
            if (trade.direction === 'SELL') pnlPoints = -pnlPoints; // Short logic
            
            const pnlPercent = ((pnlPoints / trade.entryPrice) * 100).toFixed(2);
            const pnlStr = pnlPoints >= 0 ? `+₹${pnlPoints.toFixed(2)} (+${pnlPercent}%) 🟢` : `-₹${Math.abs(pnlPoints).toFixed(2)} (${pnlPercent}%) 🔴`;
            
            // Track Max Profit (MFE)
            if (pnlPoints > trade.maxProfit) trade.maxProfit = pnlPoints;

            // Live terminal dashboard update
            console.log(`📈 [LIVE BOARD] ${sym} | PnL: ${pnlStr} | ROC10s: ${roc10Format}% | ROC30s: ${roc30Format}% | MFE: ₹${trade.maxProfit.toFixed(2)}`);
        }
    }

    demo() {
        this.start(null); 
        console.log('Starting mock Angel One live feed simulation...\n');
        
        let priceCounterRel = 2950;
        
        setInterval(() => {
            const now = Date.now();
            
            // Simulate a tick pushing RELIANCE up rapidly (creating profit)
            priceCounterRel += 1.50; 
            
            const mockTicks = [
                { 
                    symbol: 'RELIANCE-EQ', 
                    lastTradedPrice: priceCounterRel, 
                    averageTradedPrice: 2940, 
                    totalBuyQuantity: 50000, 
                    totalSellQuantity: 10000,
                    roc10s: 0.12,
                    roc30s: 0.25,
                    exchangeTimestamp: now
                },
                // Blocked candidate (divergence)
                { 
                    symbol: 'TATASTEEL-EQ', 
                    lastTradedPrice: 155, 
                    averageTradedPrice: 150, 
                    totalBuyQuantity: 1000, 
                    totalSellQuantity: 50000,
                    roc10s: 0.20,
                    roc30s: 0.30,
                    exchangeTimestamp: now
                }
            ];

            mockTicks.forEach(t => angelFeed.handleTick(t));
        }, 2000); 
    }
}

module.exports = new GBScoringV2();

if (require.main === module) {
    module.exports.demo();
}

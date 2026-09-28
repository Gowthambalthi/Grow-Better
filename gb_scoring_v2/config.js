module.exports = {
    // Stage A: Yahoo cycler interval (5 minutes)
    yahooCycleMs: 5 * 60 * 1000, 
    
    // Stage A: Universe to scan (NSE symbols)
    // Note: In a full system, you would fetch Nifty 500. Using top liquid names for now.
    universe: [
        'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'INFY.NS',
        'SBI.NS', 'BHARTIARTL.NS', 'ITC.NS', 'HINDUNILVR.NS', 'LT.NS',
        'BAJFINANCE.NS', 'TATASTEEL.NS', 'MARUTI.NS', 'AXISBANK.NS'
    ],

    // Stage A: Broad Market Filters
    filters: {
        minPrice: 50,          // INR
        minVol: 100000,        // Volume today
        minMarketCap: 10000000 // In thousands
    },
    
    // Stage B: Fast Momentum Thresholds (Angel One Live)
    fastMomentumThresholds: {
        roc10s: 0.05, // 0.05% move in 10s
        roc30s: 0.10, // 0.10% move in 30s
    },

    // Stage C: Deep Scoring Weights
    scoringWeights: {
        flowConfirmation: 4,
        locationVWAP: 3,
        locationPOC: 3
    }
};

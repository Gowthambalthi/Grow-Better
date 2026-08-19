const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function fetchStockLiveQuote(symbol) {
  const cleanSym = symbol.replace(/-EQ$/i, '').toUpperCase();
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${cleanSym}.NS?interval=1m&range=1d`;
    const res = await axios.get(url, { headers, timeout: 3000 });
    const meta = res.data?.chart?.result?.[0]?.meta;
    if (meta && meta.regularMarketPrice != null) {
      const ltp = Number(meta.regularMarketPrice);
      const close = Number(meta.chartPreviousClose || meta.previousClose || ltp);
      const change = Number((ltp - close).toFixed(2));
      const changePct = close > 0 ? Number(((change / close) * 100).toFixed(2)) : 0;
      return {
        symbol: cleanSym,
        ltp,
        price: ltp,
        close,
        change,
        changePct,
        lastUpdated: new Date().toISOString()
      };
    }
  } catch (e) {
    console.error('Yahoo fetch err:', e.message);
  }
  return null;
}

async function run() {
  for (const s of ['RELIANCE', 'CUPID', 'EMMVEE']) {
    const q = await fetchStockLiveQuote(s);
    console.log(s, '=> LIVE QUOTE:', q);
  }
}

run();

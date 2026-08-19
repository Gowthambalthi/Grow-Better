const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function testStockPrevCloses() {
  const syms = ['CUPID.NS', 'RELIANCE.NS', 'EMMVEE.NS'];
  for (const s of syms) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1m&range=1d`;
      const res = await axios.get(url, { headers, timeout: 3000 });
      const meta = res.data?.chart?.result?.[0]?.meta;
      console.log(s, '=> REGULAR PRICE:', meta?.regularMarketPrice, '| PREV CLOSE:', meta?.chartPreviousClose || meta?.previousClose);
    } catch(e) {
      console.log(s, '=> ERR:', e.message);
    }
  }
}
testStockPrevCloses();

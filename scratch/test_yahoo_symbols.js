const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function testYahooSymbols() {
  const syms = {
    NIFTY: '%5ENSEI',
    BANKNIFTY: '%5ENSEBANK',
    SENSEX: '%5EBSESN',
    FINNIFTY: 'NIFTY_FIN_SERVICE.NS',
    FINNIFTY2: '%5ECNXFIN',
    MIDCPNIFTY: 'NIFTY_MID_SELECT.NS',
    MIDCPNIFTY2: '%5ENSEMDCP50'
  };

  for (const [k, s] of Object.entries(syms)) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${s}?interval=1m&range=1d`;
      const res = await axios.get(url, { headers, timeout: 3000 });
      const meta = res.data?.chart?.result?.[0]?.meta;
      console.log(k, '(' + s + ') => PRICE:', meta?.regularMarketPrice, '| PREV CLOSE:', meta?.chartPreviousClose || meta?.previousClose);
    } catch(e) {
      console.log(k, '=> ERR:', e.message);
    }
  }
}
testYahooSymbols();

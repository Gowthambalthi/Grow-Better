const axios = require('axios');

async function testMCET() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.moneycontrol.com',
    'Referer': 'https://www.moneycontrol.com/'
  };

  // 1. Moneycontrol pricefeed API for IN;SGX / GIFT NIFTY
  const urls = [
    'https://priceapi.moneycontrol.com/pricefeed/notices/pricefeed/stockPrice?symbol=in%3BSGX',
    'https://priceapi.moneycontrol.com/pricefeed/techChart/indianIndices/stockPrice?symbol=in%3BSGX',
    'https://priceapi.moneycontrol.com/pricefeed/nse/indexoption/IND%3ASGX',
    'https://priceapi.moneycontrol.com/pricefeed/livemarket/indices?symbol=in%3BSGX',
    'https://priceapi.moneycontrol.com/pricefeed/notices/pricefeed/index?symbol=in%3BSGX',
    'https://api.stockedge.com/api/v1/indices/1',
    'https://etmarkets.indiatimes.com/feed/livemarketindices.cms',
    'https://etmarkets.indiatimes.com/feed/globalindices.cms'
  ];

  for (const u of urls) {
    try {
      const res = await axios.get(u, { headers, timeout: 4000 });
      console.log('SUCCESS:', u, '=>', JSON.stringify(res.data).slice(0, 250));
    } catch(e) {
      console.log('FAIL:', u, '=>', e.message);
    }
  }
}

testMCET();

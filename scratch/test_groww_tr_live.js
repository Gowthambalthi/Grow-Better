const axios = require('axios');

async function testGrowwTR() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };

  const symbols = [
    'NIFTY',
    'BANKNIFTY',
    'GIFTNIFTY',
    'SGXNIFTY',
    'NIFTYGIFT'
  ];

  for (const s of symbols) {
    try {
      const u = `https://groww.in/v1/api/stocks_data/v1/tr_live_prices/exchange/NSE/segment/INDICES/symbol/${s}/latest`;
      const res = await axios.get(u, { headers, timeout: 3000 });
      console.log('SUCCESS FOR', s, '=> price:', res.data?.ltp, '| close:', res.data?.close);
    } catch(e) {
      console.log('FAIL FOR', s, '=>', e.message);
    }
  }
}

testGrowwTR();

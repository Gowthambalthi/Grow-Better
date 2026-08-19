const axios = require('axios');

async function testMCScrape() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  };

  const urls = [
    'https://www.moneycontrol.com/indian-indices/gift-nifty-55.html',
    'https://www.google.com/finance/quote/GIFTNIFTY:INDEXNSE',
    'https://finance.yahoo.com/quote/%5ENSEI',
    'https://api.chartink.com/v2/market-indices'
  ];

  for (const u of urls) {
    try {
      const res = await axios.get(u, { headers, timeout: 6000 });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      console.log('--- URL:', u, '---');
      // Look for 24,xxx.xx or 23,xxx.xx or GIFT NIFTY
      const matches = html.match(/24,[0-9]{3}\.[0-9]{2}/g) || html.match(/23,[0-9]{3}\.[0-9]{2}/g) || html.match(/GIFT NIFTY[^<]{1,100}/gi);
      console.log('MATCHES:', matches?.slice(0, 10));
    } catch(e) {
      console.log('FAIL:', u, '=>', e.message);
    }
  }
}

testMCScrape();

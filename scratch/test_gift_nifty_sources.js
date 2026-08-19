const axios = require('axios');

async function testSources() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  };

  console.log('=== TESTING REAL GIFT NIFTY FEEDS ===');

  // 1. Groww Search / Global Index API
  try {
    const res = await axios.get('https://groww.in/v1/api/stocks_data/v1/global_indices/sgx-nifty', { headers, timeout: 5000 });
    console.log('1. Groww SGX-Nifty endpoint:', res.data);
  } catch(e) {
    console.log('1. Groww SGX-Nifty err:', e.message);
  }

  // 2. Moneycontrol Indices API
  try {
    const res = await axios.get('https://priceapi.moneycontrol.com/pricefeed/notices/pricefeed/index?symbol=in%3BSGX', { headers, timeout: 5000 });
    console.log('2. Moneycontrol in;SGX:', JSON.stringify(res.data));
  } catch(e) {
    console.log('2. Moneycontrol err:', e.message);
  }

  // 3. Investing.com / Yahoo Finance Futures (IN1!, ^NSEI, etc)
  try {
    const res = await axios.get('https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1m&range=1d', { headers, timeout: 5000 });
    console.log('3. Yahoo Finance NSEI:', res.data?.chart?.result?.[0]?.meta?.regularMarketPrice);
  } catch(e) {
    console.log('3. Yahoo err:', e.message);
  }

  // 4. Live Mint / Moneycontrol Web Page Scrape for GIFT NIFTY
  try {
    const res = await axios.get('https://www.moneycontrol.com/indian-indices/gift-nifty-55.html', { headers: { ...headers, 'Accept': 'text/html' }, timeout: 5000 });
    const html = res.data;
    const priceMatch = html.match(/id="last_price"[^>]*>([0-9,]+\.[0-9]{2})/i) || html.match(/class="[^"]*price[^"]*"[^>]*>([0-9,]+\.[0-9]{2})/i);
    console.log('4. Moneycontrol GIFT NIFTY HTML Price Match:', priceMatch?.[1]);
  } catch(e) {
    console.log('4. Moneycontrol HTML err:', e.message);
  }

  // 5. Google Finance GIFT NIFTY / SGX NIFTY
  try {
    const res = await axios.get('https://www.google.com/finance/quote/GIFTNIFTY:INDEXNSE', { headers: { ...headers, 'Accept': 'text/html' }, timeout: 5000 });
    const html = res.data;
    const priceMatch = html.match(/data-last-price="([0-9\.]+)"/);
    console.log('5. Google Finance GIFT NIFTY Price:', priceMatch?.[1]);
  } catch(e) {
    console.log('5. Google Finance err:', e.message);
  }
}

testSources();

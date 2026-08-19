const axios = require('axios');

async function testMore() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://economictimes.indiatimes.com/',
    'Accept': 'application/json, text/plain, */*'
  };

  // 1. Economic Times Indices API
  try {
    const res = await axios.get('https://etmarketsweb.indiatimes.com/pages/globalindices/globalIndices.cms', { headers, timeout: 5000 });
    console.log('1. ET GLOBAL INDICES RAW:', typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 500));
  } catch(e) { console.log('1. ET Err:', e.message); }

  // 2. Moneycontrol Global Indices API
  try {
    const res = await axios.get('https://priceapi.moneycontrol.com/pricefeed/notices/pricefeed/globalIndices', { headers, timeout: 5000 });
    console.log('2. MC GLOBAL INDICES:', JSON.stringify(res.data).slice(0, 500));
  } catch(e) { console.log('2. MC Err:', e.message); }

  // 3. Tickertape Global / Gift Nifty
  try {
    const res = await axios.get('https://api.tickertape.in/external/indices/sgx-nifty', { headers, timeout: 5000 });
    console.log('3. TICKERTAPE SGX NIFTY:', JSON.stringify(res.data));
  } catch(e) { console.log('3. Tickertape Err:', e.message); }

  // 4. Moneycontrol Indian Indices / Global Markets Widget
  try {
    const res = await axios.get('https://priceapi.moneycontrol.com/pricefeed/notices/pricefeed/marketstats/globalindices/marketstats', { headers, timeout: 5000 });
    console.log('4. MC GLOBAL STATS:', JSON.stringify(res.data).slice(0, 500));
  } catch(e) { console.log('4. MC Global Stats Err:', e.message); }
}

testMore();

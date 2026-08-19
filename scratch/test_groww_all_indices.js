const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function fetchGrowwIndex(slug) {
  try {
    const url = `https://groww.in/v1/api/stocks_data/v1/company/search_id/${slug}`;
    const res = await axios.get(url, { headers, timeout: 3000 });
    const data = res.data;
    if (data && data.stats) {
      console.log(slug, '=> LIVE STATS:', data.stats);
    } else {
      console.log(slug, '=> DATA:', JSON.stringify(data).slice(0, 300));
    }
  } catch(e) {
    console.log(slug, '=> ERR:', e.message);
  }
}

async function testAll() {
  const slugs = ['sgx-nifty', 'nifty', 'bank-nifty', 'fin-nifty', 'midcap-nifty', 'gold-futures', 'silver-futures'];
  for (const s of slugs) {
    await fetchGrowwIndex(s);
  }
}

testAll();

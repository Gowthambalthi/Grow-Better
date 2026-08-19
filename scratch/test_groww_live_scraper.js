const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function fetchGrowwLiveQuote(slug) {
  try {
    const url = `https://groww.in/indices/global-indices/${slug}`;
    const res = await axios.get(url, { headers, timeout: 4000 });
    const html = res.data;
    
    // Look for JSON payload in HTML or price regex
    const ltpMatch = html.match(/>([0-9]{2},[0-9]{3}\.[0-9]{2})<\/div>/) || html.match(/\"value\":([0-9.]+)/) || html.match(/\"lastPrice\":([0-9.]+)/);
    const chgMatch = html.match(/([+-]?[0-9]+\.[0-9]{2})\s*\(([+-]?[0-9]+\.[0-9]{2})%\)/);
    
    console.log(slug, '=> HTML LENGTH:', html.length, '| LTP MATCH:', ltpMatch ? ltpMatch[1] : 'None', '| CHG MATCH:', chgMatch ? chgMatch[0] : 'None');
  } catch (e) {
    console.error(slug, '=> ERR:', e.message);
  }
}

async function testAllGroww() {
  await fetchGrowwLiveQuote('sgx-nifty');
}

testAllGroww();

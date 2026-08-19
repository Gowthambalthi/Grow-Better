const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function testGroww() {
  try {
    const res = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 5000 });
    const match = res.data.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (match) {
      const data = JSON.parse(match[1]);
      console.log('GROWW GIFT NIFTY DATA:', JSON.stringify(data.props?.pageProps, null, 2).slice(0, 2000));
    } else {
      console.log('Match failed');
    }
  } catch (e) {
    console.error('Err:', e.message);
  }
}

testGroww();

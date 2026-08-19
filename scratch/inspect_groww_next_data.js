const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function inspect() {
  try {
    const res = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 5000 });
    const html = res.data;
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (nextDataMatch) {
      const nextData = JSON.parse(nextDataMatch[1]);
      console.log('NEXT DATA KEYS:', Object.keys(nextData.props?.pageProps || {}));
      console.log('INDEX DATA:', JSON.stringify(nextData.props?.pageProps?.indexData || nextData.props?.pageProps?.headerData || nextData.props?.pageProps, null, 2).slice(0, 1500));
    } else {
      console.log('__NEXT_DATA__ not found');
    }
  } catch (e) {
    console.error('Err:', e.message);
  }
}

inspect();

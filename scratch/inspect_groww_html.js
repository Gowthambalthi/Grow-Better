const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function inspectHtml() {
  try {
    const res = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 5000 });
    console.log('HTML SNIPPET:', res.data.slice(0, 1500));
    const giftMatch = res.data.match(/24,[0-9]{3}\.[0-9]{2}/g) || res.data.match(/GIFT NIFTY[^\n<]+/gi);
    console.log('NUMBERS OR GIFT MATCHES:', giftMatch);
  } catch (e) {
    console.error('Err:', e.message);
  }
}

inspectHtml();

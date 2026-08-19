const axios = require('axios');

async function fetchLiveGiftNifty() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  try {
    const res = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 4000 });
    const html = res.data;

    const ltpMatch = html.match(/"value":\s*([0-9.]+)/) || html.match(/"lastPrice":\s*([0-9.]+)/);
    const chgMatch = html.match(/"dayChange":\s*([+-]?[0-9.]+)/) || html.match(/"change":\s*([+-]?[0-9.]+)/);
    const chgPctMatch = html.match(/"dayChangePerc":\s*([+-]?[0-9.]+)/) || html.match(/"changePercent":\s*([+-]?[0-9.]+)/);
    const prevCloseMatch = html.match(/"close":\s*([0-9.]+)/) || html.match(/"previousClose":\s*([0-9.]+)/);

    if (ltpMatch) {
      const price = Number(ltpMatch[1]);
      const change = chgMatch ? Number(chgMatch[1]) : 0;
      const changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
      const close = prevCloseMatch ? Number(prevCloseMatch[1]) : (price - change);

      return {
        price,
        close: Number(close.toFixed(2)),
        change: Number(change.toFixed(2)),
        changePct: Number(changePct.toFixed(2)),
        source: 'Groww Live GIFT NIFTY'
      };
    }
  } catch (e) {
    console.error('Groww GIFT NIFTY primary fetch error:', e.message);
  }
  return null;
}

fetchLiveGiftNifty().then(res => console.log('FETCH RESULT:', res));

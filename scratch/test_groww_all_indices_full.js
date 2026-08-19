const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function fetchGrowwIndex(key, slug) {
  try {
    const isGlobal = slug.includes('/');
    const url = isGlobal ? `https://groww.in/indices/${slug}` : `https://groww.in/indices/${slug}`;
    const res = await axios.get(url, { headers, timeout: 3500 });
    const html = res.data;

    const ltpMatch = html.match(/\"value\":\s*([0-9.]+)/) || html.match(/\"lastPrice\":\s*([0-9.]+)/) || html.match(/([0-9]{2},[0-9]{3}\.[0-9]{2})/);
    const chgMatch = html.match(/\"dayChange\":\s*([+-]?[0-9.]+)/) || html.match(/\"change\":\s*([+-]?[0-9.]+)/);
    const chgPctMatch = html.match(/\"dayChangePerc\":\s*([+-]?[0-9.]+)/) || html.match(/\"changePercent\":\s*([+-]?[0-9.]+)/);
    const closeMatch = html.match(/\"close\":\s*([0-9.]+)/) || html.match(/\"previousClose\":\s*([0-9.]+)/);

    const price = ltpMatch ? Number(ltpMatch[1].replace(/,/g, '')) : null;
    const change = chgMatch ? Number(chgMatch[1]) : 0;
    const changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
    const close = closeMatch ? Number(closeMatch[1]) : (price != null ? price - change : 100);

    console.log(key, '=> Price:', price, '| Change:', change, '| ChangePct:', changePct, '| Close:', close);
  } catch (e) {
    console.error(key, '=> ERR:', e.message);
  }
}

async function testAll() {
  const map = {
    NIFTY: 'nifty',
    BANKNIFTY: 'bank-nifty',
    FINNIFTY: 'fin-nifty',
    MIDCPNIFTY: 'midcap-nifty',
    SENSEX: 'sensex',
    GIFTNIFTY: 'global-indices/sgx-nifty'
  };

  for (const [key, slug] of Object.entries(map)) {
    await fetchGrowwIndex(key, slug);
  }
}

testAll();

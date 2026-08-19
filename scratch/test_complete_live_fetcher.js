const axios = require('axios');
const angelAuth = require('../angelone/auth');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function fetchLiveMarketWatchlist() {
  console.log('Testing Complete Multi-Provider Live Market Watchlist Fetcher...');

  // 1. Fetch Groww Live GIFT NIFTY
  let giftNiftyQuote = null;
  try {
    const gRes = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 3500 });
    const html = gRes.data;
    const ltpMatch = html.match(/\"value\":\s*([0-9.]+)/) || html.match(/\"lastPrice\":\s*([0-9.]+)/) || html.match(/([0-9]{2},[0-9]{3}\.[0-9]{2})/);
    const chgMatch = html.match(/\"dayChange\":\s*([+-]?[0-9.]+)/) || html.match(/\"change\":\s*([+-]?[0-9.]+)/) || html.match(/([+-]?[0-9]+\.[0-9]{2})\s*\(([+-]?[0-9]+\.[0-9]{2})%\)/);
    const chgPctMatch = html.match(/\"dayChangePerc\":\s*([+-]?[0-9.]+)/) || html.match(/\"changePercent\":\s*([+-]?[0-9.]+)/);
    const prevCloseMatch = html.match(/\"close\":\s*([0-9.]+)/) || html.match(/\"previousClose\":\s*([0-9.]+)/);

    if (ltpMatch) {
      const price = Number(ltpMatch[1].replace(/,/g, ''));
      const change = chgMatch ? Number(chgMatch[1]) : 0;
      const changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
      const close = prevCloseMatch ? Number(prevCloseMatch[1]) : (price - change);

      giftNiftyQuote = { price, close, change, changePct };
    }
  } catch (e) {
    console.log('Groww GIFT NIFTY fetch error:', e.message);
  }

  // 2. Fetch Angel One Live SmartAPI Quotes
  let angelQuotes = {};
  try {
    const authRes = await angelAuth.login();
    const session = authRes.session;
    const angelUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getLtpData';
    const aHeaders = {
      'Authorization': 'Bearer ' + session.jwtToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': 'fe80::1',
      'X-PrivateKey': session.apiKey
    };

    const tokens = [
      { key: 'NIFTY', exch: 'NSE', sym: 'Nifty 50', token: '99926000' },
      { key: 'BANKNIFTY', exch: 'NSE', sym: 'Nifty Bank', token: '99926009' },
      { key: 'FINNIFTY', exch: 'NSE', sym: 'Nifty Fin Service', token: '99926037' },
      { key: 'MIDCPNIFTY', exch: 'NSE', sym: 'NIFTY MID SELECT', token: '99926074' },
      { key: 'SENSEX', exch: 'BSE', sym: 'SENSEX', token: '99919000' },
      { key: 'GOLD', exch: 'MCX', sym: 'GOLD05OCT26FUT', token: '483079' },
      { key: 'SILVER', exch: 'MCX', sym: 'SILVER04SEP26FUT', token: '471725' }
    ];

    await Promise.all(tokens.map(async (t) => {
      try {
        const aRes = await axios.post(angelUrl, { exchange: t.exch, tradingsymbol: t.sym, symboltoken: t.token }, { headers: aHeaders, timeout: 2500 });
        const d = aRes.data?.data;
        if (d && d.ltp != null) {
          const price = Number(d.ltp);
          const close = Number(d.close || price);
          const change = Number((price - close).toFixed(2));
          const changePct = close > 0 ? Number(((change / close) * 100).toFixed(2)) : 0;
          angelQuotes[t.key] = { price, close, change, changePct };
        }
      } catch (err) {}
    }));
  } catch (aErr) {
    console.log('Angel login error:', aErr.message);
  }

  console.log('GROWW LIVE GIFT NIFTY:', giftNiftyQuote);
  console.log('ANGEL ONE LIVE QUOTES:', angelQuotes);
}

fetchLiveMarketWatchlist();

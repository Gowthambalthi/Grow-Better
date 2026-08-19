const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function getGrowwGiftNifty() {
  try {
    const res = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers, timeout: 4000 });
    const html = res.data;

    // Extract LTP
    const ltpMatch = html.match(/\"value\":\s*([0-9.]+)/) || html.match(/\"lastPrice\":\s*([0-9.]+)/) || html.match(/([0-9]{2},[0-9]{3}\.[0-9]{2})/);
    const ltp = ltpMatch ? Number(ltpMatch[1].replace(/,/g, '')) : null;

    // Extract Close / Change / ChangePct
    const chgMatch = html.match(/\"dayChange\":\s*([+-]?[0-9.]+)/) || html.match(/\"change\":\s*([+-]?[0-9.]+)/) || html.match(/([+-]?[0-9]+\.[0-9]{2})\s*\(([+-]?[0-9]+\.[0-9]{2})%\)/);
    const chgPctMatch = html.match(/\"dayChangePerc\":\s*([+-]?[0-9.]+)/) || html.match(/\"changePercent\":\s*([+-]?[0-9.]+)/);
    const prevCloseMatch = html.match(/\"close\":\s*([0-9.]+)/) || html.match(/\"previousClose\":\s*([0-9.]+)/);

    let change = chgMatch ? Number(chgMatch[1]) : 0;
    let changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
    let prevClose = prevCloseMatch ? Number(prevCloseMatch[1]) : (ltp && change ? ltp - change : ltp);

    console.log('GROWW LIVE GIFT NIFTY => Price:', ltp, '| Change:', change, '| ChangePct:', changePct, '| PrevClose:', prevClose);
  } catch (e) {
    console.error('Err:', e.message);
  }
}

getGrowwGiftNifty();

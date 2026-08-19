const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

async function testSearchIdApi() {
  const ids = ['nifty', 'bank-nifty', 'fin-nifty', 'nifty-midcap-100', 'sensex'];
  for (const id of ids) {
    try {
      const url = `https://groww.in/v1/api/stocks_data/v1/company/search_id/${id}`;
      const res = await axios.get(url, { headers, timeout: 3000 });
      const d = res.data;
      console.log(id, '=> HEADER:', d.header?.displayName, '| SEARCH ID:', d.header?.searchId, '| NSE CODE:', d.header?.nseScriptCode);
      if (d.stats) {
        console.log(id, '=> STATS:', d.stats);
      }
    } catch(e) {
      console.log(id, '=> ERR:', e.message);
    }
  }
}

testSearchIdApi();

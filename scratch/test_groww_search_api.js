const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

async function searchGrowwIndices() {
  const queries = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCAP', 'SENSEX'];
  for (const q of queries) {
    try {
      const url = `https://groww.in/v1/api/search/v3/query/global/st_action?query=${q}&page=0&size=10`;
      const res = await axios.get(url, { headers, timeout: 3000 });
      const content = res.data?.data?.content || [];
      console.log(q, '=> FOUND:', content.length, 'items');
      for (const item of content) {
        if (item.entity_type === 'INDEX' || item.type === 'INDEX' || (item.title && item.title.includes('NIFTY'))) {
          console.log('   -', item.title, '| search_id:', item.search_id, '| id:', item.id);
        }
      }
    } catch(e) {
      console.log(q, '=> ERR:', e.message);
    }
  }
}
searchGrowwIndices();

const axios = require('axios');

async function testGrowwSearch() {
  const headers = { 
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'X-App-Id': 'growwWeb'
  };

  try {
    const res = await axios.get('https://groww.in/v1/api/search/v1/derived/super_search?app=false&query=GIFT', { headers, timeout: 5000 });
    console.log('GROWW SEARCH FOR GIFT:', JSON.stringify(res.data, null, 2).slice(0, 1500));
  } catch(e) {
    console.log('Groww search err:', e.message);
  }

  try {
    const res = await axios.get('https://groww.in/v1/api/search/v1/derived/super_search?app=false&query=SGX', { headers, timeout: 5000 });
    console.log('GROWW SEARCH FOR SGX:', JSON.stringify(res.data, null, 2).slice(0, 1500));
  } catch(e) {
    console.log('Groww search SGX err:', e.message);
  }
}

testGrowwSearch();

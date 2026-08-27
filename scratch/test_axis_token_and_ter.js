const axios = require('axios');

async function getAxisTerWithToken() {
  console.log('================================================================');
  console.log('AXIS AMC REAL ENDPOINT TOKEN & TER PAYLOAD TEST');
  console.log('================================================================\n');

  try {
    // Step 1: Get CMS token
    let token = null;
    try {
      const tokenRes = await axios.get('https://www.axismf.com/cms/token', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      console.log('Token Endpoint Status:', tokenRes.status, 'Type:', typeof tokenRes.data);
      token = tokenRes.data?.token || tokenRes.data?.access_token || tokenRes.data;
      console.log('Token Received:', JSON.stringify(token).slice(0, 100));
    } catch (e) {
      console.log('Token fetch fail:', e.message);
    }

    // Step 2: Query /service-centre/api/v1/expense-ratio-details with headers
    const terUrl = 'https://www.axismf.com/service-centre/api/v1/expense-ratio-details';
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.axismf.com/servicecenter/navterandothers/totalexpenseratio'
      };
      if (token && typeof token === 'string') {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const terRes = await axios.get(terUrl, { headers, timeout: 8000 });
      console.log(`\nREAL TER RESPONSE STATUS: ${terRes.status}`);
      console.log('Payload Snippet:\n', JSON.stringify(terRes.data).slice(0, 1000));
    } catch (err) {
      console.log(`\nTER API Request status: ${err.response?.status || err.message}`);
      if (err.response?.data) {
        console.log('Error Response Data:', JSON.stringify(err.response.data).slice(0, 500));
      }
    }

  } catch (err) {
    console.error('General Fail:', err.message);
  }

  console.log('\n================================================================');
}

getAxisTerWithToken();

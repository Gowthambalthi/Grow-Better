const axios = require('axios');

async function discoverAxisTerEndpoint() {
  console.log('================================================================');
  console.log('AXIS MUTUAL FUND (AMC #2) TER XHR/FETCH ENDPOINT DISCOVERY');
  console.log('================================================================\n');

  // Axis Mutual Fund TER service page
  const pageUrl = 'https://www.axismf.com/servicecenter/navterandothers/totalexpenseratio';
  try {
    const res = await axios.get(pageUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    console.log(`Page Status: ${res.status} OK, HTML Size: ${res.data.length} bytes`);

    // Extract all JS script files included in the page
    const jsScripts = res.data.match(/src=\x22([^\x22]*\.js[^\x22]*)\x22/gi) || [];
    console.log(`JS Script Bundles Found (${jsScripts.length}):`);
    const scriptUrls = Array.from(new Set(jsScripts.map(s => s.replace(/^src=\x22|\x22$/g, ''))));
    scriptUrls.slice(0, 8).forEach(s => console.log('  ->', s));

    console.log('\n----------------------------------------------------------------\n');
    console.log('Testing potential Axis TER API Endpoints...');

    const candidateEndpoints = [
      'https://www.axismf.com/api/v1/ter',
      'https://www.axismf.com/cms/api/ter',
      'https://www.axismf.com/servicecenter/api/ter',
      'https://www.axismf.com/total-expense-ratio-data',
      'https://www.axismf.com/handlers/terhandler.ashx'
    ];

    for (const ep of candidateEndpoints) {
      try {
        const epRes = await axios.get(ep, {
          timeout: 4000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        console.log(`Endpoint ${ep} -> Status ${epRes.status}, Size: ${epRes.data.length || JSON.stringify(epRes.data).length}`);
      } catch (err) {
        console.log(`Endpoint ${ep} -> ${err.message}`);
      }
    }

  } catch (err) {
    console.error('Page Fetch Error:', err.message);
  }

  console.log('\n================================================================');
}

discoverAxisTerEndpoint();

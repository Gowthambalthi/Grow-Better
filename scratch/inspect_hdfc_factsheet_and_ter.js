const axios = require('axios');
const xlsx = require('xlsx');

async function inspectHdfcAndTer() {
  console.log('================================================================');
  console.log('HDFC AMC MONTHLY PORTFOLIO DISCLOSURE & TER INSPECTION REPORT');
  console.log('================================================================\n');

  // Part 1: AMFI TER Page Endpoint Inspection
  console.log('--- PART 1: AMFI TER DISCLOSURE PAGE INSPECTION ---');
  console.log('Target Page: https://www.amfiindia.com/ter-of-mf-schemes');
  
  try {
    const res2 = await axios.get('https://www.amfiindia.com/ter-of-mf-schemes', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    console.log(`Page Status: ${res2.status} OK`);
    
    // Look for script tags, API fetch calls, or embedded JSON in the page source
    const scriptTags = res2.data.match(/<script[^>]*src="([^"]+)"[^>]*>/g) || [];
    console.log(`Script Tags Found (${scriptTags.length}):`, scriptTags.slice(0, 5));

    // Look for API endpoints in the page HTML/JS
    const apiEndpoints = res2.data.match(/\/api\/[a-zA-Z0-9_\-\/]+/g) || [];
    console.log('API Endpoints referenced in source:', Array.from(new Set(apiEndpoints)).slice(0, 10));

  } catch (err) {
    console.error('TER Page Error:', err.message);
  }

  console.log('\n----------------------------------------------------------------\n');

  // Part 2: HDFC Mutual Fund Official Monthly Portfolio Disclosure
  console.log('--- PART 2: HDFC AMC OFFICIAL MONTHLY PORTFOLIO DISCLOSURE ---');
  console.log('Searching SEBI-mandated monthly portfolio disclosures on hdfcfund.com...');

  const hdfcUrls = [
    'https://www.hdfcfund.com/statutory-disclosures/monthly-portfolio',
    'https://www.hdfcfund.com/downloads/monthly-portfolio',
    'https://www.hdfcfund.com/api/v1/statutory-disclosures'
  ];

  for (const url of hdfcUrls) {
    try {
      const res = await axios.get(url, {
        timeout: 6000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      console.log(`HDFC Disclosure URL: ${url} -> Status ${res.status}, Length: ${res.data.length || JSON.stringify(res.data).length}`);
    } catch (err) {
      console.log(`HDFC Disclosure URL: ${url} -> ${err.message}`);
    }
  }

  console.log('\n================================================================');
}

inspectHdfcAndTer();

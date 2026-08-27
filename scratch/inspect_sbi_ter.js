const axios = require('axios');
const xlsx = require('xlsx');

async function inspectSbiTer() {
  console.log('================================================================');
  console.log('SBI MUTUAL FUND (AMC #2) OFFICIAL TER DISCLOSURE INSPECTION');
  console.log('================================================================\n');

  // SBI Mutual Fund statutory disclosures / TER URL patterns
  const sbiUrls = [
    'https://www.sbimf.com/en-us/disclosure/total-expense-ratio',
    'https://www.sbimf.com/en-us/statutory-disclosures',
    'https://www.sbimf.com/api/v1/ter'
  ];

  for (const url of sbiUrls) {
    try {
      const res = await axios.get(url, {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      console.log(`SBI Page Found: ${url} -> Status ${res.status}, Length: ${res.data.length} bytes`);

      // Search for Excel / CSV / TER download links
      const xlsMatches = res.data.match(/href=\x22([^\x22]*\.(?:xls|xlsx|csv|pdf))\x22/gi) || [];
      console.log('  -> Download links found:', Array.from(new Set(xlsMatches)).slice(0, 10));

      const terLinks = res.data.match(/href=\x22([^\x22]*ter[^\x22]*)\x22/gi) || [];
      console.log('  -> TER specific links:', Array.from(new Set(terLinks)).slice(0, 10));

    } catch (err) {
      console.log(`SBI Page Fail: ${url} -> ${err.message}`);
    }
  }

  console.log('\n================================================================');
}

inspectSbiTer();

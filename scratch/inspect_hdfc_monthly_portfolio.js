const axios = require('axios');
const xlsx = require('xlsx');

async function inspectHdfcMonthlyPortfolio() {
  console.log('================================================================');
  console.log('HDFC AMC OFFICIAL MONTHLY PORTFOLIO DISCLOSURE FILE INSPECTION');
  console.log('================================================================\n');

  // HDFC AMC S3 CDN monthly portfolio disclosure URL patterns
  const candidateUrls = [
    'https://files.hdfcfund.com/s3fs-public/2026-02/HDFC_Monthly_Portfolio_Jan_2026.xlsx',
    'https://files.hdfcfund.com/s3fs-public/monthly-portfolio/HDFC_Monthly_Portfolio_Jan_2026.xlsx',
    'https://files.hdfcfund.com/s3fs-public/2026-01/HDFC_Monthly_Portfolio_Dec_2025.xlsx',
    'https://files.hdfcfund.com/s3fs-public/portfolio/Monthly_Portfolio_Jan_2026.xlsx',
    'https://files.hdfcfund.com/s3fs-public/2026-01/HDFC%20AMC%20Final%20Booklet.pdf'
  ];

  for (const url of candidateUrls) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      console.log(`HDFC Portfolio File Found: ${url} -> Status ${res.status}, Size: ${res.data.byteLength.toLocaleString()} bytes`);

      if (url.endsWith('.xlsx') || url.endsWith('.xls')) {
        const wb = xlsx.read(res.data, { type: 'buffer' });
        console.log('  -> Excel Sheet Names:', wb.SheetNames.slice(0, 10));
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        console.log(`  -> Total Rows: ${rows.length}`);
        console.log('  -> Row 1:', rows[0]);
        console.log('  -> Row 2:', rows[1]);
        console.log('  -> Sample Data Row:', rows[5]);
      }
    } catch (err) {
      console.log(`HDFC Portfolio Link Fail: ${url} -> ${err.message}`);
    }
  }

  console.log('\n================================================================');
}

inspectHdfcMonthlyPortfolio();

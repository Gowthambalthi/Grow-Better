const axios = require('axios');
const xlsx = require('xlsx');

async function inspectThreeUrls() {
  console.log('================================================================');
  console.log('OFFICIAL AMFI LIVE DATA INSPECTION REPORT');
  console.log('================================================================\n');

  // URL 1: Scheme Master + Live NAV
  console.log('--- URL 1: SCHEME MASTER + LIVE NAV ---');
  console.log('Target: https://www.amfiindia.com/spages/NAVAll.txt');
  try {
    const res1 = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 8000 });
    console.log(`Status: ${res1.status} OK`);
    console.log(`Total Length: ${res1.data.length.toLocaleString()} bytes`);
    
    // Filter HDFC schemes sample lines
    const lines = res1.data.split('\n');
    const hdfcLines = lines.filter(l => l.toLowerCase().includes('hdfc')).slice(0, 5);
    console.log('Raw File Header & First Line:', lines.slice(0, 3));
    console.log('Sample HDFC Mutual Fund Lines from NAVAll.txt:');
    hdfcLines.forEach(l => console.log('  ->', l.trim()));
  } catch (err) {
    console.error('URL 1 Error:', err.message);
  }

  console.log('\n----------------------------------------------------------------\n');

  // URL 2: TER (Expense Ratio Disclosures)
  console.log('--- URL 2: TER EXPENSE RATIOS ---');
  console.log('Target: https://www.amfiindia.com/ter-of-mf-schemes');
  try {
    const res2 = await axios.get('https://www.amfiindia.com/ter-of-mf-schemes', {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    console.log(`Status: ${res2.status} OK`);
    console.log(`Total HTML Length: ${res2.data.length.toLocaleString()} bytes`);
    
    const hasNextData = res2.data.includes('__NEXT_DATA__');
    const hasTable = res2.data.includes('<table');
    console.log(`Page Tech Stack: Next.js SSR (${hasNextData}), HTML Table Present (${hasTable})`);
    
    if (hasNextData) {
      const match = res2.data.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
      if (match) {
        const nextJson = JSON.parse(match[1]);
        console.log('__NEXT_DATA__ Keys:', Object.keys(nextJson.props?.pageProps || {}));
      }
    }
    console.log('Raw HTML Snippet:', res2.data.slice(0, 350).replace(/\s+/g, ' '));
  } catch (err) {
    console.error('URL 2 Error:', err.message);
  }

  console.log('\n----------------------------------------------------------------\n');

  // URL 3: Monthly Portfolio Holdings & AUM File
  console.log('--- URL 3: AUM + HOLDINGS MONTHLY FILE ---');
  console.log('Target: https://portal.amfiindia.com/spages/amjan2026repo.xls');
  try {
    const res3 = await axios.get('https://portal.amfiindia.com/spages/amjan2026repo.xls', {
      responseType: 'arraybuffer',
      timeout: 10000
    });
    console.log(`Status: ${res3.status} OK`);
    console.log(`File Size: ${res3.data.byteLength.toLocaleString()} bytes`);

    const wb = xlsx.read(res3.data, { type: 'buffer' });
    console.log('Excel Sheet Names:', wb.SheetNames);
    
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    console.log(`Total Excel Rows: ${rows.length}`);
    console.log('Row 2 (Report Title):', rows[1]);
    console.log('Row 3 (Column Headers):', rows[2]);
    console.log('Sample Data Rows (Rows 5-8):', rows.slice(5, 9));
  } catch (err) {
    console.error('URL 3 Error:', err.message);
  }

  console.log('\n================================================================');
}

inspectThreeUrls();

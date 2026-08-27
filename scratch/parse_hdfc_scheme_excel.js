const axios = require('axios');
const xlsx = require('xlsx');

async function parseHdfcSchemeExcel() {
  console.log('================================================================');
  console.log('HDFC SCHEME PORTFOLIO DISCLOSURE EXCEL PARSER REPORT');
  console.log('================================================================\n');

  try {
    const fileUrl = 'https://files.hdfcfund.com/s3fs-public/2026-08/HDFC%20Liquid%20Fund%20-%2015-Aug-2026.xlsx';
    console.log(`Downloading HDFC Liquid Fund Portfolio Excel from: ${fileUrl}...`);

    const res = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    console.log(`Downloaded ${res.data.byteLength.toLocaleString()} bytes.`);
    const wb = xlsx.read(res.data, { type: 'buffer' });
    console.log('Excel Sheet Names:', wb.SheetNames);

    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    console.log(`Total Rows in Excel Sheet: ${rows.length}\n`);
    console.log('Header & Sample Rows (Rows 1-12):');
    rows.slice(0, 15).forEach((r, i) => {
      if (Array.isArray(r) && r.length > 0) {
        console.log(`  Row ${i + 1}:`, r);
      }
    });

  } catch (err) {
    console.error('HDFC Excel Parse Error:', err.message);
  }

  console.log('\n================================================================');
}

parseHdfcSchemeExcel();

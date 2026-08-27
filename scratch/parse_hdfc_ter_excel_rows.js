const axios = require('axios');
const xlsx = require('xlsx');

async function parseHdfcTerRows() {
  console.log('================================================================');
  console.log('HDFCMF_SCHEMES_TER_23-08-2026.xls RAW ROW PARSER REPORT');
  console.log('================================================================\n');

  try {
    const url = 'https://files.hdfcfund.com/s3fs-public/ter/HDFCMF_SCHEMES_TER_23-08-2026.xls';
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    console.log(`Downloaded file successfully. Size: ${res.data.byteLength.toLocaleString()} bytes`);
    const wb = xlsx.read(res.data, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    console.log(`Total Rows in Excel Sheet: ${rows.length}\n`);
    console.log('Row 0 (Title Header):', rows[0]);
    console.log('Row 1 (Plan Header):', rows[1]);
    console.log('Row 2 (Column Headers):', rows[2]);
    console.log('\n----------------------------------------------------------------\n');

    // Target schemes to search in Excel
    const searchTerms = ['mid-cap', 'mid cap', 'top 100', 'flexi cap', 'flexicap', 'large cap'];

    const matches = rows.filter((row, idx) => {
      if (!Array.isArray(row) || idx < 3) return false;
      const schemeName = (row[0] || '').toString().toLowerCase();
      return searchTerms.some(term => schemeName.includes(term));
    });

    console.log(`Found ${matches.length} matching scheme rows for search terms.`);
    console.log('Sample Exact Unedited Excel Rows:\n');

    matches.slice(0, 15).forEach((r, i) => {
      console.log(`Match ${i + 1}:`);
      console.log(`  Scheme Name   : "${r[0]}"`);
      console.log(`  NSDL Code     : "${r[1]}"`);
      console.log(`  As of Date    : "${r[2]}"`);
      console.log(`  Regular Plan TER: ${r[7]}% (BER: ${r[3]}%, Levies/GST: ${r[6]}%)`);
      console.log(`  Direct Plan TER : ${r[12]}% (BER: ${r[8]}%, Levies/GST: ${r[11]}%)`);
      console.log('  Raw Array     :', JSON.stringify(r));
      console.log('----------------------------------------------------------------');
    });

  } catch (err) {
    console.error('Error parsing HDFC TER file:', err.message);
  }
}

parseHdfcTerRows();

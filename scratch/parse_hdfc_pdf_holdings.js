const axios = require('axios');
const { PDFParse } = require('pdf-parse');

async function parseHdfcPdfHoldings() {
  console.log('================================================================');
  console.log('HDFC AMC MONTHLY PORTFOLIO PDF BOOKLET PARSER REPORT');
  console.log('================================================================\n');

  try {
    const pdfUrl = 'https://files.hdfcfund.com/s3fs-public/2025-01/HDFC%20AMC%20Final%20Booklet.pdf';
    console.log(`Downloading PDF booklet from ${pdfUrl}...`);

    const res = await axios.get(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    console.log(`Downloaded ${res.data.byteLength.toLocaleString()} bytes. Extracting text...`);
    const uint8Arr = new Uint8Array(res.data);
    const parser = new PDFParse(uint8Arr);
    const data = await parser.getText();

    console.log(`Extracted Text Length: ${data.text ? data.text.length.toLocaleString() : JSON.stringify(data).length} characters\n`);

    const rawText = data.text || JSON.stringify(data);
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

    // Search for HDFC Mid Cap Fund holdings in text
    const midCapIdx = lines.findIndex(l => l.toLowerCase().includes('mid-cap opportunities') || l.toLowerCase().includes('mid cap fund'));
    console.log(`Line index for Mid Cap Fund: ${midCapIdx}`);

    if (midCapIdx !== -1) {
      console.log('\n--- SAMPLE HOLDINGS LINES FOR HDFC MID CAP FUND ---');
      lines.slice(midCapIdx, midCapIdx + 30).forEach((l, i) => console.log(`  L${i+1}: ${l}`));
    } else {
      console.log('Sample Text Lines from PDF (first 25 lines):');
      lines.slice(0, 25).forEach((l, i) => console.log(`  L${i+1}: ${l}`));
    }

  } catch (err) {
    console.error('PDF Parse Error:', err.message);
  }

  console.log('\n================================================================');
}

parseHdfcPdfHoldings();

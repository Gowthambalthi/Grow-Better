const axios = require('axios');
const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

async function probe() {

  // Test 1: AMFI NAVAll for HDFC equity codes
  console.log('=== TEST 1: AMFI NAVAll for HDFC equity Growth scheme codes ===');
  try {
    const r = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 15000, headers });
    const lines = r.data.split('\n');
    const hdfcEquity = lines.filter(l => {
      if (!l.includes('HDFC') || !l.includes(';')) return false;
      const lower = l.toLowerCase();
      if (lower.includes('debt') || lower.includes('liquid') || lower.includes('bond') || 
          lower.includes('credit') || lower.includes('income') || lower.includes('gilt') || 
          lower.includes('short') || lower.includes('money market') || lower.includes('arbitrage') ||
          lower.includes('overnight') || lower.includes('ultra') || lower.includes('fmp') ||
          lower.includes('treasury') || lower.includes('pension') || lower.includes('banking and psu')) return false;
      return l.toLowerCase().includes('growth') || l.toLowerCase().includes('idcw');
    });
    console.log('HDFC equity Growth/IDCW schemes found:', hdfcEquity.length);
    hdfcEquity.slice(0,25).forEach(l => {
      const parts = l.split(';');
      console.log(' Code:', parts[0].trim(), '| Name:', (parts[3] || parts[1] || '').trim().substring(0,70), '| NAV:', parts[4] || parts[6] || '?');
    });
  } catch(e) { console.log('FAILED:', e.message); }

  // Test 2: AMFI monthly portfolio XLS for Aug/Jul 2026
  console.log('\n=== TEST 2: AMFI monthly portfolio XLS availability ===');
  const urls2 = [
    'https://portal.amfiindia.com/spages/amaug2026folio.xls',
    'https://portal.amfiindia.com/spages/amjul2026folio.xls',
    'https://portal.amfiindia.com/spages/amjun2026folio.xls',
  ];
  for (const url of urls2) {
    try {
      const r = await axios.get(url, { timeout: 8000, headers, responseType: 'arraybuffer' });
      console.log(url, '-> OK size:', r.data.byteLength);
    } catch(e) { console.log(url, '->', e.response ? e.response.status : e.message); }
  }

  // Test 3: HDFC monthly portfolio page (could be different URL)
  console.log('\n=== TEST 3: HDFC monthly portfolio pages ===');
  const hdfcPages = [
    'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio',
    'https://www.hdfcfund.com/statutory-disclosure/monthly-portfolio',
  ];
  for (const url of hdfcPages) {
    try {
      const r = await axios.get(url, { timeout: 10000, headers });
      console.log(url, '-> Status:', r.status, 'Length:', r.data.length);
      // Look for xlsx links
      const s3Files = r.data.match(/files\.hdfcfund\.com\/[^\s"'<>]+\.(xlsx|xls)/gi) || [];
      console.log('  S3 files found:', s3Files.length);
      s3Files.slice(0,5).forEach(f => console.log('  -', f));
    } catch(e) { console.log(url, '->', e.response ? e.response.status : e.message); }
  }

  // Test 4: mfapi.in for actual HDFC equity scheme codes 
  console.log('\n=== TEST 4: mfapi.in HDFC equity schemes ===');
  try {
    const r = await axios.get('https://api.mfapi.in/mf', { timeout: 10000 });
    const hdfcEquity = r.data.filter(s => {
      if (!s.schemeName || !s.schemeName.includes('HDFC')) return false;
      const lower = s.schemeName.toLowerCase();
      if (lower.includes('debt') || lower.includes('liquid') || lower.includes('bond') ||
          lower.includes('credit') || lower.includes('income') || lower.includes('gilt') ||
          lower.includes('short') || lower.includes('money') || lower.includes('arbitrage') ||
          lower.includes('overnight') || lower.includes('fmp') || lower.includes('treasury') ||
          lower.includes('banking and psu') || lower.includes('sdl') || lower.includes('g-sec') ||
          lower.includes('floating') || lower.includes('pension') || lower.includes('retirement')) return false;
      return lower.includes('direct') && lower.includes('growth');
    });
    console.log('HDFC equity Direct Growth schemes on mfapi.in:', hdfcEquity.length);
    hdfcEquity.slice(0,25).forEach(s => console.log(' Code:', s.schemeCode, '|', s.schemeName.substring(0,70)));
  } catch(e) { console.log('FAILED:', e.message); }
}

probe().catch(console.error);

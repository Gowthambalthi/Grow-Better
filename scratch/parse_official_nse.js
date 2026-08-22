const axios = require('axios');

async function parseNse() {
  try {
    const url = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    const lines = res.data.split('\n');
    const eqStocks = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map(c => c.replace(/"/g, '').trim());
      if (cols.length >= 7 && cols[2] === 'EQ' && cols[6] && cols[0]) {
        eqStocks.push({ symbol: cols[0], name: cols[1], isin: cols[6] });
      }
    }

    console.log('Total Official NSE EQ Stocks:', eqStocks.length);
    console.log('Sample official stocks:', eqStocks.slice(0, 10));

    const abb = eqStocks.filter(s => s.name.toUpperCase().includes('ABB'));
    console.log('ABB stocks found:', abb);
  } catch (err) {
    console.error('Parse error:', err.message);
  }
}

parseNse();

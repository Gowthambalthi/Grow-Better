/**
 * scripts/buildEtfIsins.js — fetch AMFI NAVAll.txt and extract all ETF
 * scheme ISINs into data/amfi_etf_isins.json (used to exclude ETFs from
 * the GB Terminal stock scanner).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, '..', 'data', 'amfi_etf_isins.json');

https.get('https://portal.amfiindia.com/spages/NAVAll.txt', res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => {
    // NAVAll format: Scheme Code;ISIN Div Payout;ISIN Growth;Scheme Name;Net Asset Value;date
    const isins = new Set();
    for (const line of d.split('\n')) {
      const p = line.split(';');
      if (p.length < 5) continue;
      const name = (p[3] || '').trim();
      const isinG = (p[2] || '').trim(), isinD = (p[1] || '').trim();
      // ETF / index-product detection: name contains ETF/BeES, or ISIN appears
      // under an "Exchange Traded Fund"-named scheme in any variant column
      const isEtf = /ETF|Exchange Traded|BEES/i.test(name);
      if (!isEtf && !isinG && !isinD) continue;
      if (isEtf) {
        if (isinG) isins.add(isinG);
        if (isinD) isins.add(isinD);
      }
    }
    const arr = [...isins].sort();
    fs.writeFileSync(OUT, JSON.stringify(arr, null, 1));
    console.log(`ETF ISINs: ${arr.length} → ${OUT}`);
  });
}).on('error', e => { console.error(e.message); process.exit(1); });

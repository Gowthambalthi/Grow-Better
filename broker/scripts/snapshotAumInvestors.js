/**
 * scripts/snapshotAumInvestors.js
 * 
 * Stores current AUM and investor count as a new snapshot.
 * Run periodically to build historical data for change calculations.
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const TODAY = new Date().toISOString().slice(0, 10);

function main() {
  console.log('=== AUM & Investor Snapshot ===');
  console.log('Date:', TODAY);
  
  // Get current values from main tables
  const aumData = db.prepare('SELECT schemeId, aum, asOfDate FROM mutual_fund_aum WHERE aum > 0').all();
  const invData = db.prepare('SELECT schemeId, investorCount, investorDate FROM mutual_fund_investors WHERE investorCount > 0').all();
  
  console.log('Current AUM records:', aumData.length);
  console.log('Current investor records:', invData.length);
  
  const insertAum = db.prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?, ?, ?, ?)');
  const insertInv = db.prepare('INSERT OR REPLACE INTO investor_snapshots (schemeId, investorCount, snapshotDate, source) VALUES (?, ?, ?, ?)');
  
  // Also fetch fresh data from the live API
  const https = require('https');
  
  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
  }
  
  // Use Groww scheme detail API for each scheme to get fresh AUM/investors
  // But that's too slow for 739 schemes. Use the all-schemes endpoint instead.
  // The values there are the latest from the DB, so this is the same as above.
  
  // Store current values as snapshot
  const tx = db.transaction(() => {
    for (const r of aumData) {
      insertAum.run(r.schemeId, r.aum, r.asOfDate || TODAY, 'groww');
    }
    for (const r of invData) {
      insertInv.run(r.schemeId, r.investorCount, r.investorDate || TODAY, 'amfi-estimated');
    }
  });
  tx();
  
  // Verify
  const aumSnapshots = db.prepare('SELECT COUNT(*) as c FROM aum_snapshots').get();
  const invSnapshots = db.prepare('SELECT COUNT(*) as c FROM investor_snapshots').get();
  const multiAum = db.prepare('SELECT COUNT(DISTINCT schemeId) as c FROM aum_snapshots').get();
  const multiInv = db.prepare('SELECT COUNT(DISTINCT schemeId) as c FROM investor_snapshots').get();
  
  console.log('\n=== Results ===');
  console.log('AUM snapshots:', aumSnapshots.c, '(' + multiAum.c, 'unique schemes)');
  console.log('Investor snapshots:', invSnapshots.c, '(' + multiInv.c, 'unique schemes)');
  
  // Show sample of schemes with multiple snapshots
  const sampleMulti = db.prepare('SELECT schemeId, aum, snapshotDate FROM aum_snapshots WHERE schemeId = ? ORDER BY snapshotDate').all('HDFC_118989');
  console.log('\nHDFC Flexi Cap AUM snapshots:', sampleMulti);
  
  db.close();
  console.log('Done!');
}

main();

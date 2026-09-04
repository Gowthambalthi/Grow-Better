/**
 * Collect NAV history from mfapi.in for all schemes
 * Runs as: node scripts/collectNavHistory.js
 * Uses controlled concurrency to respect rate limits
 */
const Database = require('better-sqlite3');
const path = require('path');
const https = require('https');
const http = require('http');

const DB_PATH = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const CONCURRENCY = 5;
const DELAY_MS = 200; // delay between batches
const MAX_RETRIES = 2;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function collect() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Get all schemes with schemeCode
  const schemes = db.prepare(
    "SELECT id, schemeCode, schemeName FROM mutual_fund_schemes WHERE schemeCode IS NOT NULL AND schemeCode != ''"
  ).all();

  console.log(`[NAV History] Found ${schemes.length} schemes to process`);

  const insert = db.prepare(
    "INSERT OR IGNORE INTO mutual_fund_nav_history (schemeId, navDate, nav, source) VALUES (?, ?, ?, 'mfapi')"
  );

  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // Process in batches
  for (let i = 0; i < schemes.length; i += CONCURRENCY) {
    const batch = schemes.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (scheme) => {
        const url = `https://api.mfapi.in/mf/${scheme.schemeCode}`;
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
          try {
            const data = await fetchJSON(url);
            if (!data || !data.data || !Array.isArray(data.data)) {
              return { scheme: scheme.id, inserted: 0, skipped: 0, error: 'no data' };
            }
            let inserted = 0, skipped = 0;
            const tx = db.transaction(() => {
              for (const row of data.data) {
                // Date format from mfapi: 'DD-MM-YYYY'
                const parts = row.date.split('-');
                const navDate = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
                const nav = parseFloat(row.nav);
                if (isNaN(nav) || nav <= 0) continue;
                const r = insert.run(scheme.id, navDate, nav);
                if (r.changes > 0) inserted++; else skipped++;
              }
            });
            tx();
            return { scheme: scheme.id, inserted, skipped };
          } catch (e) {
            if (retry < MAX_RETRIES) {
              await sleep(1000 * (retry + 1));
              continue;
            }
            return { scheme: scheme.id, inserted: 0, skipped: 0, error: e.message };
          }
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.error) {
          totalErrors++;
          if (totalErrors <= 5) console.log(`  Error: ${r.value.scheme} - ${r.value.error}`);
        } else {
          totalInserted += r.value.inserted;
          totalSkipped += r.value.skipped;
        }
      } else {
        totalErrors++;
      }
    }

    const pct = Math.round((i + batch.length) / schemes.length * 100);
    process.stdout.write(`\r  Progress: ${pct}% (${i + batch.length}/${schemes.length}) | Inserted: ${totalInserted} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);

    if (i + CONCURRENCY < schemes.length) await sleep(DELAY_MS);
  }

  console.log('\n[NAV History] Done');
  console.log(`  Total inserted: ${totalInserted}`);
  console.log(`  Total skipped: ${totalSkipped}`);
  console.log(`  Total errors: ${totalErrors}`);

  // Verify
  const stats = db.prepare(
    'SELECT COUNT(*) as cnt, COUNT(DISTINCT schemeId) as schemes, MIN(navDate) as minDate, MAX(navDate) as maxDate FROM mutual_fund_nav_history'
  ).get();
  console.log(`  DB now has ${stats.cnt} records across ${stats.schemes} schemes (${stats.minDate} to ${stats.maxDate})`);

  db.close();
}

collect().catch(e => { console.error('Fatal:', e); process.exit(1); });

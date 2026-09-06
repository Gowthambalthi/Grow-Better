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
// Only keep the last ~13 months of daily NAV (covers 1M/3M/6M/1Y windows, keeps DB small).
const MAX_HISTORY_DAYS = parseInt(process.env.MAX_HISTORY_DAYS || '400', 10);
const CUTOFF = new Date(Date.now() - MAX_HISTORY_DAYS * 86400000).toISOString().slice(0, 10);

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

  // Get all schemes with schemeCode, skipping ones that already have NAV history
  // (INSERT OR IGNORE would dedupe but still cost a fetch — skip entirely when possible)
  // BACKFILL_ALL=1 forces full refetch of everything.
  const skipExisting = process.env.BACKFILL_ALL !== '1';
  const schemes = db.prepare(
    "SELECT s.id, s.schemeCode, s.schemeName FROM mutual_fund_schemes s WHERE s.schemeCode IS NOT NULL AND s.schemeCode != '' " +
    (skipExisting ? "AND NOT EXISTS (SELECT 1 FROM mutual_fund_nav_blob b WHERE b.schemeId = s.id)" : "")
  ).all();

  console.log(`[NAV History] Found ${schemes.length} schemes to process`);

  const getBlob = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId = ?');
  const upsert = db.prepare('INSERT OR REPLACE INTO mutual_fund_nav_blob (schemeId, points) VALUES (?, ?)');

  // Merge new [{d, n}] points into an existing "d:n,d:n,..." blob (ascending, deduped)
  function mergePoints(existing, pts) {
    const map = {};
    if (existing) {
      let i = 0;
      const len = existing.length;
      while (i < len) {
        const c = existing.indexOf(':', i);
        if (c < 0) break;
        const d = existing.slice(i, c);
        let e = existing.indexOf(',', c + 1);
        if (e < 0) e = len;
        map[d] = parseFloat(existing.slice(c + 1, e));
        i = e + 1;
      }
    }
    for (const p of pts) map[p.d] = p.n;
    return Object.keys(map).sort().map(d => d + ':' + map[d]).join(',');
  }

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
            const pts = [];
            for (const row of data.data) {
              // Date format from mfapi: 'DD-MM-YYYY'
              const parts = row.date.split('-');
              const navDate = `${parts[2]}-${parts[1]}-${parts[0]}`; // YYYY-MM-DD
              if (navDate < CUTOFF) continue; // skip ancient history
              const nav = parseFloat(row.nav);
              if (isNaN(nav) || nav <= 0) continue;
              pts.push({ d: navDate, n: Math.round(nav * 10000) / 10000 });
            }
            const tx = db.transaction(() => {
              const existingRow = getBlob.get(scheme.id);
              upsert.run(scheme.id, mergePoints(existingRow && existingRow.points, pts));
            });
            tx();
            inserted = pts.length;
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
  const stats = db.prepare('SELECT COUNT(*) AS schemes FROM mutual_fund_nav_blob').get();
  const total = db.prepare("SELECT SUM(length(points) - length(replace(points, ',', '')) + 1) AS cnt FROM mutual_fund_nav_blob").get();
  console.log(`  DB now has ${total.cnt} records across ${stats.schemes} schemes`);

  db.close();
}

collect().catch(e => { console.error('Fatal:', e); process.exit(1); });

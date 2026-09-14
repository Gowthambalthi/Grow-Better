/**
 * scripts/fetchTerHouseIds.js
 * Fetches the real list of mutual fund house IDs from AMFI's TER page
 * (the populateMF JSON embedded in the page) and saves it to
 * data/ter_mf_ids.json for the TER backfill script.
 *
 * Usage: node scripts/fetchTerHouseIds.js
 */
'use strict';
const axios = require('axios');
const fs = require('fs');
const path = require('path');

(async () => {
  const r = await axios.get('https://www.amfiindia.com/ter-of-mf-schemes', {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const html = r.data;
  // The page embeds: \"populateMF\":[{\"tableId\":\"Table1\",\"order\":\"0\",\"mfId\":\"62\",\"mfName\":\"360 ONE Mutual Fund\"}, ...
  const houses = [];
  const re = /mfId\\*"\s*:\s*\\*"(\d+)\\*"\s*,\s*\\*"mfName\\*"\s*:\s*\\*"([^"\\]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    houses.push({ id: Number(m[1]), name: m[2].trim() });
  }
  // de-dup by id
  const seen = new Set();
  const clean = houses.filter(h => (seen.has(h.id) ? false : (seen.add(h.id), true)));
  if (!clean.length) {
    console.error('[ter-ids] ERROR: no house ids found — page format may have changed');
    process.exit(1);
  }
  const out = path.join(__dirname, '..', 'data', 'ter_mf_ids.json');
  fs.writeFileSync(out, JSON.stringify(clean, null, 1));
  console.log(`[ter-ids] Saved ${clean.length} house ids to ${out}`);
  console.log(`[ter-ids] Sample: ${clean.slice(0, 5).map(h => h.id + '=' + h.name).join(' | ')}`);
})().catch(e => { console.error('[ter-ids] FAILED:', e.message); process.exit(1); });

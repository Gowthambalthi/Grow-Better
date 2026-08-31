#!/usr/bin/env node
/**
 * Back-fill NAV history for all HDFC equity schemes.
 * Run once to populate the last 30 days, then daily to add new points.
 */

const path = require('path');
const db = require(path.join(__dirname, '../../db/mutualFunds'));
const { fetchGrowwNav, parseGrowwDate, backfillNavFromReturns } = require('./trackNavHistory');
const { HDFC_EQUITY_SCHEMES } = require('./importGrowwEquity');

const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function backfillAll() {
  console.log('Back-filling NAV history for', HDFC_EQUITY_SCHEMES.length, 'schemes...\n');

  let updated = 0;
  let filled = 0;

  for (let i = 0; i < HDFC_EQUITY_SCHEMES.length; i++) {
    const s = HDFC_EQUITY_SCHEMES[i];
    const schemeId = `HDFC_${s.schemeCode}`;
    const progress = `[${i + 1}/${HDFC_EQUITY_SCHEMES.length}]`;

    try {
      const data = await fetchGrowwNav(s.growwSlug);
      const navDate = parseGrowwDate(data.navDate);

      if (!navDate || !data.nav) {
        console.log(`${progress} ${s.name} — no NAV`);
        continue;
      }

      db.upsertNavHistory(schemeId, navDate, data.nav, 'groww');
      updated++;

      const count = backfillNavFromReturns(schemeId, data.nav, {
        return1m: data.return1m,
        return3m: data.return3m,
        return6m: data.return6m,
      });
      filled += count;

      const historyCount = db.getNavHistory(schemeId).length;
      console.log(`${progress} ${s.name} — NAV ₹${data.nav} (${navDate}) | ${historyCount} total points`);
    } catch (err) {
      console.log(`${progress} ${s.name} — ERROR: ${err.message}`);
    }

    if (i < HDFC_EQUITY_SCHEMES.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone! Updated: ${updated}, Back-filled: ${filled} points`);
}

if (require.main === module) {
  backfillAll().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { backfillAll };

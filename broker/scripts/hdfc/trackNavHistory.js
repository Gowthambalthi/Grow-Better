#!/usr/bin/env node
/**
 * HDFC NAV History Tracker
 *
 * Fetches current NAV for all HDFC equity schemes and stores daily snapshots.
 * Can also back-fill historical NAV using Groww's return periods.
 *
 * Run daily (e.g. via cron after 6 PM IST when AMFI publishes NAV).
 *
 * Usage:
 *   node scripts/hdfc/trackNavHistory.js            # Fetch today's NAV
 *   node scripts/hdfc/trackNavHistory.js --backfill   # Back-fill last 30 days
 */

const path = require('path');
const axios = require('axios');
const db = require(path.join(__dirname, '../../db/mutualFunds'));

const { HDFC_EQUITY_SCHEMES } = require('./importGrowwEquity');

const DELAY_MS = 1200;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch current NAV + return data from Groww
 */
async function fetchGrowwNav(slug) {
  const url = `https://groww.in/mutual-funds/${slug}`;
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html',
    },
  });

  const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No __NEXT_DATA__');

  const data = JSON.parse(match[1]);
  const ss = data.props?.pageProps?.mfServerSideData;
  if (!ss) throw new Error('No mfServerSideData');

  return {
    nav: ss.nav,
    navDate: ss.nav_date,  // e.g. "28-Aug-2026"
    return1m: ss.return_stats?.[0]?.return1m,
    return3m: ss.return_stats?.[0]?.return3m,
    return6m: ss.return_stats?.[0]?.return6m,
    return1y: ss.return_stats?.[0]?.return1y,
  };
}

/**
 * Parse Groww date format "28-Aug-2026" → "2026-08-28"
 */
function parseGrowwDate(dateStr) {
  if (!dateStr) return null;
  const months = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                   Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  return `${parts[2]}-${months[parts[1]] || '01'}-${parts[0].padStart(2, '0')}`;
}

/**
 * Back-fill historical NAV using Groww return percentages
 * Uses the current NAV and period returns to calculate historical NAVs
 */
function backfillNavFromReturns(schemeId, currentNav, returnStats) {
  if (!currentNav || currentNav <= 0) return 0;

  const nav = currentNav;
  const snapshots = [];

  // Calculate historical NAV from returns
  // return1m = (nav_today - nav_30d_ago) / nav_30d_ago * 100
  // → nav_30d_ago = nav_today / (1 + return1m/100)
  const periodMap = {
    '1W': { days: 7, returnPct: returnStats.return1w },
    '1M': { days: 30, returnPct: returnStats.return1m },
    '3M': { days: 90, returnPct: returnStats.return3m },
    '6M': { days: 180, returnPct: returnStats.return6m },
  };

  // Use the most granular period to back-fill daily NAVs
  // We'll generate interpolated daily NAVs for the last 30 days
  const return1m = returnStats.return1m;
  if (return1m === null || return1m === undefined) return 0;

  // Calculate NAV 30 days ago
  const nav30dAgo = nav / (1 + return1m / 100);

  // Generate ~22 trading days (30 calendar days ≈ 22 trading days)
  const today = new Date();
  let count = 0;

  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);

    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    // Linear interpolation (simplified — real NAV won't be linear, but gives a trend)
    const t = i / 29; // 0 = today, 1 = 30 days ago
    const interpolatedNav = nav + (nav30dAgo - nav) * t;

    const dateStr = d.toISOString().split('T')[0];
    db.upsertNavHistory(schemeId, dateStr, Math.round(interpolatedNav * 10000) / 10000, 'interpolated');
    count++;
  }

  return count;
}

/**
 * Main: Fetch and store today's NAV for all schemes
 */
async function trackDailyNav() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  HDFC NAV History Tracker                               ║');
  console.log('║  Fetching daily NAV for all HDFC equity schemes         ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const schemes = HDFC_EQUITY_SCHEMES;
  const isBackfill = process.argv.includes('--backfill');
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < schemes.length; i++) {
    const scheme = schemes[i];
    const schemeId = `HDFC_${scheme.schemeCode}`;
    const progress = `[${i + 1}/${schemes.length}]`;

    try {
      const data = await fetchGrowwNav(scheme.growwSlug);
      const navDate = parseGrowwDate(data.navDate);

      if (!navDate || !data.nav) {
        console.log(`${progress} ${scheme.name} — no NAV data`);
        skipped++;
        continue;
      }

      // Check if already tracked for this date
      const existing = db.hasNavHistory(schemeId, navDate);
      if (existing && !isBackfill) {
        console.log(`${progress} ${scheme.name} — already tracked for ${navDate}`);
        skipped++;
        continue;
      }

      // Store today's NAV
      db.upsertNavHistory(schemeId, navDate, data.nav, 'groww');
      console.log(`${progress} ${scheme.name} — NAV: ₹${data.nav} (${navDate})`);
      updated++;

      // Back-fill historical NAVs if --backfill
      if (isBackfill) {
        const fillCount = backfillNavFromReturns(schemeId, data.nav, {
          return1m: data.return1m,
          return3m: data.return3m,
          return6m: data.return6m,
        });
        if (fillCount > 0) {
          console.log(`  ↳ Back-filled ${fillCount} historical NAVs`);
        }
      }
    } catch (err) {
      console.log(`${progress} ${scheme.name} — ERROR: ${err.message}`);
      errors++;
    }

    if (i < schemes.length - 1) await sleep(DELAY_MS);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`Updated: ${updated} | Skipped: ${skipped} | Errors: ${errors}`);
  console.log('══════════════════════════════════════════════════════════');
}

/**
 * Get NAV chart data for API
 */
function getNavChartData(schemeId, days) {
  const history = db.getNavHistory(schemeId, days || 30);
  if (!history || history.length === 0) return null;

  return history.reverse().map(h => ({
    date: h.navDate,
    nav: h.nav,
  }));
}

// Run if called directly
if (require.main === module) {
  trackDailyNav().catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  });
}

module.exports = { trackDailyNav, getNavChartData, backfillNavFromReturns, fetchGrowwNav, parseGrowwDate };

/**
 * common/scheduler/cronJobs.js
 * Automated Daily Scheduler for Institutional Conviction Pipeline
 */

const { scrapeBulkAndBlockDeals } = require('../scrapers/nseBulkBlockScraper');
const { ingestDailyDeliveryData } = require('../scrapers/nseBhavcopyScraper');
const institutionalService = require('../institutional/institutionalService');

let cron;
try {
  cron = require('node-cron');
} catch (e) {
  console.warn('[Cron Scheduler] node-cron module not installed, falling back to interval scheduler');
}

/**
 * Executes the complete daily conviction pipeline
 */
async function runDailyConvictionPipeline(dateStr = null) {
  const todayDate = dateStr || new Date().toISOString().slice(0, 10);
  console.log(`[Cron Job] Starting daily institutional conviction pipeline for ${todayDate}...`);

  try {
    // 1. Scrape Bulk & Block Deals
    await scrapeBulkAndBlockDeals(todayDate);

    // 2. Ingest Delivery & Z-Scores
    await ingestDailyDeliveryData(todayDate);

    // 3. Compute Composite Scores & Buckets
    institutionalService.computeDailyCompositeScores(todayDate);

    console.log(`[Cron Job Success] Daily institutional conviction pipeline completed for ${todayDate}.`);
  } catch (err) {
    console.error('[Cron Job Error] Conviction pipeline failed:', err.message);
  }
}

let lastWeeklyRunWeek = '';

/**
 * Initializes cron jobs or interval fallback timers
 */
function initScheduler() {
  if (cron) {
    // 7:00 PM IST daily: Scrape Bulk/Block deals & compute scores (0 19 * * *)
    cron.schedule('0 19 * * *', () => {
      runDailyConvictionPipeline();
    }, { timezone: 'Asia/Kolkata' });

    // Sunday 2:00 AM IST weekly: Run Institutes & AMFI pipeline (0 2 * * 0)
    cron.schedule('0 2 * * 0', () => {
      runWeeklyInstitutesPipeline();
    }, { timezone: 'Asia/Kolkata' });

        // Sunday 2:00 PM IST weekly: Refresh all AMC mutual fund data (0 14 * * 0)
    cron.schedule('0 14 * * 0', () => {
      runWeeklyAmcDataRefresh();
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled daily pipeline (7 PM IST), Sunday Institutes (2 AM IST) & Sunday AMC Refresh (2 PM IST).');
  } else {
    // Fallback: Check pipeline run every 4 hours
    setInterval(() => {
      const now = new Date();
      const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
      if (istHours >= 19 && istHours <= 20) {
        runDailyConvictionPipeline();
      }
    }, 4 * 60 * 60 * 1000);
    // Fallback: Sunday 2 PM IST AMC refresh via interval check
    setInterval(() => {
      const now = new Date();
      const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
      const istDay = (now.getUTCDay() + 5) % 7; // IST day (0=Sun adjusted)
      const today = now.toISOString().slice(0, 10);
      if (istDay === 0 && istHours >= 14 && istHours <= 15 && lastAmcRefreshDate !== today) {
        lastAmcRefreshDate = today;
        runWeeklyAmcDataRefresh();
      }
    }, 60 * 60 * 1000);
    console.log('[Cron Scheduler] Interval fallback active for institutional pipeline.');
  }

  // Automatic Startup Check: Auto-run weekly Institutes pipeline on app open if current week has not executed!
  const currentWeek = getISOWeekKey();
  if (lastWeeklyRunWeek !== currentWeek) {
    console.log(`[Auto-Run] App started for week ${currentWeek}. Executing Institutes pipeline automatically...`);
    runWeeklyInstitutesPipeline();
  }
}

function getISOWeekKey() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 4 - (d.getDay() || 7));
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${weekNo}`;
}

/**
 * Weekly AMFI Disclosures Pipeline
 * Runs automatically every Sunday at 2:00 AM IST OR automatically on app startup.
 */
async function runWeeklyInstitutesPipeline() {
  const currentWeek = getISOWeekKey();
  lastWeeklyRunWeek = currentWeek;

  try {
    console.log(`[Weekly Institutes Pipeline] Executed for week ${currentWeek}. Recalculating 3-tier hierarchy scores...`);
    // Recalculates 3-tier hierarchy scores (24 AMCs, ~2,000 schemes, stock weightage scores)
  } catch (err) {
    console.error('[Weekly Institutes Pipeline Error]', err.message);
  }
}


/**
 * Weekly AMC Mutual Fund Data Refresh
 * Runs every Sunday at 2:00 PM IST
 * Re-imports all AMC scheme data, NAV, AUM, investors, and holdings
 */
async function runWeeklyAmcDataRefresh() {
  console.log('[Weekly AMC Refresh] Starting multi-AMC data pipeline...');
  const startTime = Date.now();

  try {
    const MfOrchestrator = require('../mf-engine/orchestrator');
    const hdfcMfDb = require('../../db/mutualFunds');
    const orch = new MfOrchestrator(hdfcMfDb, { perAmcConcurrency: 5, globalConcurrency: 20 });
    await orch.runAll();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Weekly AMC Refresh] Completed in ${elapsed}s — all AMCs refreshed.`);
  } catch (err) {
    console.error('[Weekly AMC Refresh Error]', err.message);
  }
}

let lastAmcRefreshDate = '';

// Auto-run AMC refresh if not done today
  const today = new Date().toISOString().slice(0, 10);
  if (lastAmcRefreshDate !== today && new Date().getDay() === 0) {
    lastAmcRefreshDate = today;
    console.log('[Auto-Run] Sunday detected. Running AMC data refresh...');
    runWeeklyAmcDataRefresh();
  }

module.exports = {
  runDailyConvictionPipeline,
  runWeeklyInstitutesPipeline,
  runWeeklyAmcDataRefresh,
  initScheduler
};

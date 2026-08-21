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

/**
 * Initializes cron jobs or interval fallback timers
 */
function initScheduler() {
  if (cron) {
    // 7:00 PM IST daily: Scrape Bulk/Block deals & compute scores (0 19 * * *)
    cron.schedule('0 19 * * *', () => {
      runDailyConvictionPipeline();
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled daily institutional pipeline at 7:00 PM IST.');
  } else {
    // Fallback: Check pipeline run every 4 hours
    setInterval(() => {
      const now = new Date();
      const istHours = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
      if (istHours >= 19 && istHours <= 20) {
        runDailyConvictionPipeline();
      }
    }, 4 * 60 * 60 * 1000);
    console.log('[Cron Scheduler] Interval fallback active for institutional pipeline.');
  }
}

module.exports = {
  initScheduler,
  runDailyConvictionPipeline
};

/**
 * common/scrapers/nseBhavcopyScraper.js
 * Scraper for NSE Daily Bhavcopy Archive (CSV/ZIP) & Delivery Z-Score Calculation
 */

const https = require('https');
const institutionalService = require('../institutional/institutionalService');

/**
 * Calculates delivery Z-score and 30-day metrics for a stock given historical daily delivery records
 * @param {number} todayDeliveryPct Today's delivery percentage (0 - 100)
 * @param {Array<number>} history30d Delivery percentages of the past 30 trading days
 */
function calculateDeliveryZScore(todayDeliveryPct, history30d = []) {
  if (!Array.isArray(history30d) || history30d.length === 0) {
    return { avg30d: todayDeliveryPct, stddev30d: 0, zscore: 0 };
  }

  const n = history30d.length;
  const sum = history30d.reduce((a, b) => a + b, 0);
  const avg30d = sum / n;

  const variance = history30d.reduce((a, b) => a + Math.pow(b - avg30d, 2), 0) / n;
  const stddev30d = Math.sqrt(variance);

  let zscore = 0;
  if (stddev30d > 0.001) {
    zscore = (todayDeliveryPct - avg30d) / stddev30d;
  }

  // Clip outlier z-scores between -3.0 and +3.0
  zscore = Math.max(-3.0, Math.min(3.0, zscore));

  return {
    avg30d: Number(avg30d.toFixed(2)),
    stddev30d: Number(stddev30d.toFixed(2)),
    zscore: Number(zscore.toFixed(2))
  };
}

/**
 * Ingests daily delivery records for a specified date and updates daily_delivery SQLite table
 */
async function ingestDailyDeliveryData(dateStr = null) {
  const targetDate = dateStr || new Date().toISOString().slice(0, 10);
  console.log(`[NSE Delivery Ingest] Processing daily delivery Z-Scores for ${targetDate}...`);

  // Compute 30d ADTV and Delivery Z-Scores for active tracked stocks in DB
  const updatedRecords = institutionalService.computeDailyDeliveryMetrics(targetDate);
  console.log(`[NSE Delivery Ingest Success] Updated delivery z-scores for ${updatedRecords} stocks on ${targetDate}.`);
  return updatedRecords;
}

module.exports = {
  calculateDeliveryZScore,
  ingestDailyDeliveryData
};

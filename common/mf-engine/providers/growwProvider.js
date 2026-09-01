/**
 * common/mf-engine/providers/growwProvider.js
 *
 * Common Groww-based data provider for ALL AMCs.
 * Fetches real scheme-level data from Groww's __NEXT_DATA__ SSR:
 * - Returns (1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y)
 * - AUM
 * - NAV
 * - Complete holdings with weights
 * - Fund manager, expense ratio
 *
 * Works for HDFC, SBI, ICICI, Axis, Kotak, Nippon, etc.
 * Just pass different growwSlugs.
 */

'use strict';

const axios = require('axios');

class GrowwProvider {
  constructor(concurrencyManager) {
    this.concurrency = concurrencyManager;
    this.requestCount = 0;
  }

  /**
   * Fetch scheme data from Groww's __NEXT_DATA__
   * @param {string} growwSlug - e.g. 'hdfc-flexi-cap-fund-direct-growth'
   * @returns {object} Raw Groww mfServerSideData
   */
  async fetchSchemeData(growwSlug) {
    const url = `https://groww.in/mutual-funds/${growwSlug}`;
    const res = await axios.get(url, {
      timeout: this.concurrency ? this.concurrency.requestTimeout : 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    this.requestCount++;

    const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('No __NEXT_DATA__ found for ' + growwSlug);

    const nextData = JSON.parse(match[1]);
    const ss = nextData.props?.pageProps?.mfServerSideData;
    if (!ss) throw new Error('No mfServerSideData for ' + growwSlug);

    return ss;
  }

  /**
   * Fetch and normalize a single scheme for any AMC
   * @param {object} schemeMaster - { schemeCode, schemeName, growwSlug, amc, category }
   * @param {string} amcId - e.g. 'HDFC', 'SBI'
   * @returns {object} Normalized scheme data ready for DB insertion
   */
  async fetchAndNormalize(schemeMaster, amcId) {
    const groww = await this.fetchSchemeData(schemeMaster.growwSlug);

    // Normalize returns
    const returnStats = groww.return_stats?.[0] || groww.stats?.[0] || {};
    const returns = {};
    const returnFields = {
      '1D': 'return1d', '1W': 'return1w', '1M': 'return1m',
      '3M': 'return3m', '6M': 'return6m', '1Y': 'return1y',
      '3Y': 'return3y', '5Y': 'return5y',
    };
    for (const [period, field] of Object.entries(returnFields)) {
      const val = returnStats[field] ?? null;
      if (val !== null && val !== undefined) {
        returns[period] = val;
      }
    }

    // Normalize holdings
    const rawHoldings = groww.holdings || [];
    const portfolioDate = rawHoldings[0]?.portfolio_date?.split('T')[0] || null;
    const holdings = rawHoldings.map(h => ({
      securityName: h.company_name || h.stock_name || 'Unknown',
      isin: h.isin || null,
      assetType: h.nature_name || h.instrument_name || 'Equity',
      sector: h.sector_name || null,
      quantity: h.quantity || null,
      marketValue: h.market_value || null,
      weight: h.corpus_per || null,
    }));

    return {
      // Scheme identity
      schemeId: `${amcId}_${schemeMaster.schemeCode}`,
      schemeCode: schemeMaster.schemeCode,
      schemeName: groww.scheme_name || schemeMaster.schemeName,
      amc: amcId,
      category: groww.category || schemeMaster.category || null,
      plan: groww.plan_type || 'Direct',
      option: groww.scheme_type || 'Growth',
      isin: groww.isin || null,
      status: 'active',
      fundManager: groww.fund_manager || null,
      expenseRatio: groww.expense_ratio || null,

      // Returns
      returns,
      return1Y: returns['1Y'] ?? null,
      returnDate: groww.nav_date || null,

      // NAV & AUM
      nav: groww.nav ?? null,
      navDate: groww.nav_date || null,
      aum: groww.aum ?? null,
      aumDate: groww.nav_date || null,

      // Portfolio
      portfolioDate,
      holdings,
      holdingsCount: holdings.length,

      // Source tracking
      source: 'groww',
      growwSlug: schemeMaster.growwSlug,
    };
  }

  /**
   * Fetch a batch of schemes in parallel for a given AMC
   * @param {string} amcId
   * @param {Array} schemeMasters - array of { schemeCode, schemeName, growwSlug, ... }
   * @param {Function} onProgress - callback for progress updates
   * @returns {Map<string, {success: boolean, data?: object, error?: string}>}
   */
  async fetchAmcSchemes(amcId, schemeMasters, onProgress) {
    const results = new Map();
    const BATCH_SIZE = this.concurrency ? this.concurrency.perAmcConcurrency : 5;

    for (let i = 0; i < schemeMasters.length; i += BATCH_SIZE) {
      const batch = schemeMasters.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(schemeMasters.length / BATCH_SIZE);

      if (onProgress) {
        onProgress(`[${amcId}] Batch ${batchNum}/${totalBatches}: ${batch.length} schemes`);
      }

      const batchPromises = batch.map(async (master) => {
        const result = await this.concurrency.execute(
          amcId,
          () => this.fetchAndNormalize(master, amcId),
          { label: master.schemeName, retries: 3, timeout: 25000 }
        );
        results.set(master.schemeCode, result);
        return result;
      });

      await Promise.allSettled(batchPromises);

      // Small delay between batches
      if (i + BATCH_SIZE < schemeMasters.length) {
        await new Promise(r => setTimeout(r, this.concurrency ? this.concurrency.batchDelay : 500));
      }
    }

    return results;
  }

  getRequestCount() { return this.requestCount; }
}

module.exports = GrowwProvider;

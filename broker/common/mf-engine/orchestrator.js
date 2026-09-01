/**
 * common/mf-engine/orchestrator.js
 *
 * Parallel orchestration engine for multi-AMC mutual fund data collection.
 * Runs all AMCs concurrently. Within each AMC, runs data providers concurrently.
 * Uses Promise.allSettled for failure isolation.
 */

'use strict';

const ConcurrencyManager = require('./concurrencyManager');
const GrowwProvider = require('./providers/growwProvider');
const { buildAmcSchemeMasters } = require('./amcRegistry');
const path = require('path');

class MfOrchestrator {
  constructor(db, config = {}) {
    this.db = db;
    this.config = {
      globalConcurrency: config.globalConcurrency || 30,
      perAmcConcurrency: config.perAmcConcurrency || 5,
      requestTimeout: config.requestTimeout || 25000,
      maxRetries: config.maxRetries || 3,
      batchDelay: config.batchDelay || 500,
      ...config,
    };

    this.concurrency = new ConcurrencyManager(this.config);
    this.growwProvider = new GrowwProvider(this.concurrency);
    this.runId = `run_${Date.now()}`;

    // Run status
    this.status = {
      runId: this.runId,
      status: 'PENDING',
      startedAt: null,
      completedAt: null,
      amcs: {},
    };
  }

  /**
   * Run ALL AMCs in parallel
   * @param {object} opts - { amcFilter: string[] }
   * @returns {object} Reconciliation report
   */
  async runAll(opts = {}) {
    this.status.startedAt = new Date().toISOString();
    this.status.status = 'RUNNING';
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  MULTI-AMC MUTUAL FUND DATA ENGINE                      ║');
    console.log(`║  Run ID: ${this.runId.padEnd(47)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    try {
      // Phase 1: Discover scheme masters for all AMCs
      console.log('═══ PHASE 1: AMC Scheme Discovery ═══');
      const registry = await buildAmcSchemeMasters();
      const amcNames = Object.keys(registry);

      let targetAmcs = amcNames;
      if (opts.amcFilter && opts.amcFilter.length > 0) {
        targetAmcs = amcNames.filter(name => opts.amcFilter.includes(name));
      }

      console.log(`\nTotal AMCs to process: ${targetAmcs.length}`);
      console.log(`Total schemes: ${targetAmcs.reduce((sum, amc) => sum + registry[amc].schemes.length, 0)}`);
      console.log('');

      // Phase 2: Run all AMCs in parallel
      console.log('═══ PHASE 2: Parallel AMC Data Collection ═══');

      const amcPromises = targetAmcs.map(amcName => {
        const amcData = registry[amcName];
        return this._processAmc(amcData).catch(err => ({
          amcName,
          status: 'FAILED',
          error: err.message,
          schemesProcessed: 0,
          schemesSucceeded: 0,
          schemesFailed: 0,
        }));
      });

      const amcResults = await Promise.allSettled(amcPromises);

      // Phase 3: Generate reconciliation report
      console.log('\n═══ PHASE 3: Reconciliation Report ═══');
      const report = this._generateReport(amcResults, registry);

      this.status.completedAt = new Date().toISOString();
      this.status.status = report.failedAmcs > 0 ? 'PARTIAL' : 'COMPLETED';

      this._printReport(report);
      return report;

    } catch (err) {
      this.status.status = 'FAILED';
      this.status.completedAt = new Date().toISOString();
      console.error('[Orchestrator] Fatal error:', err.message);
      throw err;
    }
  }

  /**
   * Process a single AMC — fetch all its schemes and store in DB
   */
  async _processAmc(amcData) {
    const amcId = amcData.amcId;
    const amcName = amcData.amcName;
    const schemes = amcData.schemes;

    console.log(`\n[${amcId}] Starting ${schemes.length} schemes...`);
    const startTime = Date.now();

    const results = await this.growwProvider.fetchAmcSchemes(
      amcId,
      schemes,
      (msg) => console.log(`  ${msg}`)
    );

    // Store successful results in DB
    let succeeded = 0;
    let failed = 0;
    const errors = [];

    for (const [schemeCode, result] of results) {
      if (result.success && result.data) {
        this._storeSchemeData(result.data);
        succeeded++;
      } else {
        failed++;
        errors.push({ schemeCode, error: result.error });
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const amcStatus = {
      status: failed === 0 ? 'COMPLETED' : succeeded === 0 ? 'FAILED' : 'PARTIAL',
      schemesTotal: schemes.length,
      schemesSucceeded: succeeded,
      schemesFailed: failed,
      elapsed: parseFloat(elapsed),
      errors,
    };

    console.log(`[${amcId}] Done: ${succeeded}/${schemes.length} succeeded (${elapsed}s)${errors.length > 0 ? ` | ${failed} failed` : ''}`);
    this.status.amcs[amcId] = amcStatus.status;

    return { amcId, amcName, ...amcStatus };
  }

  /**
   * Store a single scheme's normalized data in the database
   */
  _storeSchemeData(data) {
    // Upsert scheme
    this.db.upsertScheme({
      id: data.schemeId,
      schemeCode: data.schemeCode,
      schemeName: data.schemeName,
      amc: data.amc,
      category: data.category,
      plan: data.plan,
      option: data.option,
      isin: data.isin,
      status: data.status,
      fundManager: data.fundManager,
      expenseRatio: data.expenseRatio,
    });

    // Store returns
    if (data.returns) {
      for (const [period, value] of Object.entries(data.returns)) {
        if (value !== null && value !== undefined) {
          this.db.upsertReturn({
            schemeId: data.schemeId,
            period,
            returnValue: value,
            asOfDate: data.returnDate,
            source: data.source,
          });
        }
      }
    }

    // Store AUM
    if (data.aum !== null && data.aum !== undefined) {
      this.db.upsertAum({
        schemeId: data.schemeId,
        aum: data.aum,
        asOfDate: data.aumDate,
        source: data.source,
      });
    }

    // Store NAV
    if (data.nav !== null && data.nav !== undefined) {
      this.db.upsertNav({
        schemeId: data.schemeId,
        nav: data.nav,
        asOfDate: data.navDate,
        source: data.source,
      });
    }

    // Store portfolio + holdings
    if (data.portfolioDate && data.holdings && data.holdings.length > 0) {
      const portfolioId = this.db.upsertPortfolio({
        schemeId: data.schemeId,
        portfolioDate: data.portfolioDate,
        source: data.source,
      });

      // Clear old holdings and insert new ones
      this.db.clearHoldings(portfolioId);

      for (const h of data.holdings) {
        this.db.insertHolding({
          portfolioId,
          securityName: h.securityName,
          isin: h.isin,
          assetType: h.assetType,
          sector: h.sector,
          quantity: h.quantity,
          marketValue: h.marketValue,
          weight: h.weight,
        });
      }

      // Update total holdings count
      this.db.getDb().prepare(
        'UPDATE mutual_fund_portfolios SET totalHoldings = ? WHERE id = ?'
      ).run(data.holdings.length, portfolioId);
    }
  }

  /**
   * Generate reconciliation report
   */
  _generateReport(amcResults, registry) {
    const report = {
      runId: this.runId,
      status: this.status.status,
      startedAt: this.status.startedAt,
      completedAt: new Date().toISOString(),
      totalAmcs: amcResults.length,
      successfulAmcs: 0,
      partialAmcs: 0,
      failedAmcs: 0,
      totalSchemes: 0,
      successfulSchemes: 0,
      failedSchemes: 0,
      totalHoldingsRecords: 0,
      concurrencyStats: this.concurrency.getStats(),
      amcDetails: [],
    };

    for (const result of amcResults) {
      const r = result.status === 'fulfilled' ? result.value : {
        amcName: 'Unknown',
        status: 'FAILED',
        error: result.reason?.message || 'Unknown error',
        schemesTotal: 0,
        schemesSucceeded: 0,
        schemesFailed: 0,
      };

      report.totalSchemes += r.schemesTotal || 0;
      report.successfulSchemes += r.schemesSucceeded || 0;
      report.failedSchemes += r.schemesFailed || 0;

      if (r.status === 'COMPLETED') report.successfulAmcs++;
      else if (r.status === 'PARTIAL') report.partialAmcs++;
      else report.failedAmcs++;

      report.amcDetails.push({
        amcName: r.amcName || r.amcId,
        status: r.status,
        schemesTotal: r.schemesTotal || 0,
        schemesSucceeded: r.schemesSucceeded || 0,
        schemesFailed: r.schemesFailed || 0,
        errors: r.errors || [],
      });
    }

    // Get total holdings from DB
    try {
      const dbStats = this.db.validateIntegrity();
      report.totalHoldingsRecords = dbStats.totalHoldings;
      report.totalPortfolios = dbStats.totalPortfolios;
      report.duplicateWarnings = dbStats.duplicateWarnings;
    } catch (e) {
      // Non-critical
    }

    return report;
  }

  /**
   * Print formatted reconciliation report
   */
  _printReport(report) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  RECONCILIATION REPORT                                  ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Run ID:       ${report.runId}`);
    console.log(`Status:       ${report.status}`);
    console.log(`Duration:     ${report.startedAt} → ${report.completedAt}`);
    console.log('');
    console.log('─── AMC Summary ───');
    console.log(`Total AMCs:      ${report.totalAmcs}`);
    console.log(`  ✓ Completed:   ${report.successfulAmcs}`);
    console.log(`  ◐ Partial:     ${report.partialAmcs}`);
    console.log(`  ✗ Failed:      ${report.failedAmcs}`);
    console.log('');
    console.log('─── Scheme Summary ───');
    console.log(`Total schemes:   ${report.totalSchemes}`);
    console.log(`  ✓ Succeeded:   ${report.successfulSchemes}`);
    console.log(`  ✗ Failed:      ${report.failedSchemes}`);
    console.log('');
    console.log('─── Data Summary ───');
    console.log(`Portfolios:      ${report.totalPortfolios || 0}`);
    console.log(`Holdings:        ${report.totalHoldingsRecords || 0}`);
    console.log('');
    console.log('─── Concurrency Stats ───');
    const cs = report.concurrencyStats;
    console.log(`Total requests:    ${cs.totalRequests}`);
    console.log(`Successful:        ${cs.successfulRequests}`);
    console.log(`Failed:            ${cs.failedRequests}`);
    console.log(`Retried:           ${cs.retriedRequests}`);
    console.log(`Timed out:         ${cs.timedOutRequests}`);
    console.log('');

    if (report.duplicateWarnings && report.duplicateWarnings.length > 0) {
      console.log('─── Duplicate Warnings ───');
      for (const w of report.duplicateWarnings) {
        console.log(`  ⚠ ${w}`);
      }
      console.log('');
    }

    console.log('─── Per-AMC Details ───');
    for (const amc of report.amcDetails) {
      const icon = amc.status === 'COMPLETED' ? '✓' : amc.status === 'PARTIAL' ? '◐' : '✗';
      console.log(`  ${icon} ${amc.amcName}: ${amc.schemesSucceeded}/${amc.schemesTotal} schemes`);
      if (amc.errors && amc.errors.length > 0) {
        for (const e of amc.errors.slice(0, 3)) {
          console.log(`    ✗ ${e.schemeCode}: ${e.error}`);
        }
        if (amc.errors.length > 3) {
          console.log(`    ... and ${amc.errors.length - 3} more errors`);
        }
      }
    }
    console.log('');
    console.log('Done!');
  }
}

module.exports = MfOrchestrator;

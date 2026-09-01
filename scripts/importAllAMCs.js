#!/usr/bin/env node
/**
 * scripts/importAllAMCs.js
 *
 * Multi-AMC Mutual Fund Data Engine — Main entry point.
 * Discovers equity schemes for all 24 AMCs, fetches real data from Groww,
 * and stores in the common database.
 *
 * Usage:
 *   node scripts/importAllAMCs.js                    # Import all AMCs
 *   node scripts/importAllAMCs.js --amc HDFC,SBI    # Import specific AMCs
 *   node scripts/importAllAMCs.js --parallel 10      # Custom concurrency
 */

'use strict';

const path = require('path');
const db = require(path.join(__dirname, '../db/mutualFunds'));
const MfOrchestrator = require(path.join(__dirname, '../common/mf-engine/orchestrator'));

// Parse CLI args
const args = process.argv.slice(2);
const opts = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--amc' && args[i + 1]) {
    opts.amcFilter = args[++i].split(',').map(s => s.trim());
  }
  if (args[i] === '--parallel' && args[i + 1]) {
    opts.perAmcConcurrency = parseInt(args[++i]) || 5;
  }
  if (args[i] === '--global' && args[i + 1]) {
    opts.globalConcurrency = parseInt(args[++i]) || 30;
  }
}

async function main() {
  const orchestrator = new MfOrchestrator(db, {
    globalConcurrency: opts.globalConcurrency || 30,
    perAmcConcurrency: opts.perAmcConcurrency || 5,
    requestTimeout: 25000,
    maxRetries: 3,
    batchDelay: 500,
  });

  const report = await orchestrator.runAll({
    amcFilter: opts.amcFilter || null,
  });

  // Exit with error code if any AMC failed completely
  if (report.failedAmcs > 0 && report.successfulAmcs === 0) {
    process.exit(1);
  }

  return report;
}

if (require.main === module) {
  main().catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
}

module.exports = { main };

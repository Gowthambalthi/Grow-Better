const db = require('../db/db');

// Restore historical accrued charges & MTF interest base
db.prepare('DELETE FROM broker_overrides').run();

const nowIso = new Date().toISOString();

db.prepare(`
  INSERT INTO broker_overrides (broker, custom_charges, custom_mtf_interest, updated_at)
  VALUES ('angelone', 6585.00, 2138.77, ?)
`).run(nowIso);

db.prepare(`
  INSERT INTO broker_overrides (broker, custom_charges, custom_mtf_interest, updated_at)
  VALUES ('groww', 1893.30, 327.00, ?)
`).run(nowIso);

console.log('SUCCESSFULLY RESTORED HISTORICAL CHARGES & MTF INTEREST BASE (Angel One ₹8,723.77 + Groww ₹2,220.30)');

const db = require('../db/db');

db.prepare('DELETE FROM trades').run();

// Angel One Holdings (Exact Data from Screenshot media_1787040196342.png)
// 1. CUPID: Qty 20, Avg ₹293.19, Buy Date 2026-08-13 (5 Days Hold)
db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
  VALUES ('angelone', 'CUPID', 'NSE', 'BUY', 20, 293.19, '2026-08-13', 'DELIVERY', 0, NULL, NULL, NULL, 'live', NULL, NULL, datetime('now'))
`).run();

// 2. EMMVEE: Qty 15, Avg ₹346.37, Buy Date 2026-07-17 (32 Days Hold) [MTF]
db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
  VALUES ('angelone', 'EMMVEE', 'NSE', 'BUY', 15, 346.37, '2026-07-17', 'MARGIN', 1, 1791.57, 3403.98, NULL, 'live', NULL, NULL, datetime('now'))
`).run();

// 3. RELIANCE: Qty 16, Avg ₹1,321.48, Buy Date 2026-07-17 (32 Days Hold) [MTF]
db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
  VALUES ('angelone', 'RELIANCE', 'NSE', 'BUY', 16, 1321.48, '2026-07-17', 'MARGIN', 1, 4805.38, 16338.30, NULL, 'live', NULL, NULL, datetime('now'))
`).run();

// 4. SHRIRAMFIN: Qty 20, Avg ₹1,026.30, Buy Date 2026-07-09 (40 Days Hold) [MTF]
db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
  VALUES ('angelone', 'SHRIRAMFIN', 'NSE', 'BUY', 20, 1026.30, '2026-07-09', 'MARGIN', 1, 5701.67, 14824.33, NULL, 'live', NULL, NULL, datetime('now'))
`).run();

// Groww Holdings (Exact Groww Screenshot media_1787039806166.png)
// CUPID: Qty 13, Avg ₹233.29, Buy Date 2026-07-04 (45 Days Hold)
db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
  VALUES ('groww', 'CUPID', 'NSE', 'BUY', 13, 233.29, '2026-07-04', 'DELIVERY', 0, NULL, NULL, NULL, 'live', NULL, NULL, datetime('now'))
`).run();

console.log('SUCCESSFULLY RESTORED EXACT PORTFOLIO HOLDINGS MATCHING HISTORICAL SCREENSHOTS');

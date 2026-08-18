const db = require('../db/db');

console.log('[DB Sync] Cleaning old test records from trades and broker_overrides...');

db.prepare('DELETE FROM trades').run();
db.prepare('DELETE FROM broker_overrides').run();

const targetTrades = [
  { broker: 'angelone', tradingsymbol: 'CUPID-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 48, price: 286.78, trade_date: '2026-08-01', product_type: 'MARGIN', is_mtf: 1, mtf_margin_paid: 4746.70, mtf_amount_borrowed: 9018.74 },
  { broker: 'angelone', tradingsymbol: 'RELIANCE-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 16, price: 1321.48, trade_date: '2026-07-17', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
  { broker: 'angelone', tradingsymbol: 'EMMVEE-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 15, price: 346.37, trade_date: '2026-07-17', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
  { broker: 'groww', tradingsymbol: 'CUPID', exchange: 'NSE', transaction_type: 'BUY', quantity: 13, price: 233.29, trade_date: '2026-07-29', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
];

const insertStmt = db.prepare(`
  INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'target-sync')
`);

for (const t of targetTrades) {
  insertStmt.run(t.broker, t.tradingsymbol, t.exchange, t.transaction_type, t.quantity, t.price, t.trade_date, t.product_type, t.is_mtf, t.mtf_margin_paid, t.mtf_amount_borrowed);
}

db.prepare(`
  INSERT OR REPLACE INTO broker_overrides (broker, custom_charges, custom_mtf_interest)
  VALUES ('angelone', 6585.00, 2138.77)
`).run();

console.log('[DB Sync] Database successfully synced to exact target state!');

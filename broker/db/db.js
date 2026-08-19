/**
 * db/db.js
 *
 * Single SQLite file (data/ledger.db) tracking what the broker APIs don't
 * give you: buy date, MTF borrowed-vs-paid breakdown, and funds added/
 * withdrawn history — per broker. better-sqlite3 is synchronous (no
 * async/await needed for queries) and needs no server process.
 */

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'ledger.db');
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.warn('[DB] Native better-sqlite3 load failed, using mock memory storage:', err.message);
  db = {
    exec: () => {},
    prepare: () => ({ all: () => [], run: () => ({ changes: 0 }), get: () => null }),
    pragma: () => {}
  };
}

// Database schema initialization (Safe, non-destructive)

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broker TEXT NOT NULL,               -- 'angelone' | 'groww'
    tradingsymbol TEXT NOT NULL,
    exchange TEXT NOT NULL,
    transaction_type TEXT NOT NULL,     -- 'BUY' | 'SELL'
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    trade_date TEXT NOT NULL,           -- ISO date, e.g. '2026-08-06'
    product_type TEXT NOT NULL,         -- 'DELIVERY' | 'INTRADAY' | 'MARGIN' (MTF)
    is_mtf INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
    mtf_margin_paid REAL,               -- amount YOU paid, if MTF
    mtf_amount_borrowed REAL,           -- amount broker funded, if MTF (= value - margin_paid)
    order_id TEXT,                      -- broker's order id, if this came from a live order
    source TEXT NOT NULL DEFAULT 'manual', -- 'manual' (backfilled) | 'live' (recorded from an actual fill)
    closed_date TEXT,                   -- ISO date this position was sold/closed, if applicable — stops MTF interest accrual
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trades_broker ON trades(broker);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(broker, tradingsymbol);

  CREATE TABLE IF NOT EXISTS funds_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broker TEXT NOT NULL,
    type TEXT NOT NULL,                 -- 'ADD' | 'WITHDRAW'
    amount REAL NOT NULL,
    txn_date TEXT NOT NULL,             -- ISO date
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_funds_broker ON funds_transactions(broker);

  CREATE TABLE IF NOT EXISTS broker_overrides (
    broker TEXT PRIMARY KEY,
    custom_charges REAL,
    custom_mtf_interest REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Auto-seed default initial trade history & broker overrides ONLY IF fresh empty database
try {
  const tradeCount = db.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt;
  
  if (tradeCount === 0) {
    console.log('[DB Seeder] Fresh empty database detected. Seeding initial trade dates & overrides...');

    const targetTrades = [
      { broker: 'angelone', tradingsymbol: 'CUPID-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 48, price: 286.78, trade_date: '2026-08-01', product_type: 'MARGIN', is_mtf: 1, mtf_margin_paid: 4746.70, mtf_amount_borrowed: 9018.74 },
      { broker: 'angelone', tradingsymbol: 'RELIANCE-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 16, price: 1321.48, trade_date: '2026-07-17', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
      { broker: 'angelone', tradingsymbol: 'EMMVEE-EQ', exchange: 'NSE', transaction_type: 'BUY', quantity: 15, price: 346.37, trade_date: '2026-07-17', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
      { broker: 'groww', tradingsymbol: 'CUPID', exchange: 'NSE', transaction_type: 'BUY', quantity: 13, price: 233.29, trade_date: '2026-07-29', product_type: 'DELIVERY', is_mtf: 0, mtf_margin_paid: null, mtf_amount_borrowed: null },
    ];

    const insertStmt = db.prepare(`
      INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price, trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto-seed')
    `);

    for (const t of targetTrades) {
      insertStmt.run(t.broker, t.tradingsymbol, t.exchange, t.transaction_type, t.quantity, t.price, t.trade_date, t.product_type, t.is_mtf, t.mtf_margin_paid, t.mtf_amount_borrowed);
    }

    db.prepare(`
      INSERT OR REPLACE INTO broker_overrides (broker, custom_charges, custom_mtf_interest)
      VALUES ('angelone', 6585.00, 2138.77)
    `).run();
  }

  const fundsCount = db.prepare('SELECT COUNT(*) as cnt FROM funds_transactions').get().cnt;
  if (fundsCount === 0) {
    console.log('[DB Seeder] Seeding default initial funds transactions for Angel One & Groww...');
    const insertFundStmt = db.prepare(`
      INSERT INTO funds_transactions (broker, type, amount, txn_date, note)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertFundStmt.run('angelone', 'ADD', 40123.00, '2026-07-17', 'Initial Deposit Angel One');
    insertFundStmt.run('groww', 'ADD', 3033.00, '2026-07-29', 'Initial Deposit Groww');
  }
} catch (err) {
  console.error('[DB Seeder Error]', err.message);
}

module.exports = db;
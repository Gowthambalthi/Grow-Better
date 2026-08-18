require('./config/env');
const env = require('./config/env');
const Broker = require('./broker');

async function runAngel() {
  if (!env.angel.enabled()) return console.log('[angelone] ANGEL_ENABLED is not true, skipping');

  const angel = new Broker('angelone');
  await angel.login();
  console.log('[angelone] logged in');

  const holdings = await angel.getHoldings();
  console.log('[angelone] holdings:', holdings);

  angel.on('tick', (t) => console.log('[angelone] tick:', t));
  angel.on('error', (e) => console.error('[angelone] feed error:', e.message));
  angel.subscribeLiveAngel(['2885']); // RELIANCE-EQ, NSE cash

  // Uncomment when ready to fire a REAL order:
  // const { TransactionType, OrderType, ProductType, Exchange } = require('./common/trading/OrderTypes');
  // const order = await angel.placeOrder({
  //   tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885', exchange: Exchange.NSE,
  //   transactionType: TransactionType.BUY, orderType: OrderType.MARKET,
  //   productType: ProductType.DELIVERY, quantity: 1, validity: 'DAY',
  // });
  // console.log('[angelone] order placed:', order);
}

async function runGroww() {
  if (!env.groww.enabled()) return console.log('[groww] GROWW_ENABLED is not true, skipping');

  const groww = new Broker('groww');
  await groww.login();
  console.log('[groww] logged in');

  const holdings = await groww.getHoldings();
  console.log('[groww] holdings:', holdings);

  groww.on('tick', (t) => console.log('[groww] tick:', t));
  groww.on('error', (e) => console.error('[groww] feed error:', e.message));
  groww.subscribeLiveGroww(['NSE_RELIANCE']);

  // Uncomment when ready to fire a REAL order:
  // const { TransactionType, OrderType, ProductType, Exchange } = require('./common/trading/OrderTypes');
  // const order = await groww.placeOrder({
  //   tradingsymbol: 'RELIANCE', exchange: Exchange.NSE,
  //   transactionType: TransactionType.BUY, orderType: OrderType.MARKET,
  //   productType: ProductType.DELIVERY, quantity: 1, validity: 'DAY',
  // });
  // console.log('[groww] order placed:', order);
}

Promise.all([runAngel(), runGroww()]).catch((err) => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
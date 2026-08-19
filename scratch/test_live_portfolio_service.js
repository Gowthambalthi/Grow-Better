const liveStockQuoteService = require('../common/market/liveStockQuoteService');

async function testLiveQuotes() {
  const syms = ['RELIANCE', 'EMMVEE', 'CUPID'];
  for (const s of syms) {
    const q = await liveStockQuoteService.fetchLiveStockQuote(s);
    console.log(s, '=> LTP:', q.ltp, '| CLOSE:', q.close, '| CHG:', q.change, '| PCT:', q.changePct, '%');
  }
}

testLiveQuotes();

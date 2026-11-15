const http = require('http');

const endpoints = [
  '/',
  '/scalping.html',
  '/final.html',
  '/api/board/data',
  '/api/scalping/catalysts',
  '/api/final/board',
  '/api/final/daily?days=6',
  '/api/final/history',
  '/api/terminal/swing',
  '/api/strategy-showdown',
  '/api/portfolio',
  '/data/tomorrow_live_watchlist.json',
  '/stock_slugs.json'
];

async function testEndpoint(path) {
  process.stdout.write(`Testing ${path.padEnd(35)} ... `);
  const start = Date.now();
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:4000' + path, (res) => {
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => {
        const ms = Date.now() - start;
        console.log(`${res.statusCode} | ${ms}ms | ${(bytes / 1024).toFixed(1)} KB`);
        resolve();
      });
    });
    req.on('error', (err) => {
      const ms = Date.now() - start;
      console.log(`ERR: ${err.message} | ${ms}ms`);
      resolve();
    });
    req.setTimeout(5000, () => {
      const ms = Date.now() - start;
      console.log(`TIMEOUT (>5s)`);
      req.abort();
      resolve();
    });
  });
}

(async () => {
  for (const ep of endpoints) {
    await testEndpoint(ep);
  }
})();

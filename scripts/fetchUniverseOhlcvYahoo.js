/**
 * scripts/fetchUniverseOhlcvYahoo.js — Yahoo fallback daily-candle refresh.
 *
 * Used by the market-open pipeline on hosts WITHOUT Angel credentials
 * (e.g. Render free tier). For each universe symbol, fetches the last
 * ~120 daily bars from Yahoo (chart API) and MERGES them into the existing
 * data/ohlcv/<SYM>.json store (replacing any overlap), so EMA200/ADX/ATR
 * scoring runs on up-to-date closes even without a broker feed.
 *
 * Usage: node scripts/fetchUniverseOhlcvYahoo.js [--limit=N]
 */
const fs = require('fs');
const path = require('path');

const OHLCV = path.join(__dirname, '..', 'data', 'ohlcv');
const CONC = 10;
const TIMEOUT = 6000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function universeSymbols() {
  // universe file or fall back to whatever stores exist
  for (const f of ['data/nse_universe_filtered.json', 'data/nse_universe_3000.txt']) {
    const p = path.join(__dirname, '..', f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(j)) return j.map(x => (x.symbol || x)).filter(Boolean);
      if (j.symbols) return j.symbols;
    } catch (_) {}
    try {
      return fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (_) {}
  }
  try { return fs.readdirSync(OHLCV).map(f => f.replace(/\.json$/, '')); } catch (_) { return []; }
}

async function fetchYahooDaily(sym) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.NS?interval=1d&range=6mo`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const axios = require('axios');
      const res = await axios.get(url, { headers: UA, timeout: TIMEOUT });
      const r = res.data?.chart?.result?.[0];
      const ts = r?.timestamp; const q = r?.indicators?.quote?.[0];
      if (!ts || !q) return null;
      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (c == null) continue;
        candles.push([
          new Date(ts[i] * 1000).toISOString().slice(0, 10),
          +(q.open?.[i] ?? c).toFixed(2), +(q.high?.[i] ?? c).toFixed(2),
          +(q.low?.[i] ?? c).toFixed(2), +c.toFixed(2), q.volume?.[i] || 0,
        ]);
      }
      return candles.length >= 30 ? candles : null;
    } catch (e) {
      if (e.response && e.response.status === 429) await new Promise(r => setTimeout(r, 1500));
      else if (attempt === 1) return null;
    }
  }
  return null;
}

function mergeCandles(existing, fresh) {
  if (!existing || !existing.candles || !existing.candles.length) return { candles: fresh };
  const map = new Map();
  for (const c of existing.candles) map.set(c[0], c);
  for (const c of fresh) map.set(c[0], c);              // fresh wins on overlap
  const candles = [...map.values()].sort((a, b) => a[0].localeCompare(b[0]));
  return { ...existing, candles, updatedAt: new Date().toISOString(), source: existing.source || 'angel-one-historical+yahoo-fallback' };
}

async function main() {
  const limitArg = (process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1];
  const limit = limitArg ? parseInt(limitArg, 10) : Infinity;
  let syms = universeSymbols();
  if (!syms.length) { console.error('no universe symbols found'); process.exit(1); }
  syms = syms.slice(0, limit === Infinity ? syms.length : limit);
  console.log(`To fetch: ${syms.length} symbols (Yahoo daily fallback)`);
  let ok = 0, fail = 0;
  for (let i = 0; i < syms.length; i += CONC) {
    const batch = syms.slice(i, i + CONC);
    await Promise.all(batch.map(async sym => {
      const file = path.join(OHLCV, sym + '.json');
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      // skip if store already has today's or yesterday's candle (fresh enough)
      if (existing && existing.candles && existing.candles.length) {
        const last = existing.candles[existing.candles.length - 1][0];
        if (Date.now() - new Date(last).getTime() < 30 * 3600e3) { ok++; return; }
      }
      const fresh = await fetchYahooDaily(sym);
      if (!fresh) { fail++; return; }
      const merged = mergeCandles(existing, fresh);
      fs.writeFileSync(file, JSON.stringify(merged));
      ok++;
    }));
    if ((i / CONC) % 20 === 0) console.log(`PROGRESS ${Math.min(i + CONC, syms.length)}/${syms.length} ok=${ok} fail=${fail}`);
  }
  console.log(`=== DONE ok=${ok} fail=${fail} ===`);
}

main().catch(e => { console.error(e); process.exit(1); });

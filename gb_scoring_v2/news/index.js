/**
 * gb_scoring_v2/news/index.js — THE NEWS ENGINE (extraction + classification ONLY).
 *
 * This implements the plan's §2 news layer: it produces structured records
 * { symbol, direction, importance, event_type, ts, confidence, reason } and NEVER a
 * decision. Per the architecture agreed 25-Sep:
 *
 *   - news is NEVER a BUY (it becomes contextual evidence inside the V3 decision layer);
 *   - news cannot bypass the gates (results/ex-date map onto GATE_EVENT etc.);
 *   - the deterministic keyword classifier here decides direction — no LLM, no guessing.
 *
 * Sources: free RSS feeds (Moneycontrol, Economic Times markets). No API key, no paid
 * service. Headlines are resolved to NSE symbols from the live universe files.
 *
 * File: data/news_classified.json (own directory; writes NOTHING GB reads).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'news_classified.json');

// ---------------------------------------------------------------------------
// PROVIDERS — news is aggregated from MANY sources, not one. See PROVIDERS below.
// Still exported as FEEDS (the old name) because the dashboard and the suite read it.
// ---------------------------------------------------------------------------
const FEEDS = [
  // ---- existing (reachability-tested 25-Sep) ----
  { name: 'moneycontrol-market', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  { name: 'moneycontrol-business', url: 'https://www.moneycontrol.com/rss/business.xml' },
  { name: 'moneycontrol-results', url: 'https://www.moneycontrol.com/rss/results.xml' },
  { name: 'et-markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'et-economy', url: 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms' },
  { name: 'et-stocks', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { name: 'bs-markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'bs-companies', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  { name: 'livemint-markets', url: 'https://www.livemint.com/rss/markets' },
  { name: 'moneycontrol-latest', url: 'https://www.moneycontrol.com/rss/latestnews.xml' },
  { name: 'moneycontrol-economy', url: 'https://www.moneycontrol.com/rss/economy.xml' },
  // ---- NEW fast Indian sources (26-Sep) — no key, free RSS + exchange announcements ----
  // CNBC-TV18 markets feed — fast TV-news translation of price moves.
  { name: 'cnbc-tv18', url: 'https://www.cnbctv18.com/rss/markets.rss' },
  // Reuters India — English business feed, fast global+India wire translation.
  { name: 'reuters-india', url: 'https://www.reutersagency.com/feed/?taxonomy=soi_india&post_type=best/' },
  // NSE India announcements — corporate actions, results, OTCEI notices, fast.
  { name: 'nse-announce', url: 'https://www.nseindia.com/rss' },
  // BSE India announcements — results, corporate, compliance, fast.
  { name: 'bse-announce', url: 'https://www.bseindia.com/rss' },
  // Business Standard companies (re-added mirror under a fresh name for coverage breadth).
  { name: 'bs-companies-2', url: 'https://www.business-standard.com/rss/companies-101.rss' },
  // Economic Times earnings / results wrap — fastest earnings-day signal.
  { name: 'et-earnings', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/1940866.cms' },
  // Moneycontrol market reports (mirror under a fresh name for breadth).
  { name: 'moneycontrol-market-2', url: 'https://www.moneycontrol.com/rss/marketreports.xml' },
  // Trendlyne blog — fundamentals / earnings / screens, slower but signal-rich.
  { name: 'trendlyne', url: 'https://www.trendlyne.com/blog/' },
];

// ---------------------------------------------------------------------------
// SYMBOL RESOLUTION — headline text -> NSE symbol.
//
// The universe files carry no company names, so resolution uses TWO passes:
//   1. ANGEL SCRIP MASTER names — free, local, ~1500 NSE equities with real company
//      names (measured: search('Reliance','NSE') -> RELIANCE-EQ). Cached to
//      data/news_symbol_index.json so it downloads once, not per headline.
//   2. YAHOO SEARCH (v1/finance/search) for names the scrip master missed —
//      rate-limit-friendly because only headlines that failed pass 1 hit it.
// ---------------------------------------------------------------------------
const SYM_INDEX_FILE = path.join(ROOT, 'data', 'news_symbol_index.json');
const SYM_INDEX_TTL_MS = 24 * 3600 * 1000;
let _symIndex = null;

async function buildSymIndex(opts = {}) {
  const cached = (() => { try { return JSON.parse(fs.readFileSync(SYM_INDEX_FILE, 'utf8')); } catch (_) { return null; } })();
  const fresh = !!(cached && cached.builtAt && (Date.now() - Date.parse(cached.builtAt)) < SYM_INDEX_TTL_MS && cached.entries && cached.entries.length > 200);
  let entries = cached && cached.entries ? cached.entries.slice() : [];
  const have = new Set(entries.map((e) => e.symbol));

  // SELF-HEALING GAPS. The first build fetches ~3,700 symbols and some are rate-limited;
  // measured: POLICYBZR and MEESHO are in the universe but were missing from the index,
  // so "PB Fintech" could never resolve. A cache hit therefore does NOT return
  // immediately — it retries a bounded batch of missing tradable symbols each run, so
  // coverage closes over a few minutes instead of staying broken for 24 hours.
  const universeSyms = [];
  try {
    for (const s of fs.readFileSync(path.join(ROOT, 'data', 'nse_universe_3000.txt'), 'utf8').split(/\r?\n/)) {
      const t = s.trim().toUpperCase();
      if (t && !t.startsWith('#')) universeSyms.push(t.replace(/-EQ$/, ''));
    }
  } catch (_) {}
  const gapBatch = opts.gapBatch == null ? (fresh ? 300 : universeSyms.length) : opts.gapBatch;
  const gaps = universeSyms.filter((s) => !have.has(s)).slice(0, gapBatch);
  if (fresh && !gaps.length) return cached;
  if (fresh && gaps.length) {
    await fetchYahooNames(gaps, have, entries);
    const idx = { builtAt: cached.builtAt, entries: entries.filter(isUsable), closedGaps: gaps.length };
    try { fs.writeFileSync(SYM_INDEX_FILE, JSON.stringify(idx)); } catch (_) {}
    return idx;
  }
  // ANGEL SCRIP MASTER, read directly. The raw feed's `name` field is just the symbol
  // (measured: RELIANCE-EQ | RELIANCE), so it cannot resolve "Reliance Industries".
  // It is still kept for the bare-symbol pass and for token/lot metadata.
  try {
    const ai = require('../../common/instruments/angelInstruments');
    await ai.refresh().catch(() => {});
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const rec of ai.search(ch, { exchSeg: 'NSE', limit: 400 })) {
        const sym = String(rec.symbol).replace(/-EQ$/, '').toUpperCase();
        const nm = cleanName(rec.name);
        // ONLY A REAL NAME COUNTS. The scrip master's name field is usually the symbol
        // echoed back (RELIANCE-EQ | RELIANCE). Marking those as "named" made the Yahoo
        // pass skip them, and the index then rejected them as unusable — the exact cause
        // of a full build yielding 1,483 names out of ~2,900 and POLICYBZR being absent
        // even though its Yahoo page answers fine.
        if (!have.has(sym) && rec.name && nm && nm !== sym) {
          have.add(sym);
          entries.push({ symbol: sym, name: nm });
        }
      }
    }
  } catch (_) { /* master unavailable — Yahoo fallback below still works */ }

  // THE REAL NAME SOURCE: Yahoo chart API meta, per symbol, over the tradable
  // universe. The v7 quote endpoint is 401 without a crumb (measured), but the
  // chart endpoint is open and its meta carries shortName/longName
  // (measured: RELIANCE.NS -> "RELIANCE INDUSTRIES LTD").
  await fetchYahooNames(universeSyms, have, entries);

  entries = entries.filter(isUsable);
  const idx = { builtAt: new Date().toISOString(), entries };
  try { fs.writeFileSync(SYM_INDEX_FILE, JSON.stringify(idx)); } catch (_) {}
  return idx;
}

/**
 * KEEP ONLY TRADABLE EQUITIES. Measured defect: without this the index carried ETF and
 * index aliases whose names matched ordinary prose ("global agencies" resolved to
 * GLOBAL, a sentence containing "services" resolved to SERVICE-SM). Membership of the
 * tradable universe is the whole allow-list, and the name must be a real name, not the
 * symbol echoed back.
 */
let _tradable = null;
function tradableSet() {
  if (_tradable) return _tradable;
  const s = new Set();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, 'data', 'nse_universe_3000.txt'), 'utf8').split(/\r?\n/)) {
      const t = line.trim().toUpperCase();
      if (t && !t.startsWith('#')) s.add(t.replace(/-EQ$/, ''));
    }
  } catch (_) {}
  for (const f of ['universe_filtered.json', 'universe_shortlist.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
      for (const r of (j.stocks || [])) if (r.symbol) s.add(String(r.symbol).toUpperCase());
    } catch (_) {}
  }
  _tradable = s;
  return s;
}
function isUsable(e) {
  if (!e || !e.name || e.name === e.symbol) return false;
  return e.name.length >= 6 && tradableSet().has(e.symbol);
}

/** Yahoo chart-meta names for the given symbols, appended to `entries`. */
async function fetchYahooNames(symbols, have, entries) {
  // CONCURRENCY 8, ONE RETRY. Measured: at 12 concurrent, roughly half the symbols came
  // back non-OK (Yahoo throttles bulk chart reads) and were silently lost — the first
  // full build indexed 1,483 of ~2,900 names, which is why "PB Fintech" could not
  // resolve even though its page exists. Slower and complete beats fast and half-empty.
  // RETRY WITH BACKOFF, AND ROTATE THE HOST. Measured: a full build indexed only 1,483
  // of ~2,900 names at 2 attempts against query1 alone, while the SAME symbols answered
  // fine one at a time — this is throttling, not missing data. query1/query2 are separate
  // Yahoo shards, so alternating them and backing off recovers most of the loss.
  const CONC = 6;
  const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  const one = async (s) => {
    if (have.has(s)) return true;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const host = HOSTS[attempt % HOSTS.length];
        const q = await fetch(host + '/v8/finance/chart/' + encodeURIComponent(s) + '.NS?range=1d&interval=1d',
          { signal: AbortSignal.timeout(7000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!q.ok) { await new Promise((r) => setTimeout(r, 350 * Math.pow(2, attempt))); continue; }
        const j = await q.json();
        const m = ((j.chart || {}).result || [])[0]?.meta || {};
        const nm = m.longName || m.shortName;
        if (nm && (!m.instrumentType || m.instrumentType === 'EQUITY')) {
          have.add(s);
          entries.push({ symbol: s, name: cleanName(nm) });
        }
        return true;
      } catch (_) { await new Promise((r) => setTimeout(r, 300 * Math.pow(2, attempt))); }
    }
    return false;
  };
  for (let i = 0; i < symbols.length; i += CONC) {
    await Promise.all(symbols.slice(i, i + CONC).map(one));
    if (process.env.NEWS_INDEX_DEBUG && i % 400 === 0) {
      console.log('[news] index build ' + i + '/' + symbols.length + ' (' + entries.length + ' names)');
    }
  }
}

async function yahooResolveName(text) {
  // One Yahoo search per unresolved headline. Symbols come back with .NS suffix.
  try {
    const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(text.slice(0, 120)) + '&quotesCount=4&newsCount=0';
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.quotes || [])
      .filter((q) => String(q.symbol || '').endsWith('.NS'))
      .map((q) => String(q.symbol).replace(/\.NS$/, '').toUpperCase())
      .slice(0, 3);
  } catch (_) { return []; }
}

/**
 * Generic words that appear inside real company names but must never resolve alone.
 * "GLOBAL", "SERVICE", "INDIA" are not companies.
 */
const GENERIC = new Set(['GLOBAL', 'SERVICE', 'SERVICES', 'INDIA', 'INDIAN', 'NATIONAL', 'GENERAL',
  'STANDARD', 'UNITED', 'PREMIER', 'SUPER', 'FIRST', 'UNIVERSAL', 'ADVANCE', 'ADVANCED', 'DYNAMIC',
  'GROWTH', 'CAPITAL', 'FINANCE', 'FINANCIAL', 'INDUSTRIES', 'INDUSTRY', 'ENTERPRISE', 'ENTERPRISES',
  'TECHNOLOGY', 'TECHNOLOGIES', 'SOLUTIONS', 'SYSTEMS', 'POWER', 'ENERGY', 'STEEL', 'CEMENT',
  'PHARMA', 'HEALTH', 'MOTORS', 'AUTO', 'BANK', 'HOUSING', 'MARKET', 'MONEY', 'SECURITIES',
  'DEVELOPERS', 'INFRA', 'PROJECTS', 'PRODUCTS', 'CHEMICALS', 'TEXTILES', 'HOTELS', 'RETAIL']);

/**
 * Symbols that ARE ordinary English words. A bare-token match on one of these is a
 * false positive, not a mention: measured defects were GLOBAL ("global agencies"),
 * OIL, FOCUS and INFRA firing on prose. These require the company-NAME pass to match.
 */
const WORD_SYMBOLS = new Set(['GLOBAL', 'OIL', 'FOCUS', 'INFRA', 'POWER', 'MONEY', 'MARKET', 'SERVICE',
  'INDIA', 'FIRST', 'SUPER', 'GENERAL', 'STANDARD', 'UNITED', 'PREMIER', 'NATIONAL', 'ACTION',
  'ADVANCE', 'CENTRAL', 'ESSENTIAL', 'FUTURE', 'GROWTH', 'MAX', 'NEW', 'ONE', 'TOTAL', 'VALUE']);

/**
 * Resolve headline text to symbols: local name index first, Yahoo only as fallback.
 * `raw` is the untouched headline — the bare-symbol pass is CASE-SENSITIVE on it, because
 * a real ticker reference is written in caps ("TCS", "INFY") while the same letters in
 * ordinary prose are not ("Global", "Oil").
 */
async function resolveSymbolsLive(text, raw) {
  // CACHE IT, ONCE PER PROCESS. `_symIndex ||` alone re-ran buildSymIndex() on every call, and
  // buildSymIndex() is not free: on a fresh cache it retries a bounded batch of missing symbols over
  // the network to close index gaps. Measured before this fix: ~11 SECONDS per headline, i.e. an
  // ingest of 100 items spent ~18 minutes resolving symbols and looked like a hang. The index is
  // process-wide state; the gap-retry batch is a startup cost, not a per-headline one.
  const idx = _symIndex || (_symIndex = await buildSymIndex());
  const t = ' ' + cleanName(text) + ' ';
  const hits = new Set();
  // Pass 1: WHOLE-WORD company-name match, longest names first so the most specific
  // company wins. A single generic word (GLOBAL/SERVICE) can never resolve on its own.
  const names = idx.entries.slice().sort((a, b) => b.name.length - a.name.length);
  for (const e of names) {
    if (e.name.length < 6) continue;
    const toks = e.name.split(' ').filter(Boolean);
    if (toks.length === 1 && GENERIC.has(toks[0])) continue;
    if (t.includes(' ' + e.name + ' ')) hits.add(e.symbol);
    if (hits.size >= 4) break;
  }
  // Pass 1b: bare symbol as a whole CAPS word in the RAW headline ("INFY", "TCS"),
  // never a symbol-shaped English word.
  const rawWords = String(raw || text).split(/[^A-Za-z0-9&]+/).filter(Boolean);
  const known = new Set(idx.entries.map((e) => e.symbol));
  for (const w of rawWords) {
    if (w.length < 3 || w.length > 12) continue;
    if (w !== w.toUpperCase() || /[^A-Z]/.test(w)) continue;   // must be ALL CAPS in the source
    if (WORD_SYMBOLS.has(w)) continue;
    if (known.has(w)) hits.add(w);
  }
  // Pass 1c: PREFIX match — headlines say "Ola Electric", "PB Fintech", "Bajaj Finance"
  // while the index holds the full registered name ("OLA ELECTRIC MOBILITY"). Match on
  // the first two significant tokens. Measured missing before this pass: OLAELEC,
  // POLICYBZR. Ambiguity is resolved by preferring the SHORTEST full name (TATA MOTORS
  // beats TATA MOTORS PASSENGER VEHICLES for "Tata Motors"), and skipped entirely when a
  // different company owns the remaining tokens.
  if (!hits.size) {
    const bigrams = new Map();
    for (const e of idx.entries) {
      const toks = e.name.split(' ').filter((w) => w.length >= 2);
      if (toks.length < 2) continue;
      const key = toks[0] + ' ' + toks[1];
      if (!bigrams.has(key)) bigrams.set(key, []);
      bigrams.get(key).push(e);
    }
    for (const [key, list] of bigrams) {
      if (!t.includes(' ' + key + ' ')) continue;
      const best = list.slice().sort((a, b) => a.name.length - b.name.length)[0];
      hits.add(best.symbol);
      if (hits.size >= 4) break;
    }
  }
  // Pass 2: Yahoo search fallback, once per headline at most.
  if (!hits.size) {
    for (const s of await yahooResolveName(text)) hits.add(s);
  }
  return [...hits].slice(0, 4);
}

let _nameIndex = null;
function nameIndex() {
  if (_nameIndex) return _nameIndex;
  _nameIndex = new Map();
  const load = (f, key) => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
      for (const r of (j.stocks || j.results || j.signals || [])) {
        if (r.symbol && r[key]) _nameIndex.set(cleanName(r[key]), String(r.symbol).toUpperCase());
      }
    } catch (_) {}
  };
  load('universe_filtered.json', 'name');
  load('universe_shortlist.json', 'name');
  load('live_signals.json', 'name');
  return _nameIndex;
}
function cleanName(n) {
  return String(n || '').toUpperCase()
    .replace(/LIMITED|LTD\.?|&amp;|&/g, ' ').replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['THE', 'AND', 'OF', 'IN', 'FOR', 'ON', 'A', 'TO', 'WITH', 'AT', 'BY']);

function resolveSymbols(text) {
  // Sync variant retained for tests: matches ONLY the bare-symbol word pass over
  // whatever name index was loaded. Live refresh uses resolveSymbolsLive().
  const idx = nameIndex();
  const t = ' ' + cleanName(text) + ' ';
  const hits = new Set();
  const words = t.split(' ').filter((w) => w.length >= 3 && w.length <= 10 && /^[A-Z]+$/.test(w));
  for (const w of words) {
    for (const [, sym] of idx) { if (sym === w) { hits.add(sym); break; } }
  }
  return [...hits].slice(0, 4);
}

// ---------------------------------------------------------------------------
// CLASSIFIER — deterministic keyword rules. Each bucket: what fires, the direction
// it implies, an importance weight and the reason fragment shown to the user.
// Order matters: the first matching bucket wins.
// ---------------------------------------------------------------------------
const RULES = [
  // — strongly negative company events —
  { re: /\b(resigns?|resignation|steps? down|sacked|arrested|fraud|probe|investigation|raid|penalt(y|ies)|fine[sd]?\b|sebi\s+(action|order)|debarred|insolvency|bankrupt|defaults?\b)/i, dir: 'DOWN', imp: 0.9, why: 'governance / regulatory action' },
  { re: /\b(results? (miss|below|disappoint)|profit (falls?|drops?|declines?|down|slumps?|plunges?|tumbles?)|net profit (down|falls?|declines?|drops?|slumps?)|loss (widens?|of|narrows?)|weak (results?|quarter)|q[1-4] (loss|miss)|cut[s]? (guidance|outlook)|downgrade)/i, dir: 'DOWN', imp: 0.85, why: 'weak earnings / guidance' },
  { re: /\b(lower circuit|hits? (a )?(new )?52[- ]week low|slumps?|plunges?|tumbles?|crashes?|sinks?|falls? [0-9.]+%|drops? [0-9.]+%|declines? [0-9.]+%|extends? (losses?|fall)|sell[- ]?off)/i, dir: 'DOWN', imp: 0.75, why: 'sharp price fall' },
  { re: /\b(brokerage (cut|downgrade)|target price (cut|lowered)|price target cut|cut to (sell|reduce))/i, dir: 'DOWN', imp: 0.6, why: 'brokerage downgrade' },
  { re: /\b(fire[sd]? [0-9]|layoff|job cut|plant shutdown|strike|halt(s|ed)? (production|operations)|recall|suspend(s|ed|ion)|blot on)/i, dir: 'DOWN', imp: 0.7, why: 'operations disruption' },
  { re: /\b(promoter (selling|stake sale|dilut)|block deal (sale|sell)|bulk deal (sale|sell)|pledge[sd]? shares|insider sell)/i, dir: 'DOWN', imp: 0.55, why: 'supply / promoter selling' },
  { re: /\b(ex[- ]date|record date|dividend.*(ex|record)|delist)/i, dir: 'EVENT', imp: 0.5, why: 'corporate calendar event (GATE_EVENT)' },

  // — strongly positive company events —
  { re: /\b(wins? (order|contract|deal|project)|bags? (order|contract|deal)|secures? (order|contract|project)|order worth|grant(ed|s)?\b|subsid(y|ies)|gets? government|approval|approved|usfda|launch(es|ed)?|acquires?|acquisition|stake (buy|in)|partnership|joint venture|expansion|new (plant|facility|capacity))/i, dir: 'UP', imp: 0.8, why: 'order win / approval / expansion' },
  { re: /\b(results? (beat|above|strong)|profit (rises?|jumps?|up|grows?|doubles?|surges?)|net profit (up|rises?|jumps?|grows?|doubles?|surges?)|surge[sd]? [0-9]+% (profit|revenue)|strong (results?|quarter)|q[1-4] beat|raises? (guidance|outlook)|upgrade[sd]?\b)/i, dir: 'UP', imp: 0.85, why: 'strong earnings / guidance' },
  { re: /\b(upper circuit|hits? (a )?(new )?52[- ]week high|jumps? [0-9.]+%|surges? [0-9.]+%|soars?|gains? [0-9.]+%|rall(y|ies) [0-9.]+%|record high)/i, dir: 'UP', imp: 0.75, why: 'sharp price rise' },
  { re: /\b(brokerage (initiate|upgrade|buy)|target price (raised|hiked)|price target raised|bullish on|top pick|buy rating)/i, dir: 'UP', imp: 0.6, why: 'brokerage upgrade' },
  { re: /\b(buyback|bonus (issue|share)|stock split|dividend of|special dividend|interim dividend)/i, dir: 'UP', imp: 0.55, why: 'capital return' },
  { re: /\b(promoter (buying|stake buy|increas)|block deal (buy|purchase)|bulk deal (buy|purchase)|insider buy|fii buying|dii buying)/i, dir: 'UP', imp: 0.5, why: 'demand / promoter buying' },
];

// Market / macro context. Kept SEPARATE from the company rules so a company-resolved
// headline never gets swallowed by a market keyword that happens to appear in its
// description (measured: "Chalet Hotels among 3 stocks closed above VWAP" classified as
// market context because the description said "market").
const MACRO_RULES = [
  { re: /\b(rbi|repo rate|fed\b|inflation|cpi\b|gdp|budget|union budget|monsoon|crude (oil )?(price|rally|fall)|tariff)/i, dir: 'MACRO', imp: 0.6, why: 'macro / policy — market context (GATE_MARKET)' },
  { re: /\b(nifty|sensex|market (crash|rally|selloff)|bullish|bearish|rupee|fii|dii|foreign (investors?|funds?))/i, dir: 'MACRO', imp: 0.4, why: 'index / sentiment context' },
];

/**
 * Classify one headline -> { dir, imp, why, confidence } or null (neutral).
 * `companyRulesOnly` is used when a company WAS resolved: the market buckets are then
 * skipped, so a stock headline is never labelled as market context.
 */
function classify(text, opts = {}) {
  for (const r of RULES) {
    if (r.re.test(text)) {
      return { dir: r.dir, imp: r.imp, why: r.why, confidence: Math.min(0.95, 0.5 + r.imp / 2) };
    }
  }
  if (!opts.companyRulesOnly) {
    for (const r of MACRO_RULES) {
      if (r.re.test(text)) {
        return { dir: r.dir, imp: r.imp, why: r.why, confidence: Math.min(0.95, 0.5 + r.imp / 2) };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// FETCH + PARSE RSS (minimal, no dependency: regex over <item> blocks)
// ---------------------------------------------------------------------------
function parseRss(xml) {
  const items = [];
  const blocks = String(xml).split(/<item[\s>]/i).slice(1);
  for (const b of blocks) {
    const title = (b.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1];
    const link = (b.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i) || [])[1];
    const pub = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1];
    const desc = (b.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i) || [])[1];
    if (!title) continue;
    items.push({
      title: title.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim(),
      link: (link || '').trim(),
      ts: pub ? Date.parse(pub) || null : null,
      desc: (desc || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').slice(0, 220).trim(),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// KEYED API PROVIDERS — news comes from MANY sources, not one.
//
// The RSS feeds are free and need no key, but they return free TEXT: a symbol has to be
// INFERRED from the headline, which is exactly why the resolver heuristics above exist.
// A keyed API can return news already TAGGED with tickers, and a provider tag is
// AUTHORITATIVE — it skips the heuristics entirely, so "Ola Electric" cannot miss OLAELEC
// and the ordinary word "global" cannot match a symbol called GLOBAL.
//
// Each provider below is DISABLED until its key exists in .env, then it switches itself on
// at the next refresh. They are a LIST, so adding a tenth source is a key rather than a
// code change. Nothing here decides anything: a provider supplies a story and, at most,
// which tickers it is about. Direction, importance and the blast list stay ours.
// ---------------------------------------------------------------------------
try { require(path.join(ROOT, 'config', 'env')); } catch (_) { /* the app already loaded it */ }

// ---------------------------------------------------------------------------
// FREE-TIER BUDGETS — WHY EVERY PROVIDER DECLARES ITS OWN CADENCE.
//
// Every keyed provider here is a FREE plan, and the free plans are small: Marketaux and NewsAPI and
// GNews ~100 requests/day, FinNews 100/day with only THREE articles per request, Alpha Vantage 25/day.
// The refresh cycle runs every 10 minutes = 144 cycles/day, so an unthrottled list burns every key
// within hours — and then it fails SILENTLY: the provider 429s, its headlines stop arriving, the pool
// ages past its 72h cutoff, and the board reads 0 while the RSS feeds still look fine. That is the
// "news died" symptom, and the fix is not more sources, it is spending each key at the rate the plan
// allows. So: `minIntervalMin` (call cadence), `dailyBudget` (hard stop), and a PERSISTED ledger — a
// restart must not reset the day's spend — plus the numbers on screen so the user can see the budget
// going down instead of guessing why a source went quiet.
// ---------------------------------------------------------------------------
// The two bookkeeping files (free-tier budget ledger, saved provider keys). The names are
// overridable ONLY so the test suite can use its own files and never disturb the live ledger or a
// working key; in normal operation the defaults are what is used.
const LEDGER_FILE = path.join(ROOT, 'data', process.env.NEWS_LEDGER_FILE || 'news_provider_ledger.json');

function ledgerDayKey() {
  // IST day, because the free plans reset on the vendor's clock and this is an Indian feed set
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
    if (j && j.day === ledgerDayKey() && j.providers) return j;
  } catch (_) { /* first run of the day, or unreadable: start fresh, never throw */ }
  return { day: ledgerDayKey(), providers: {} };
}
let _ledger = loadLedger();
function saveLedger() {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(_ledger, null, 1));
  } catch (_) { /* the ledger is bookkeeping; a write failure must not stop the fetch */ }
}
function ledgerOf(id) {
  if (_ledger.day !== ledgerDayKey()) { _ledger = { day: ledgerDayKey(), providers: {} }; saveLedger(); }
  _ledger.providers[id] = _ledger.providers[id] || { calls: 0, ok: 0, errors: 0, lastAt: 0, lastOkAt: 0, lastError: null, remaining: null, resetAt: null };
  return _ledger.providers[id];
}

/**
 * WHERE A PROVIDER'S KEY COMES FROM.
 *
 * Two places, in this order: process.env (the .env file, which needs a restart) and
 * data/news_keys.json (saved from the News page, effective on the next cycle). The env var wins, so
 * a key written into .env is never shadowed by a stale copy on disk. Keys are never echoed back to
 * the page — `keyState` reports only whether one exists, where it came from, and its last 4 chars.
 */
const KEYS_FILE = path.join(ROOT, 'data', process.env.NEWS_KEYS_FILE || 'news_keys.json');
function loadKeys() {
  try {
    const j = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return (j && typeof j === 'object' && j.keys && typeof j.keys === 'object') ? j : { keys: {} };
  } catch (_) { return { keys: {} }; }
}
let _keys = loadKeys();
function saveKeys() {
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(_keys, null, 1));
  } catch (_) { /* the store is convenience; a write failure must not stop a fetch */ }
}
/** Every place a key is read goes through here, so env-vs-file is decided in exactly one function. */
function keyOf(p) {
  const id = typeof p === 'string' ? p : p.id;
  if (typeof p === 'string') {
    const prov = API_PROVIDERS.filter((x) => x.id === id)[0];
    if (!prov) return '';
    return keyOf(prov);
  }
  const env = String(process.env[p.env] || '').trim();
  if (env) return env;
  return String((_keys.keys || {})[id] || '').trim();
}
/** Whether the endpoint a provider needs is present, from either source. */
function endpointOf(p) {
  if (!p.requiresUrl) return '';
  const env = String(process.env[p.requiresUrl] || '').trim();
  if (env) return env;
  return String((_keys.urls || {})[p.requiresUrl] || '').trim();
}
function keyState(p) {
  const k = keyOf(p);
  const fromEnv = !!String(process.env[p.env] || '').trim();
  return {
    id: p.id, env: p.env, configured: configured(p),
    source: !k ? null : (fromEnv ? 'env' : 'file'),
    tail: k ? k.slice(-4) : null,
    endpoint: !!endpointOf(p), requiresUrl: p.requiresUrl || null,
  };
}
/**
 * setKeys({ id: key, ... }, { urls: { TRADIENT_NEWS_URL: '...' } }) — save keys from the page.
 * Returns the per-provider state AFTER the write, masked. An empty/absent value CLEARS that key, so
 * a wrong token can be removed the same way it was added.
 */
function setKeys(input, opts) {
  const body = input || {};
  const changed = [];
  for (const p of API_PROVIDERS) {
    if (!(p.id in body)) continue;
    const v = String(body[p.id] == null ? '' : body[p.id]).trim();
    if (v) _keys.keys[p.id] = v; else delete _keys.keys[p.id];
    changed.push(p.id + ':' + (v ? 'set(' + v.length + ' chars)' : 'cleared'));
  }
  // Providers without a hard-coded endpoint (Tradient) also need the URL. Same store, same rules.
  const urls = (opts && opts.urls) || {};
  _keys.urls = _keys.urls || {};
  for (const name of Object.keys(urls)) {
    const v = String(urls[name] == null ? '' : urls[name]).trim();
    if (v) _keys.urls[name] = v; else delete _keys.urls[name];
    changed.push(name + ':' + (v ? 'set' : 'cleared'));
  }
  saveKeys();
  return { changed, state: API_PROVIDERS.map(keyState) };
}

/** The index heavyweights FinNews is spent on when FINNEWS_SYMBOLS is not set. */
function finnewsSymbols() {
  const raw = String(process.env.FINNEWS_SYMBOLS || '').trim();
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS'];
}
/** Ticker strings from whichever field a provider uses, exchange suffix stripped. */
function tickersOf(n) {
  const raw = n.tickers || n.symbols || n.entities || n.ticker || [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map((x) => String((x && x.symbol) || x || '').toUpperCase().replace(/\.(NS|BO)$/, '')).filter(Boolean);
}
/** A sentiment number from whichever shape a provider uses (Marketaux: score, FinNews: 0..1). */
function sentimentOf(n) {
  const cands = [n.sentiment, n.sentiment_score, n.sentimentScore, n.score, n.sentiment && n.sentiment.score];
  for (const c of cands) if (typeof c === 'number' && Number.isFinite(c)) return c;
  return null;
}

const API_PROVIDERS = [
  {
    id: 'finnhub', label: 'Finnhub', env: 'FINNHUB_API_KEY', tagsSymbols: true,
    // 5 minutes all day = 288 calls, which is the budget itself: a cadence that needs more calls than
    // the budget allows is the silent-failure class this pair of numbers exists to prevent.
    minIntervalMin: 5, dailyBudget: 288,
    url: (k) => 'https://finnhub.io/api/v1/news?category=general&token=' + encodeURIComponent(k),
    parse: (j) => (Array.isArray(j) ? j : []).map((n) => ({
      title: n.headline, desc: n.summary, link: n.url,
      ts: n.datetime ? n.datetime * 1000 : Date.now(),
      // Finnhub tags general news with the tickers it concerns.
      symbols: String(n.related || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    })),
  },
  {
    // Recommended primary for Indian coverage: entity-tagged, country filter, own sentiment score.
    // Free plan = ~100 requests/day, so it is called every 20 minutes (72/day) and never in a burst.
    id: 'marketaux', label: 'Marketaux', env: 'MARKETAUX_API_KEY', tagsSymbols: true,
    minIntervalMin: 20, dailyBudget: 90,
    note: 'free plan ~100 req/day — spent at 72/day (every 20 min), limit via MARKETAUX_LIMIT',
    url: (k) => 'https://api.marketaux.com/v1/news/all?countries=in&language=en&filter_entities=true&must_have_entities=true&limit='
      + encodeURIComponent(String(process.env.MARKETAUX_LIMIT || 50)) + '&api_token=' + encodeURIComponent(k),
    parse: (j) => ((j && j.data) || []).map((n) => ({
      title: n.title, desc: n.description, link: n.url,
      ts: n.published_at ? Date.parse(n.published_at) : Date.now(),
      symbols: (n.entities || []).map((e) => String(e.symbol || '').toUpperCase()).filter(Boolean),
      // Marketaux ships its own sentiment, so direction need not be keyword-guessed.
      sentiment: (n.entities || []).map((e) => e.sentiment_score).filter((x) => typeof x === 'number')[0],
    })),
  },
  {
    // 25 requests/day on the free plan: twice a day is already generous, so it is a supplement.
    id: 'alphavantage', label: 'Alpha Vantage', env: 'ALPHAVANTAGE_API_KEY', tagsSymbols: true,
    minIntervalMin: 720, dailyBudget: 20,
    note: 'free plan = 25 requests/day — kept as a slow supplement (every 12h)',
    url: (k) => 'https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=financial_markets&limit=50&apikey=' + encodeURIComponent(k),
    parse: (j) => ((j && j.feed) || []).map((n) => {
      const best = (n.ticker_sentiment || [])
        .filter((t) => Number(t.relevance_score) >= 0.15)
        .sort((a, b) => Number(b.relevance_score) - Number(a.relevance_score))[0];
      return {
        title: n.title, desc: n.summary, link: n.url,
        // Alpha Vantage stamps are UTC. Parsed without the trailing Z the whole feed would land 5.5
        // hours early in IST — enough to put every item outside the 90-minute live window.
        ts: n.time_published ? Date.parse(String(n.time_published).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6Z')) : Date.now(),
        symbols: best ? [String(best.ticker).toUpperCase()] : [],
        sentiment: best ? Number(best.ticker_sentiment_score) : Number(n.overall_sentiment_score),
      };
    }),
  },
  {
    // Headline firehose only — no ticker tags, so these still go through the resolver.
    id: 'newsapi', label: 'NewsAPI', env: 'NEWSAPI_KEY', tagsSymbols: false,
    minIntervalMin: 30, dailyBudget: 48,
    url: (k) => 'https://newsapi.org/v2/top-headlines?country=in&category=business&pageSize=50&apiKey=' + encodeURIComponent(k),
    parse: (j) => ((j && j.articles) || []).map((n) => ({
      title: n.title, desc: n.description, link: n.url,
      ts: n.publishedAt ? Date.parse(n.publishedAt) : Date.now(),
    })),
  },
  {
    id: 'gnews', label: 'GNews', env: 'GNEWS_API_KEY', tagsSymbols: false,
    minIntervalMin: 30, dailyBudget: 48,
    url: (k) => 'https://gnews.io/api/v4/top-headlines?country=in&lang=en&category=business&max=50&apikey=' + encodeURIComponent(k),
    parse: (j) => ((j && j.articles) || []).map((n) => ({
      title: n.title, desc: n.description, link: n.url,
      ts: n.publishedAt ? Date.parse(n.publishedAt) : Date.now(),
    })),
  },
  {
    // FinNews.io — free tier: 100 requests/day and only THREE articles per request, ticker-tagged and
    // LLM-scored, sources refreshed every minute. Three articles is too few to spend on a general
    // firehose, so the request is pointed at the names that matter (FINNEWS_SYMBOLS) and made every
    // 15 minutes (96/day, inside the 100/day cap). The response shape is parsed defensively
    // (`articles|data|news|results`) because the free tier's exact envelope is not documented.
    id: 'finnews', label: 'FinNews', env: 'FINNEWS_API_KEY', tagsSymbols: true,
    minIntervalMin: 15, dailyBudget: 96,
    note: 'free tier = 100 req/day AND 3 articles/request — spent on FINNEWS_SYMBOLS (default: 3 index heavyweights)',
    url: (k) => 'https://api.finnews.io/v1/news?limit=3&symbols=' + encodeURIComponent(finnewsSymbols().join(','))
      + '&api_token=' + encodeURIComponent(k),
    parse: (j) => {
      const arr = Array.isArray(j) ? j : ((j && (j.articles || j.data || j.news || j.results)) || []);
      return (Array.isArray(arr) ? arr : []).map((n) => ({
        title: n.title || n.headline, desc: n.summary || n.description || n.body,
        link: n.url || n.link,
        ts: Date.parse(n.published_at || n.publishedAt || n.datetime || n.date) || Date.now(),
        symbols: tickersOf(n), sentiment: sentimentOf(n),
      }));
    },
  },
  {
    // Tradient — free plan with Indian market news, but its endpoint is NOT published in a form this
    // file can hard-code. Guessing a URL would produce a 404 that looks like "the feed is down", so the
    // endpoint comes from TRADIENT_NEWS_URL (paste it from the dashboard, with {key} where the token
    // goes) and, until that exists, the provider reports exactly what it is missing rather than
    // silently contributing nothing.
    id: 'tradient', label: 'Tradient', env: 'TRADIENT_API_KEY', tagsSymbols: false, unverified: true,
    minIntervalMin: 10, dailyBudget: 144, requiresUrl: 'TRADIENT_NEWS_URL',
    note: 'needs TRADIENT_API_KEY and TRADIENT_NEWS_URL (its docs are not public — paste the endpoint from the dashboard; {key} is replaced with the token)',
    url: (k) => endpointOf({ requiresUrl: 'TRADIENT_NEWS_URL' }).replace('{key}', encodeURIComponent(k)),
    parse: (j) => {
      const arr = Array.isArray(j) ? j : ((j && (j.data || j.news || j.articles || j.results)) || []);
      return (Array.isArray(arr) ? arr : []).map((n) => ({
        title: n.title || n.headline || n.name, desc: n.summary || n.description || n.content,
        link: n.url || n.link,
        ts: Date.parse(n.published_at || n.publishedAt || n.datetime || n.date || n.time) || Date.now(),
        symbols: tickersOf(n), sentiment: sentimentOf(n),
      }));
    },
  },
];

/** Configured at all: the key exists AND, where the endpoint is not hard-coded, the URL exists. */
function configured(p) {
  if (!keyOf(p)) return false;
  if (p.requiresUrl && !endpointOf(p)) return false;
  return true;
}

/** The keyed providers that have a key right now. */
function activeApiProviders() {
  return API_PROVIDERS.filter(configured);
}

/**
 * dueProviders(nowMs) — configured, INSIDE its daily budget, past its own cadence, and not sitting on
 * an exhausted vendor rate limit. This is what the refresh cycle calls; `activeApiProviders` stays for
 * the health row ("what is one key away") and for the tests.
 */
function dueProviders(nowMs) {
  const now = nowMs || Date.now();
  return API_PROVIDERS.filter((p) => {
    if (!configured(p)) return false;
    const L = ledgerOf(p.id);
    if (p.dailyBudget && L.calls >= p.dailyBudget) return false;
    if (L.remaining != null && L.remaining <= 0 && L.resetAt && now < L.resetAt) return false;
    if (p.minIntervalMin && (now - L.lastAt) < p.minIntervalMin * 60000) return false;
    return true;
  });
}

/** Why a configured provider is not being called right now, in one line the page can print. */
function skipReason(p, nowMs) {
  const now = nowMs || Date.now();
  if (!keyOf(p)) return 'no key (' + p.env + ' — paste it on the News page or set it in .env)';
  if (p.requiresUrl && !endpointOf(p)) return 'no endpoint (' + p.requiresUrl + ') — see its note';
  const L = ledgerOf(p.id);
  if (p.dailyBudget && L.calls >= p.dailyBudget) return 'daily budget spent (' + L.calls + '/' + p.dailyBudget + ') — resumes after the IST midnight reset';
  if (L.remaining != null && L.remaining <= 0 && L.resetAt && now < L.resetAt) return 'vendor rate limit: 0 left until ' + new Date(L.resetAt).toISOString();
  if (p.minIntervalMin && (now - L.lastAt) < p.minIntervalMin * 60000) return 'next call in ' + Math.ceil((p.minIntervalMin * 60000 - (now - L.lastAt)) / 1000) + 's (every ' + p.minIntervalMin + ' min)';
  return 'due now';
}

/**
 * Health of the whole source list, surfaced on the page so "why so few headlines" is
 * answerable instead of mysterious.
 */
function providersStatus() {
  const now = Date.now();
  return {
    rss: FEEDS.map((f) => ({ id: f.name, label: f.name, kind: 'rss', enabled: true, tagsSymbols: false })),
    api: API_PROVIDERS.map((p) => {
      const L = ledgerOf(p.id);
      return {
        id: p.id, label: p.label, kind: 'api', tagsSymbols: !!p.tagsSymbols,
        enabled: configured(p), env: p.env,
        // the free-plan bookkeeping, on screen: how much of today's budget this source has spent
        callsToday: L.calls, dailyBudget: p.dailyBudget || null, minIntervalMin: p.minIntervalMin || null,
        okToday: L.ok, errorsToday: L.errors, lastError: L.lastError, lastAt: L.lastAt ? new Date(L.lastAt).toISOString() : null,
        vendorRemaining: L.remaining, due: dueProviders(now).indexOf(p) >= 0, why: skipReason(p, now),
        note: p.note || null, unverified: !!p.unverified, requiresUrl: p.requiresUrl || null,
        // WHERE THE KEY CAME FROM, masked: enough to answer "did my paste take effect", never the key.
        keySource: keyState(p).source, keyTail: keyState(p).tail, hasEndpoint: !p.requiresUrl || !!endpointOf(p),
      };
    }),
    enabledCount: FEEDS.length + activeApiProviders().length,
    totalCount: FEEDS.length + API_PROVIDERS.length,
    budgetDay: _ledger.day,
    dueCount: dueProviders(now).length,
  };
}

/**
 * poolSummary(items) — WHAT IS ON THE BOARD, independent of any time window.
 *
 * The live strip asks for the last 90 minutes of directional, company-resolved news. That is the right
 * question for an entry, and a terrible thing to render as "the news": after the close (or in any
 * quiet 90 minutes) it is empty, so the page went blank and showed 0 — then 1 when the next headline
 * landed. The pool is the other half of the answer: everything classified and still inside the 72h
 * window, with its newest item's age, so "0 live" can never be read as "no news".
 */
function poolSummary(items) {
  const list = items || [];
  const by = { UP: 0, DOWN: 0, MACRO: 0, NEUTRAL: 0, EVENT: 0 };
  let newest = 0, oldest = null, resolved = 0, liveDir = 0;
  const cut = Date.now() - 90 * 60000;
  for (const i of list) {
    by[i.direction] = (by[i.direction] || 0) + 1;
    const t = i.ts || 0;
    if (t > newest) newest = t;
    if (oldest == null || t < oldest) oldest = t;
    if (i.symbols && i.symbols.length) resolved++;
    if (t >= cut && (i.direction === 'UP' || i.direction === 'DOWN')) liveDir++;
  }
  return {
    count: list.length, by, resolved,
    newestAt: newest ? new Date(newest).toISOString() : null,
    newestAgeSec: newest ? Math.round((Date.now() - newest) / 1000) : null,
    oldestAt: oldest ? new Date(oldest).toISOString() : null,
    windowMin: 90, directionalLast90m: liveDir,
    note: 'the pool is everything classified inside the 72h keep-window; the 90-minute directional slice is the LIVE window and is expected to be empty after the close',
  };
}

/** Fetch + normalise one keyed provider. Never throws: a down provider is not a cycle failure. */
async function fetchApiProvider(p, timeoutMs) {
  const key = keyOf(p);
  if (!key) return { provider: p, items: [], error: 'no key' };
  const L = ledgerOf(p.id);
  L.calls++;
  L.lastAt = Date.now();
  const fail = (msg) => { L.errors++; L.lastError = msg; saveLedger(); return { provider: p, items: [], error: msg }; };
  try {
    const r = await fetch(p.url(key), { signal: AbortSignal.timeout(timeoutMs || 12000) });
    // VENDOR RATE LIMITS ARE RESPECTED, NOT DISCOVERED BY 429s. FinNews and friends return
    // X-RateLimit-Remaining / X-RateLimit-Reset; when the budget reads zero the provider is skipped
    // until the vendor's own reset instead of hammering it and losing the source for the day.
    const rem = r.headers && r.headers.get ? r.headers.get('x-ratelimit-remaining') : null;
    if (rem != null && rem !== '') {
      L.remaining = Number(rem);
      const resetAt = r.headers.get('x-ratelimit-reset');
      const t = resetAt ? Date.parse(resetAt) : NaN;
      L.resetAt = Number.isFinite(t) ? t : null;
    }
    if (!r.ok) {
      let detail = 'HTTP ' + r.status;
      try {
        const body = await r.text();
        if (body) detail += ' ' + body.slice(0, 140).replace(/\s+/g, ' ');
      } catch (_) { /* the status is the message then */ }
      return fail(detail);
    }
    const j = await r.json();
    const items = (p.parse(j) || []).filter((n) => n && n.title)
      .map((n) => Object.assign({}, n, { symbols: n.symbols || [] }));
    L.ok++;
    L.lastOkAt = Date.now();
    L.lastError = null;
    saveLedger();
    return { provider: p, items, error: null };
  } catch (e) {
    return fail((e && e.message) || 'fetch failed');
  }
}

/**
 * CROSS-SOURCE COVERAGE. The same story reaches us from several providers in different
 * words, so exact-title dedupe cannot see it. Count how many DISTINCT providers carry a
 * story sharing the same significant words, and let that raise importance: one outlet's
 * item and four outlets leading with it are not the same evidence.
 */
function coverageBoost(items) {
  const sigOf = (t) => String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w.toUpperCase())).sort().slice(0, 6).join('-');
  const bySig = new Map();
  for (const it of items) {
    const s = sigOf(it.title);
    if (!s) continue;
    if (!bySig.has(s)) bySig.set(s, new Set());
    bySig.get(s).add(it.source);
  }
  for (const it of items) {
    const s = sigOf(it.title);
    const srcs = s ? bySig.get(s) : null;
    it.coverage = srcs ? srcs.size : 1;
    if (it.coverage > 1) {
      it.importance = Math.min(1, +(it.importance + Math.min(0.25, 0.1 * (it.coverage - 1))).toFixed(3));
    }
  }
  return items;
}

const seenTitles = new Set();
function dedupeKey(t) { return String(t).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 90); }

async function refresh(opts = {}) {
  const seenBefore = loadIndex();
  for (const k of seenBefore.items.map((i) => i.dedupe)) seenTitles.add(k);
  _symIndex = await buildSymIndex();

  const out = [];
  const providerErrors = [];
  const skipped = [];
  // ONE PIPELINE, MANY SOURCES. Every keyed provider is normalised into the same shape as
  // an RSS feed ({name, item}) and then flows through the UNCHANGED classification below —
  // one place decides what a headline means, whatever it arrived from.
  const apiSources = [];
  // ONLY the providers whose own budget and cadence say "due" — see the FREE-TIER BUDGETS note. The
  // rest are reported with the reason they were skipped, so a quiet source is explained rather than
  // mysterious ("daily budget spent (90/90)" vs "no key").
  const due = dueProviders();
  for (const p of activeApiProviders()) if (due.indexOf(p) < 0) skipped.push(p.id + ': ' + skipReason(p));
  for (const res of await Promise.all(due.map((p) => fetchApiProvider(p, opts.timeoutMs)))) {
    if (res.error) providerErrors.push(res.provider.id + '=' + res.error);
    for (const it of res.items) {
      apiSources.push({ name: res.provider.id, item: it, tagged: it.symbols, sentiment: it.sentiment, tags: !!res.provider.tagsSymbols });
    }
  }
  for (const feed of FEEDS.concat(apiSources.map((s) => ({ name: s.name, __api: s })))) {
    try {
      const r = feed.__api ? null : await fetch(feed.url, { signal: AbortSignal.timeout(opts.timeoutMs || 10000) });
      if (r && !r.ok) continue;
      const xml = r ? await r.text() : '';
      for (const it of (feed.__api ? [feed.__api.item] : parseRss(xml))) {
        const key = dedupeKey(it.title);
        if (seenTitles.has(key)) continue;
        seenTitles.add(key);
        const text = it.title + ' ' + (it.desc || '');
        // A PROVIDER TAG IS AUTHORITATIVE. When the source says which ticker it is about,
        // that beats any inference from the headline — it is the tagged case the whole
        // resolution heuristic exists to approximate. Untagged providers still resolve.
        const tagged = (feed.__api && feed.__api.tags && feed.__api.tagged) ? feed.__api.tagged : null;
        const symbols = (tagged && tagged.length)
          ? tagged.filter((s) => tradableSet().has(s))
          : await resolveSymbolsLive(text, it.title + ' ' + (it.desc || ''));
        // A resolved company takes precedence over market keywords in its description.
        const cls = classify(text, { companyRulesOnly: symbols.length > 0 });
        // A COMPANY direction only counts when it names a company. "Economists raise India's
        // GDP forecast" fired the earnings rule and read as a stock UP — it is macro, and
        // with no symbol attached it must not be shipped as a company signal.
        let direction = cls ? cls.dir : 'NEUTRAL';
        let why = cls ? cls.why : 'no directional keyword matched';
        const isCompany = symbols.length > 0;
        // A DIRECTIONAL CLAIM NEEDS A COMPANY. Measured defect: "ADB raised India's FY27
        // growth forecast to 7%" fired the earnings rule and shipped as a stock UP arrow.
        // So a company direction survives only if a symbol resolved OR the headline is
        // explicitly about a security ("Ola Electric SHARES tumble 9%", "Q2 results",
        // "promoter stake sale"). Otherwise it is market context, not a stock call.
        const companyMarker = /\b(shares?|stocks?|scrip|q[1-4]\b|result|results|net profit|revenue|board|promoter|block deal|bulk deal|ipo\b|ltd\b|limited|earnings|dividend|buyback)\b/i.test(text);
        const marketish = /\b(rbi|fed\b|gdp|cpi|inflation|budget|nifty|sensex|rupee|econom(y|ists?)|agencies|agency|monsoon|crude|forecast|rating(s)?\b|policy|reform|exports?|imports?|gst|tax|fiscal)\b/i.test(text);
        if (!isCompany && (direction === 'UP' || direction === 'DOWN') && (marketish || !companyMarker)) {
          direction = marketish ? 'MACRO' : 'NEUTRAL';
          why = marketish ? 'macro / market context — no company named' : 'no company named';
        }
        // PROVIDER SENTIMENT BEATS A KEYWORD GUESS when the source supplies one and the
        // headline is actually about a listed name. A keyword rule cannot tell "beats
        // estimates" from "misses estimates"; a sentiment score can. Magnitude is kept as
        // the confidence so a weak provider read stays visibly weak.
        let providerConf = null;
        if (feed.__api && typeof feed.__api.sentiment === 'number' && Number.isFinite(feed.__api.sentiment) && symbols.length) {
          const sen = feed.__api.sentiment;
          if (Math.abs(sen) >= 0.15) {
            direction = sen > 0 ? 'UP' : 'DOWN';
            why = 'provider sentiment ' + sen.toFixed(2) + ' for ' + symbols[0];
            providerConf = Math.min(0.9, 0.5 + Math.abs(sen));
          }
        }
        out.push({
          source: feed.name,
          symbolTagged: !!(tagged && tagged.length),
          title: it.title,
          desc: it.desc,
          link: it.link,
          ts: it.ts || Date.now(),
          fetchedAt: new Date().toISOString(),
          symbols,
          direction,
          importance: cls ? cls.imp : 0,
          confidence: providerConf != null ? providerConf : (cls ? cls.confidence : 0.3),
          reason: why,
          eventType: why.replace(/\s*\(.*\)$/, ''),
          dedupe: key,
        });
      }
    } catch (_) { /* feed down — skip, never throw */ }
  }
  coverageBoost(out);
  out.sort((a, b) => b.ts - a.ts);

  // RE-RESOLVE the stored items that predate the symbol index. Measured: the first runs
  // stored 100 headlines with symbols:[] because resolution was a no-op then; without
  // this backfill they would stay symbol-less forever and never reach the blast list.
  const backfilled = await backfillSymbols(seenBefore.items, opts.backfill || 60);

  // Persist: newest-first, capped, with a meta block. The previous file is overwritten
  // only after a successful fetch cycle; on total failure the old file is kept.
  const prev = { items: backfilled };
  const merged = merge(prev.items, out);
  const payload = {
    kind: 'news-classified',
    generatedAt: new Date().toISOString(),
    feedsTried: FEEDS.length,
    providers: providersStatus(),
    providerErrors,
    providersSkipped: skipped,
    // WHAT THE CYCLE ACTUALLY DID, so "0" can never be mistaken for "dead": a cycle that fetched 0 new
    // headlines is a normal cycle, and the pool size beside it says whether anything is on the board.
    cycle: {
      at: new Date().toISOString(),
      fresh: out.length,
      providersCalled: due.length,
      providersSkipped: skipped.length,
      rssTried: FEEDS.length,
    },
    freshThisRun: out.length,
    total: merged.length,
    counts: countsOf(merged),
    note: 'direction is a keyword classification, NOT a V3 decision; news can never bypass gates (plan §2)',
    items: merged,
  };
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  } catch (_) {}
  return payload;
}

/** Give previously-stored, symbol-less items a symbol (bounded per run). */
async function backfillSymbols(items, limit) {
  const missing = (items || []).filter((i) => (!i.symbols || !i.symbols.length) && i.title).slice(0, limit);
  for (const it of missing) {
    try {
      const syms = await resolveSymbolsLive(it.title + ' ' + (it.desc || ''), it.title + ' ' + (it.desc || ''));
      if (syms.length) {
        it.symbols = syms;
        const isCompany = true;
        if (!isCompany) continue;
        if (it.direction === 'UP' || it.direction === 'DOWN') it.reason = it.reason || 'company news';
      }
    } catch (_) {}
  }
  return items || [];
}

function merge(prevItems, fresh) {
  const byKey = new Map(prevItems.map((i) => [i.dedupe, i]));
  for (const f of fresh) byKey.set(f.dedupe, f);
  const cutoff = Date.now() - 72 * 3600 * 1000; // keep 72h
  return [...byKey.values()]
    .filter((i) => (i.ts || 0) > cutoff)
    .sort((a, b) => (b.importance - a.importance) || (b.ts - a.ts))
    .slice(0, 400);
}

function countsOf(items) {
  const c = { UP: 0, DOWN: 0, NEUTRAL: 0, MACRO: 0, EVENT: 0, withSymbol: 0 };
  for (const i of items) {
    c[i.direction] = (c[i.direction] || 0) + 1;
    if (i.symbols && i.symbols.length) c.withSymbol++;
  }
  return c;
}

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); }
  catch (_) { return { items: [], generatedAt: null, counts: countsOf([]) }; }
}

/** The premarket blast list: symbol-resolved, directional, newest first. */
function premarketList() {
  const idx = loadIndex();
  return {
    generatedAt: idx.generatedAt,
    blast: idx.items
      .filter((i) => i.symbols && i.symbols.length && (i.direction === 'UP' || i.direction === 'DOWN') && i.importance >= 0.55)
      .sort((a, b) => (b.importance - a.importance) || (b.ts - a.ts))
      .slice(0, 25),
  };
}

/**
 * buildIndex({ full }) — fill the symbol index now.
 * `full: true` ignores the fresh-cache shortcut and fetches EVERY tradable symbol that
 * is missing, which is what to run after a first build that lost symbols to Yahoo rate
 * limits. Ordinary refreshes use the bounded self-healing gap batch instead.
 */
async function buildIndex(opts = {}) {
  if (opts.full) {
    try { fs.rmSync(SYM_INDEX_FILE, { force: true }); } catch (_) {}
    _symIndex = null;
    _tradable = null;
  }
  _symIndex = await buildSymIndex({ gapBatch: opts.full ? Infinity : opts.gapBatch });
  return _symIndex;
}

/**
 * refreshIfStale({ maxAgeSec, wait }) — THE SELF-HEALING REFRESH.
 *
 * The board used to be as stale as the background cycle: the strip polls every second but reads
 * whatever the last 10-minute fetch produced, so a headline that broke two minutes ago could be
 * invisible for eight more — exactly the "news is rapid in India but the board is empty" complaint.
 * This returns the current index immediately and kicks ONE background refresh when it is older than
 * maxAgeSec. Concurrent callers share the in-flight promise (`_inFlight`), so a 1-second poll cadence
 * can never start a second fetch or hammer the RSS hosts; with `wait: true` the caller awaits it.
 */
let _inFlight = null;
function refreshIfStale(opts = {}) {
  const maxAgeSec = opts.maxAgeSec == null ? 120 : opts.maxAgeSec;
  const idx = loadIndex();
  const ageSec = idx.generatedAt ? Math.round((Date.now() - Date.parse(idx.generatedAt)) / 1000) : null;
  const stale = ageSec == null || ageSec > maxAgeSec;
  if (!stale || opts.off) return Promise.resolve({ idx, ageSec, refreshed: false, inFlight: !!_inFlight });
  if (_inFlight) {
    return (_inFlight).then((p) => ({ idx: p && p.items ? p : loadIndex(), ageSec, refreshed: false, shared: true, inFlight: true }))
      .catch(() => ({ idx, ageSec, refreshed: false, inFlight: false }));
  }
  _inFlight = refresh({ backfill: opts.backfill || 12 })
    .catch(() => null)
    .then((p) => { _inFlight = null; return p; });
  if (opts.wait) {
    return _inFlight.then((p) => ({ idx: (p && p.items) ? p : loadIndex(), ageSec, refreshed: !!(p && p.items), inFlight: false }));
  }
  // Fire and forget: answer the page NOW with what exists, and let the next poll show the new headline.
  return Promise.resolve({ idx, ageSec, refreshed: false, starting: true, inFlight: true });
}
/** Age of the stored index, in seconds. Null when nothing has been fetched yet. */
function stalenessSec() {
  const idx = loadIndex();
  return idx.generatedAt ? Math.round((Date.now() - Date.parse(idx.generatedAt)) / 1000) : null;
}

module.exports = {
  refresh, classify, resolveSymbols, resolveSymbolsLive, buildIndex, loadIndex, premarketList, parseRss, cleanName,
  FEEDS, OUT, API_PROVIDERS, activeApiProviders, dueProviders, skipReason, providersStatus, poolSummary, coverageBoost,
  LEDGER_FILE, ledgerOf, loadLedger, KEYS_FILE, keyOf, keyState, setKeys, endpointOf, refreshIfStale, stalenessSec,
};

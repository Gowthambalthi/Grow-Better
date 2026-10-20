/**
 * newsStore.js
 *
 * The ONE place that decides what a headline belongs to and which stock it is
 * about. The news page, the API and the event study all read THIS module, so a
 * headline cannot be "FED" on the page and "OIL" in the backtest.
 *
 * WHAT IS STORED
 *   data/news/items.jsonl   one JSON object per line, append-only, deduped by
 *                           (date + normalized title). Written by the harvester.
 *   data/news/state.json    which (category, month) chunks have already been
 *                           fetched, so a re-run resumes instead of re-asking
 *                           Google for the same month forty times.
 *   data/news/reaction.json the event-study result (written by another script,
 *                           served read-only by the API).
 *
 * HONEST LIMITS OF THE SOURCE
 *   The feed is Google News RSS. Historical items carry a DATE but not a real
 *   time of day (Google normalizes old items to 08:00 GMT), so nothing here may
 *   claim an intraday minute for a headline. Every consumer must treat an item
 *   as "this happened on <date>" — the event study measures day D, D+1, D+5...
 *   A headline being in this file is not evidence it moved the stock.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', '..', 'data', 'news');
const FILES = {
  items: path.join(DIR, 'items.jsonl'),
  state: path.join(DIR, 'state.json'),
  reaction: path.join(DIR, 'reaction.json'),
  bars: path.join(DIR, '_bars'),
};
const SYMBOL_INDEX = path.join(__dirname, '..', '..', 'data', 'news_symbol_index.json');

// THE PRICE CORPUS FOR SYMBOL TAGGING. `data/ohlcv_1m` was the full corpus when
// this file was written, but it has since been trimmed to a 20-file scratch
// directory while the real corpus lives in `data/ohlcv_1m_full` — and a
// recategorize run against the trimmed directory silently re-tagged 15,373
// headlines down to 202, because a ticker is only accepted if its price file
// exists. The full corpus is preferred; the old path remains a fallback.
function corpusDir() {
  const full = path.join(__dirname, '..', '..', 'data', 'ohlcv_1m_full');
  try {
    if (fs.readdirSync(full).length) return full;
  } catch (e) { /* fall through */ }
  return path.join(__dirname, '..', '..', 'data', 'ohlcv_1m');
}

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// THE CATEGORIES the user asked for, in the user's own words.
// Order matters: it is the order the page shows the chips in.
// ---------------------------------------------------------------------------
// `search` is the query sent to Google (context words help the search engine).
// `match` is what this file tests locally, and it is deliberately LONER than
// the search string: a headline does not say "bulk deal NSE", it says "Bulk
// deal:", so requiring the context word after the phrase drops real hits.
const CATEGORIES = [
  {
    id: 'promoter',
    label: 'Promoter holding',
    blurb: 'a promoter raising or pledging a stake',
    search: [
      '"promoter holding"', '"promoter stake"', '"promoters increase stake"',
      '"promoter buys"', '"promoter pledge"', '"promoter shareholding"',
      '"increase stake" promoter',
    ],
    match: ['promoter holding', 'promoter stake', 'promoter shareholding', 'promoter pledge',
      'promoters increase', 'promoter buys', 'promoter raises', 'increases stake',
      'raise stake', 'raises stake', 'stake increase'],
  },
  {
    id: 'results',
    label: 'Results & earnings',
    blurb: 'quarterly numbers, profit, guidance',
    search: [
      '"Q1 results"', '"Q2 results"', '"Q3 results"', '"Q4 results"',
      '"quarterly results"', '"net profit" India', '"earnings" NSE company',
      '"profit rises"', '"profit falls"',
    ],
    match: ['quarterly results', 'q1 results', 'q2 results', 'q3 results', 'q4 results',
      'net profit', 'profit rises', 'profit falls', 'profit jumps', 'profit slumps',
      'earnings beat', 'earnings miss', 'revenue rises', 'revenue falls', 'results today',
      'q1 profit', 'q2 profit', 'q3 profit', 'q4 profit'],
  },
  {
    id: 'deals',
    label: 'Deals & M&A',
    blurb: 'acquisitions, mergers, joint ventures',
    search: [
      '"acquisition" NSE company', '"acquires stake"', '"merger" India company',
      '"takeover" India', '"joint venture" India company', '"demerger" India',
    ],
    match: ['acquisition', 'acquires', 'to acquire', 'merger', 'merges with', 'takeover',
      'joint venture', 'demerger', 'amalgamation', 'buyout', 'acquire stake'],
  },
  {
    id: 'bulk',
    label: 'Bulk & block deals',
    blurb: 'a large single-counter trade, someone selling or buying size',
    search: [
      '"bulk deal" NSE', '"block deal" NSE', '"stake sale" NSE',
      '"divests stake"', '"offloads shares"', '"sells shares" block',
    ],
    match: ['bulk deal', 'block deal', 'bulk deals', 'block deals', 'stake sale',
      'divests', 'divestment', 'offloads', 'offloaded', 'sells stake', 'sells shares',
      'block sale', 'sells 1%', 'sells 2%', 'sells 5%'],
  },
  {
    id: 'oil',
    label: 'Oil & commodities',
    blurb: 'crude, Brent, OPEC — hits refiners and importers',
    search: [
      '"crude oil price"', '"Brent crude"', '"OPEC" cut', '"oil prices rise"',
      '"oil prices fall"', '"natural gas price" India',
    ],
    match: ['crude oil', 'crude prices', 'brent', 'opec', 'oil prices', 'oil price',
      'natural gas price', 'petrol price', 'diesel price', 'refinery margin'],
  },
  {
    id: 'war',
    label: 'War & geopolitics',
    blurb: 'conflict, sanctions, borders, shipping lanes',
    search: [
      '"war" market', '"missile attack" market', '"sanctions" India trade',
      '"tensions escalate" market', '"ceasefire" market', '"Strait of Hormuz"',
      '"Red Sea" shipping attack',
    ],
    match: ['war', 'wars', 'missile', 'airstrike', 'air strike', 'sanctions', 'ceasefire',
      'tensions', 'escalation', 'escalates', 'strait of hormuz', 'red sea', 'gaza',
      'ukraine', 'israel', 'iran', 'drone attack', 'conflict', 'geopolitical'],
  },
  {
    id: 'fed',
    label: 'Fed & rates',
    blurb: 'US Fed, RBI, rate decisions, inflation prints',
    search: [
      '"Federal Reserve" rate', '"Fed rate cut"', '"Fed rate hike"',
      '"RBI policy" rate', '"RBI repo rate"', '"interest rate decision"',
      '"inflation data" India',
    ],
    match: ['federal reserve', 'fed rate', 'fed cut', 'fed hike', 'rbi policy',
      'repo rate', 'rate cut', 'rate hike', 'interest rate', 'inflation', 'cpi data',
      'monetary policy', 'powell', 'fomc'],
  },
  {
    id: 'ceo',
    label: 'CEO & leadership',
    blurb: 'a chief executive or MD leaving or arriving',
    search: [
      '"CEO resigns" India', '"CEO steps down"', '"MD resigns" India',
      '"managing director" resigns', '"CEO appointed" India company',
      '"chairman" steps down India',
    ],
    match: ['ceo resigns', 'ceo steps down', 'ceo quits', 'ceo exits', 'ceo appointed',
      'new ceo', 'md resigns', 'md steps down', 'managing director', 'chief executive',
      'chairman steps down', 'chairman resigns', 'removal of ceo', 'ceo change'],
  },
  {
    id: 'ai',
    label: 'AI boom & capex',
    blurb: 'companies spending more on AI, chips, data centres',
    search: [
      '"AI investment" company', '"AI capex"', '"artificial intelligence" investment India',
      '"data centre" investment India', '"AI spending" billion',
      '"chips" investment data centre India',
    ],
    match: ['artificial intelligence', 'ai investment', 'ai capex', 'ai spending',
      'data centre', 'data center', 'ai boom', 'ai chip', 'gpu', 'hyperscaler',
      'ai infrastructure', 'ai spending'],
  },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

// Direction is a KEYWORD read of the headline — it is not a decision and never
// bypasses a gate. CROSS-VERIFIED 2026-10-20 against what the tagged stock
// actually did (market-adjusted, learning window ≤ 2026-05-29): the old lists
// beat a coin flip (UP 55.8% / DOWN 60.7% hit rate) but carried real bugs the
// audit printed — "stirring up trouble" matched the bare word "up" and tagged
// a Middle-East escalation UP, "record loss" matched "record", and a rate CUT
// is usually bullish for equities while the bare word "cuts" read it bearish.
//
// The rules now: WHOLE WORDS only, phrases that mean one thing, and three
// context overrides that fire on their own (rate decisions, conflict
// escalation/easing). Every list is regexes so "ups"/"downs"/"falling" are
// matched as words, not substrings of their neighbours.
const BULL_RX = [
  /\brises?\b/, /\brising\b/, /\bjumps?\b/, /\bjumped\b/, /\bsurges?\b/, /\bsurged\b/,
  /\bsoars?\b/, /\bsoared\b/, /\bgains?\b/, /\bgain\b/, /\bbeats?\b/, /\bbeat estimates\b/,
  /\brecord (profit|revenue|earnings|sales|high|orders?|demand)\b/,
  /\bwins? (an )?(order|contract|approval)\b/, /\bbags? (an )?(order|contract)\b/,
  /\bexpands?\b/, /\bacquires?\b/, /\bto acquire\b/,
  /\bincreases? stake\b/, /\braises? stake\b/, /\bupgrades?\b/, /\bupgraded\b/,
  /\brallies\b/, /\brally\b/, /\bhits (an? )?(record |all[- ]time )?high\b/,
  /\bapproves?\b/, /\bcleared? by (the )?rbi\b/, /\brbi clears\b/,
  /\bstrong (results|growth|quarter|demand|orders)\b/,
  /\bprofit (jumps|soars|rises|surges|doubles|climbs)\b/,
];
const BEAR_RX = [
  /\bfalls?\b/, /\bfalling\b/, /\bslumps?\b/, /\bplunges?\b/, /\btumbles?\b/,
  /\bdrops?\b/, /\bslips?\b/, /\bdeclines?\b/, /\bmisses\b/,
  /\bloss(es)?\b/, /\bresigns?\b/, /\bsteps down\b/, /\bquits\b/,
  /\bsells? stake\b/, /\bdivests?\b/, /\bdowngrades?\b/, /\bdowngraded\b/,
  /\bprobe\b/, /\bfraud\b/, /\bdefault\b/, /\binsolvency\b/, /\brecall\b/,
  /\blawsuit\b/, /\bpenalt(y|ies)\b/, /\bwrites? down\b/, /\bwrite[- ]?downs?\b/,
  /\blayoffs?\b/, /\bdelisted\b/, /\bdelisting\b/, /\braided\b/, /\braids\b/,
  /\blowers? (guidance|forecast|outlook)\b/, /\bprice cuts?\b/,
  /\bprofit (falls|slumps|plunges|drops|declines|tumbles)\b/,
  /\bweak (results|demand|quarter)\b/,
];
// CONTEXT OVERRIDES — the cases where the naive verb read is backwards.
const RATE_CUT_RX = /\b(rate|repo|interest)[ -]?cuts?\b|\bcuts? (the )?(repo |interest )?rates?\b/;
const RATE_HIKE_RX = /\b(rate|repo|interest)[ -]?hikes?\b|\bhikes? (the )?(repo |interest )?rates?\b/;
// THE STOCK'S OWN MOVE OUTRANKS EVERYTHING ELSE. "Shares Fall Despite Record
// Orders" is a DOWN headline — the market already answered the record orders —
// and without this rule the two keywords tie and the tag reads MIXED.
const PRICE_MOVE_BEAR_RX = /\bshares? (falls?|falling|slips?|drops?|declines?|slumps?|plunges?|tumbles?)\b/;
const PRICE_MOVE_BULL_RX = /\bshares? (ris\w*|gains?|surge\w*|soar\w*|jump\w*|rallies)\b/;
const CONFLICT_EASE_RX = /\bceasefire\b|\bde[- ]?escalat/;
const CONFLICT_HEAT_RX = /\bescalat(e|es|ed|ing)\b|\btensions? (rise|escalate|surge)/;

function directionOf(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9%$. '\-]+/g, ' ').replace(/\s+/g, ' ') + ' ';
  let up = 0;
  let down = 0;
  for (const rx of BULL_RX) if (rx.test(t)) up++;
  for (const rx of BEAR_RX) if (rx.test(t)) down++;
  // A rate CUT is usually bullish for equities and a HIKE bearish — the bare
  // word "cuts" used to read a cut as a negative, which is backwards.
  if (RATE_CUT_RX.test(t)) up++;
  if (RATE_HIKE_RX.test(t)) down++;
  // When the headline states the stock's OWN price move, that vote counts twice.
  if (PRICE_MOVE_BEAR_RX.test(t)) down++;
  if (PRICE_MOVE_BULL_RX.test(t)) up++;
  // Conflict ESCALATING is risk-off whatever else the headline says; a
  // ceasefire or de-escalation flips it back.
  if (CONFLICT_EASE_RX.test(t)) up++;
  else if (CONFLICT_HEAT_RX.test(t)) down++;
  if (up === 0 && down === 0) return 'NEUTRAL';
  if (up > down) return 'UP';
  if (down > up) return 'DOWN';
  return 'MIXED';
}

// Category of a headline: keyword hits across the taxonomy, ties broken by the
// category whose term list hit first (the lists are ordered most-specific first
// for exactly this reason).
// Whole-word matching, not substring: "war" must not fire on "towards" or
// "warning", and "rates" must not fire on "rated".
let _catRx = null;
function catRx() {
  if (_catRx) return _catRx;
  _catRx = CATEGORIES.map((c) => ({
    id: c.id,
    rxs: c.match.map((m) => new RegExp('\\b' + re(m).replace(/\s+/g, '\\s+') + '\\b', 'i')),
  }));
  return _catRx;
}

function categoryOf(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9%&. ]+/g, ' ').replace(/\s+/g, ' ');
  const scores = [];
  catRx().forEach((c, i) => {
    let n = 0;
    for (const rx of c.rxs) if (rx.test(t)) n++;
    scores.push({ id: c.id, n, i });
  });
  scores.sort((a, b) => (b.n - a.n) || (a.i - b.i));
  return scores[0].n > 0 ? scores[0].id : 'other';
}

// ---------------------------------------------------------------------------
// SYMBOL TAGGING — which stock is this headline about?
//
// Two passes, both deliberately conservative:
//   1. the exchange TICKER written in the headline (RELIANCE, INFY, TCS). A
//      ticker is only accepted if the original text carries it in CAPITALS and
//      it is not a word that also means something else in English ("IDEA" and
//      "YES" are real NSE tickers, so a plain stoplist would be wrong — instead
//      the page shows every match and the study only keeps unambiguous ones).
//   2. the company NAME from the instrument master, matched with flexible
//      spacing ("HDFC BANK" matches "HDFC  Bank").
// Only tickers that exist in the 1-minute corpus can be tagged, because only
// those can be backtested.
// ---------------------------------------------------------------------------

// Words that are an NSE ticker AND ordinary English. A headline saying "up" must
// not tag a stock called UP.
const COMMON_WORDS = new Set([
  'ALL', 'AND', 'ANY', 'ARE', 'AT', 'BEST', 'BUY', 'CAN', 'CARE', 'CASH', 'CUB',
  'DAY', 'DOWN', 'EASY', 'EID', 'ELITE', 'END', 'FOR', 'FREE', 'GAIN', 'GOLD',
  'GOOD', 'GROW', 'HIT', 'IDEA', 'IND', 'IPO', 'IT', 'JUST', 'LIFE', 'LIVE',
  'MORE', 'NEW', 'NEXT', 'NOW', 'ONE', 'OPEN', 'OUT', 'PLUS', 'PRO', 'REAL',
  'SAFE', 'SALE', 'SAY', 'SELL', 'SET', 'SMART', 'SO', 'STAR', 'STAY', 'STOP',
  'SUN', 'TAKE', 'TATA', 'THE', 'TIME', 'TOP', 'UP', 'VALUE', 'WAY', 'WIN',
  'WISE', 'YES', 'YOU', 'ZERO',
]);

const ALIASES = {
  'reliance industries': 'RELIANCE',
  'reliance jio': 'RELIANCE',
  'infosys': 'INFY',
  'tata consultancy': 'TCS',
  'tcs': 'TCS',
  'hdfc bank': 'HDFCBANK',
  'icici bank': 'ICICIBANK',
  'state bank of india': 'SBIN',
  'sbi': 'SBIN',
  'axis bank': 'AXISBANK',
  'kotak mahindra bank': 'KOTAKBANK',
  'bharti airtel': 'BHARTIARTL',
  'airtel': 'BHARTIARTL',
  'larsen & toubro': 'LT',
  'larsen and toubro': 'LT',
  'l&t': 'LT',
  'tata motors': 'TATAMOTORS',
  'tata steel': 'TATASTEEL',
  'tata power': 'TATAPOWER',
  'itc': 'ITC',
  'hindustan unilever': 'HINDUNILVR',
  'maruti suzuki': 'MARUTI',
  'sun pharmaceutical': 'SUNPHARMA',
  'bajaj finance': 'BAJFINANCE',
  'asian paints': 'ASIANPAINT',
  'wipro': 'WIPRO',
  'hcl technologies': 'HCLTECH',
  'tech mahindra': 'TECHM',
  'adani enterprises': 'ADANIENT',
  'adani ports': 'ADANIPORTS',
  'vedanta': 'VEDL',
  'ongc': 'ONGC',
  'indian oil': 'IOC',
  'bharat petroleum': 'BPCL',
  'hindustan petroleum': 'HPCL',
  'coal india': 'COALINDIA',
  'ntpc': 'NTPC',
  'power grid': 'POWERGRID',
  'jsw steel': 'JSWSTEEL',
  'ultratech cement': 'ULTRACEMCO',
  'nestle india': 'NESTLEIND',
  'titan company': 'TITAN',
  'dr reddys': 'DRREDDY',
  'cipla': 'CIPLA',
  'divis laboratories': 'DIVISLAB',
  'vodafone idea': 'IDEA',
  'yes bank': 'YESBANK',
  'indusind bank': 'INDUSINDBK',
  'punjab national bank': 'PNB',
  'bank of baroda': 'BANKBARODA',
  'canara bank': 'CANBK',
  'zomato': 'ZOMATO',
  'paytm': 'PAYTM',
  'one97 communications': 'PAYTM',
  'nykaa': 'NYKAA',
  'dmart': 'DMART',
  'avenue supermarts': 'DMART',
  'irctc': 'IRCTC',
  'life insurance corporation': 'LICI',
  'lic': 'LICI',
  'hal': 'HAL',
  'bharat electronics': 'BEL',
  'bharat dynamics': 'BDL',
  'mazagon dock': 'MAZDOCK',
  'cochin shipyard': 'COCHINSHIP',
  'garden reach shipbuilders': 'GRSE',
  'hindustan aeronautics': 'HAL',
  'persistent systems': 'PERSISTENT',
  'coforge': 'COFORGE',
  'ltimindtree': 'LTIM',
  'mphasis': 'MPHASI',
};

let _corpus = null;
function corpusSymbols() {
  if (_corpus) return _corpus;
  try {
    _corpus = new Set(
      fs.readdirSync(corpusDir()).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')),
    );
  } catch (e) {
    _corpus = new Set();
  }
  return _corpus;
}

// Escape a literal for use inside a RegExp.
function re(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Flexible spacing between words: "HDFC BANK" also matches "HDFC  Bank".
function nameRegex(name) {
  const parts = String(name).trim().split(/\s+/).map(re);
  return new RegExp('\\b' + parts.join('\\s+') + '\\b', 'i');
}

let _nameMap = null;
function nameMap() {
  if (_nameMap) return _nameMap;
  const m = [];
  try {
    const raw = JSON.parse(fs.readFileSync(SYMBOL_INDEX, 'utf8'));
    const corpus = corpusSymbols();
    for (const e of raw.entries || []) {
      if (!corpus.has(e.symbol)) continue;
      const name = String(e.name || '').trim();
      if (name.length < 5) continue; // too short to be safe ("HCL", "3M")
      m.push({ symbol: e.symbol, rx: nameRegex(name), name });
    }
  } catch (e) { /* no index yet — ticker-only tagging still works */ }
  _nameMap = m;
  return m;
}

function tagSymbols(title, desc) {
  const text = String(title || '') + ' \n ' + String(desc || '');
  if (!text.trim()) return [];
  const out = [];
  const seen = new Set();
  const push = (sym) => {
    if (!sym || seen.has(sym)) return;
    if (!corpusSymbols().has(sym)) return;
    seen.add(sym);
    out.push(sym);
  };

  // 1. alias/company-name phrase (highest confidence — a full name is a
  //    deliberate mention). WHOLE WORDS: 'hal' must match "HAL bags order" and
  //    "Hindustan Aeronautics", but NOT "half-year results" or "Halliburton" —
  //    the old substring read tagged Hindustan Aeronautics on every half-year
  //    headline in the store (caught by the 2026-10-20 cross-verification).
  const low = text.toLowerCase();
  for (const [phrase, sym] of Object.entries(ALIASES)) {
    if (new RegExp('\\b' + re(phrase) + '\\b').test(low)) push(sym);
  }

  // 2. instrument-master company name
  for (const e of nameMap()) {
    if (out.length >= 3) break;
    if (e.rx.test(text)) push(e.symbol);
  }

  // 3. the ticker itself, but only where the headline writes it in capitals.
  //    "Reliance" is caught by pass 2; "RELIANCE" is also caught here, and a
  //    ticker that is also an English word (IDEA, YES) is skipped unless it is
  //    the only thing on the line — the page would rather show nothing than
  //    point at the wrong stock.
  const raw = String(title || '');
  for (const sym of corpusSymbols()) {
    if (out.length >= 3) break;
    if (sym.length < 3 || COMMON_WORDS.has(sym)) continue;
    const rx = new RegExp('(^|[^A-Za-z0-9&])' + re(sym) + '($|[^A-Za-z0-9&])');
    if (rx.test(raw) || rx.test(String(desc || ''))) push(sym);
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------
function itemId(date, title) {
  const norm = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 120);
  return crypto.createHash('sha1').update(date + '|' + norm).digest('hex').slice(0, 16);
}

// Google News RSS gives a Date header; historical items come back as 08:00 GMT,
// which is Google's placeholder, not a market time. We keep the ms but call the
// item's day authoritative.
function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalize(raw, query) {
  const publishedMs = Number(raw.publishedMs) || Date.parse(raw.published || '') || 0;
  if (!publishedMs) return null;
  const date = dayOf(publishedMs);
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 12) return null;
  const desc = String(raw.desc || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const text = title + ' ' + desc;
  return {
    id: itemId(date, title),
    title,
    desc,
    url: String(raw.url || '').slice(0, 600),
    source: String(raw.source || 'google-news').slice(0, 60),
    published: new Date(publishedMs).toISOString(),
    date,
    ts: publishedMs,
    category: raw.category || categoryOf(text),
    direction: directionOf(text),
    symbols: raw.symbols || tagSymbols(title, desc),
    query: String(query || '').slice(0, 120),
    harvestedAt: new Date().toISOString(),
  };
}

function readItems() {
  if (!fs.existsSync(FILES.items)) return [];
  const lines = fs.readFileSync(FILES.items, 'utf8').split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* a half-written line is skipped, not fatal */ }
  }
  return out;
}

function appendItems(items) {
  ensureDir();
  const existing = new Set();
  if (fs.existsSync(FILES.items)) {
    for (const line of fs.readFileSync(FILES.items, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/"id":"([0-9a-f]+)"/);
      if (m) existing.add(m[1]);
    }
  }
  const fresh = [];
  for (const it of items) {
    if (!it || existing.has(it.id)) continue;
    existing.add(it.id);
    fresh.push(it);
  }
  if (fresh.length) {
    fs.appendFileSync(FILES.items, fresh.map((i) => JSON.stringify(i)).join('\n') + '\n', 'utf8');
  }
  return { added: fresh.length, skipped: items.length - fresh.length };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(FILES.state, 'utf8')); } catch (e) { return { cursor: {}, runs: 0 }; }
}

function writeState(s) {
  ensureDir();
  fs.writeFileSync(FILES.state, JSON.stringify(s, null, 1), 'utf8');
}

function readReaction() {
  try { return JSON.parse(fs.readFileSync(FILES.reaction, 'utf8')); } catch (e) { return null; }
}

// A compact summary the page header and the API both use.
function summarize(items) {
  const byCategory = {};
  for (const c of CATEGORIES) byCategory[c.id] = 0;
  byCategory.other = 0;
  const byDay = {};
  let tagged = 0;
  let minDate = null;
  let maxDate = null;
  for (const it of items) {
    byCategory[it.category] = (byCategory[it.category] || 0) + 1;
    byDay[it.date] = (byDay[it.date] || 0) + 1;
    if (it.symbols && it.symbols.length) tagged++;
    if (!minDate || it.date < minDate) minDate = it.date;
    if (!maxDate || it.date > maxDate) maxDate = it.date;
  }
  return {
    total: items.length,
    tagged,
    byCategory,
    days: Object.keys(byDay).length,
    from: minDate,
    to: maxDate,
  };
}

module.exports = {
  DIR, FILES,
  CATEGORIES, CATEGORY_BY_ID,
  categoryOf, directionOf, tagSymbols, normalize,
  itemId, dayOf,
  readItems, appendItems, readState, writeState, readReaction, summarize,
  corpusSymbols,
};

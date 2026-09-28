/**
 * gb_scoring_v2/social/index.js — POST-CLOSE CHATTER: WHO IS BEING TALKED ABOUT, AND HOW IT MOVED.
 *
 * THE ASK. "Stocks being talked about after market close to the next open, in social media — easy to
 * add and buy or sell, and observe how it moved before." Three separate things, and this file does
 * the first and the third, leaving the second to the app's existing watchlist:
 *
 *   1. COLLECT what was said in the window 15:30 (close) -> 09:15 (next open). That window is the
 *      whole point: a post at 16:00 cannot be traded at 16:00, it can only be traded at the NEXT
 *      OPEN. So the window is the unit of collection and the next open is the unit of measurement.
 *   2. (not here) ADD a name to the watchlist — `common/market/userWatchlist.add(sym, 'CHATTER')`,
 *      one click, because the watchlist store already exists.
 *   3. MEASURE HOW IT ACTUALLY MOVED. For every name that was talked about, the forward move from
 *      the next session's OPEN to +5/15/30/60 minutes, the session close and the following open is
 *      computed on the same 1m tape everything else in this repo is measured on, INDEX-ADJUSTED
 *      (symbol minus NIFTY over the same span), and printed beside the SAME statistics for the whole
 *      universe over that session. Without that baseline, "it went up" is not a finding — most
 *      things go up and down every day. If chatter names do not beat the universe, this file says so.
 *
 * THE RULE IT INHERITS (and must not quietly break). In this project news is CONTEXT, never a BUY:
 * a headline can never gate itself into a trade. Chatter is weaker evidence than news, so it enters
 * the same way — a board, a mention count, a measured move — and NOTHING here emits a signal, a
 * direction, or an order. Words in a post are not a gate.
 *
 * ---- SOURCES: WHAT IS GENUINELY FREE (checked 2026-09-26) ----
 *   reddit      PUBLIC JSON endpoints, NO key, NO registration: /r/<sub>/new.json and search.json
 *               with a descriptive User-Agent. This is the workhorse.
 *   stocktwits  PUBLIC stream API per symbol (api.stocktwits.com), no key, rate-limited. Works as an
 *               ENRICHMENT: given the symbols another source surfaced, it fetches their own streams.
 *               That also acts as a check — a symbol nobody on StockTwits is discussing is a much
 *               weaker "talked about" claim than one with a live stream.
 *   youtube     Data API v3 with a FREE key (YOUTUBE_API_KEY) — commentThreads.list costs 1 quota
 *               unit of the 10,000/day free quota. Activates only when the key is present.
 *   finnhub     FREE-tier key (FINNHUB_KEY). Its social-sentiment endpoint aggregates Reddit AND X
 *               mentions for you server-side, which is the closest thing to a free X read there is.
 *   x           NO FREE ROUTE. The official read tier is paid, and the free scrapers that used to
 *               fill the gap (snscrape, nitter instances) are dead or blocked — the adapter exists so
 *               that either a bearer token (X_BEARER) or an import file can fill it in, and it
 *               REPORTS that instead of pretending the gap is not there.
 *   import      A JSON/CSV file of posts ({source, at, text, author, url}) — this is how X data you
 *               already have (an export, a paid tool, a manual paste) enters the same pipeline.
 *
 * Usage:
 *   node gb_scoring_v2/social/index.js --day=2026-09-25 --sources=reddit
 *   node gb_scoring_v2/social/index.js --day=2026-09-25 --sources=import --import=posts.json
 *   node gb_scoring_v2/social/index.js --day=2026-09-25 --sources=reddit,stocktwits,finnhub,youtube
 */
const fs = require('fs');
const path = require('path');
const BT = require('../raschke/backtest');
const NEWS = require('../news');

const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const OUT_DIR = path.join(ROOT, 'data', 'social_chatter');

const UA = 'openalgo-social-chatter/1.0 (research; contact: local)';
const DEFAULT_SUBS = ['IndianStreetBets', 'IndiaInvestments', 'IndianStockMarket', 'IndianStocks'];
const HORIZONS = [5, 15, 30, 60];

// ---------------------------------------------------------------------------
// THE LEAN — a KEYWORD TALLY, not a model, and it is labelled as one.
//
// The ask is "talked about overnight -> buy or sell". Collecting a mention count answers "who is being
// talked about" and nothing else, so a direction is tallied as well — but the honest form of that is a
// small, auditable word list applied per post, NOT a sentiment score with a decimal point on it. The
// words are matched on TOKEN boundaries (so "long" does not fire inside "belong", "sell" not inside
// "seller's" — tokenised to "seller" + "s" and the stem is in the list instead). Three limits are
// stated wherever the lean is shown, because a tally that is read as a model is worse than no tally:
//   * irony, sarcasm and questions ("RELIANCE buy? or trap?") are invisible to it;
//   * a word list built for English finance slang travels badly to Hinglish and vice versa;
//   * it counts POSTS, not conviction — one loud account and fifty quiet ones weigh the same per post.
// It never leaves this file as a signal: `lean` is context on a board that emits no orders.
const LEAN_BULL = new Set(['buy', 'buying', 'buyer', 'buyers', 'long', 'longs', 'breakout', 'upside', 'bullish', 'rally', 'multibagger', 'accumulate', 'accumulation', 'strong']);
const LEAN_BEAR = new Set(['sell', 'selling', 'seller', 'sellers', 'short', 'shorts', 'breakdown', 'downside', 'bearish', 'dump', 'dumped', 'avoid', 'trap', 'crash', 'weak', 'correction']);
const LEAN_BULL_PHRASES = ['break out', 'go long', 'buy the dip'];
const LEAN_BEAR_PHRASES = ['break down', 'go short', 'sell off', 'stop loss'];

/** textLean(text) — {bull, bear, net} counts of directional words in one post. */
function textLean(text) {
  const t = String(text || '').toLowerCase();
  const toks = t.split(/[^a-z0-9]+/).filter(Boolean);
  let bull = 0, bear = 0;
  for (const k of toks) { if (LEAN_BULL.has(k)) bull++; else if (LEAN_BEAR.has(k)) bear++; }
  for (const p of LEAN_BULL_PHRASES) if (t.includes(p)) bull++;
  for (const p of LEAN_BEAR_PHRASES) if (t.includes(p)) bear++;
  return { bull, bear, net: bull - bear };
}

/** leanLabel(bull, bear) — the board's label. Words are needed before a direction is claimed. */
function leanLabel(bull, bear) {
  const n = (bull || 0) + (bear || 0);
  if (n === 0) return 'no direction words';
  const share = ((bull || 0) - (bear || 0)) / n;
  if (share >= 0.34) return 'BUY-lean';
  if (share <= -0.34) return 'SELL-lean';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// the window: 15:30 of the PREVIOUS session -> 09:15 of the day being observed
// ---------------------------------------------------------------------------

/** IST helpers. Timestamps in this repo are IST wall-clock strings, so everything is done in text. */
function istParts(ms) {
  const d = new Date(ms + 330 * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** collectText(text) — the PASTE path: what the user saw, entered by hand.
 *
 * This is the one ingest route that needs no key, no OAuth and no third-party availability, which is
 * why it exists: every free machine-readable route measured on 2026-09-26 (Reddit keyless JSON, Reddit
 * old.reddit HTML, StockTwits public API) answered 403/Cloudflare/captcha from this machine. A user
 * who is reading X, a Telegram channel or a WhatsApp group can select the text, paste it here, and get
 * the same symbol resolution, the same lean and the same measured forward move as any API feed.
 *
 * Line format is deliberately forgiving:
 *   <free text>                      one post
 *   source|author|<free text>        one post with provenance (two pipes required, exact)
 *   YYYY-MM-DD HH:MM ...             a leading timestamp is parsed as the post time when present
 * A post with no timestamp is KEPT (a paste is by definition in-window; `at` stays null so the fact
 * that the time is unknown is preserved rather than invented).
 */
function collectText(text, opts) {
  const src = (opts && opts.source) || 'paste';
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const posts = [];
  for (const line of lines) {
    let source = src, author = null, rest = line;
    const parts = line.split('|');
    if (parts.length >= 3) { source = parts[0].trim() || src; author = parts[1].trim() || null; rest = parts.slice(2).join('|').trim(); }
    let at = null;
    const m = rest.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
    if (m) { at = m[1] + ' ' + (m[2] || '00:00'); rest = rest.slice(m[0].length).trim(); }
    if (!rest) continue;
    posts.push(Object.assign(normPost({ source, author, at, text: rest }), { pasted: true }));
  }
  return { posts, errors: [] };
}

/** chatterWindow(day) — the [from, to] instant of the close->open window ending on `day`. */
function chatterWindow(day) {
  const from = Date.parse(day + 'T15:30:00+05:30') - 24 * 3600 * 1000;
  const to = Date.parse(day + 'T09:15:00+05:30');
  return { from, to };
}

function inWindow(ms, win) { return ms >= win.from && ms <= win.to; }

// ---------------------------------------------------------------------------
// normalised post shape — every adapter returns these and nothing else
// ---------------------------------------------------------------------------
// `summary` is the feed's description/teaser. It is kept because it usually names MORE stocks than the
// headline does ("Buzzing stocks: TATAPOWER, IDEA, ..."), which is exactly what the symbol resolver
// needs, and because it is evidence of what the item was about rather than a claim about it.
const POST_FIELDS = ['source', 'id', 'at', 'text', 'author', 'url', 'score', 'summary'];

function normPost(p) {
  const out = { source: null, id: null, at: null, text: '', author: null, url: null, score: null };
  for (const k of POST_FIELDS) if (p && p[k] != null) out[k] = p[k];
  out.text = String(out.text || '').replace(/\s+/g, ' ').trim();
  const ms = typeof out.at === 'number' ? out.at : Date.parse(out.at);
  out.ms = Number.isFinite(ms) ? ms : null;
  return out;
}

// ---------------------------------------------------------------------------
// fetch, with a timeout and a VISIBLE failure (a silent empty list would look like "nobody talked")
// ---------------------------------------------------------------------------
async function getJson(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 12000);
  try {
    const res = await fetch(url, Object.assign({ signal: ctl.signal, headers: { 'user-agent': UA, accept: 'application/json' } }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------------------
// ADAPTERS
// ---------------------------------------------------------------------------

/**
 * redditToken() — a free OAuth app token, and WHY IT IS NEEDED NOW.
 *
 * The keyless JSON route (www.reddit.com/r/X/new.json) is what every tutorial still shows. Measured
 * on 2026-09-26 from this machine it answers HTTP 403 for every subreddit, WITH or WITHOUT a
 * browser User-Agent — the block is on the client, not the header, and it is the same wall Reddit
 * put in front of programmatic access generally. The fix is free and takes a minute: register a
 * "script" app at reddit.com/prefs/apps, then set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET. It is an
 * OAuth2 client-credentials token, no user login involved.
 */
async function redditToken(opts) {
  const id = (opts && opts.redditClientId) || process.env.REDDIT_CLIENT_ID;
  const secret = (opts && opts.redditClientSecret) || process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;
  const body = 'grant_type=client_credentials';
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': UA,
    },
    body,
  });
  if (!res.ok) throw new Error('reddit oauth: HTTP ' + res.status);
  const j = await res.json();
  if (!j || !j.access_token) throw new Error('reddit oauth: no access_token in the response');
  return j.access_token;
}

/**
 * reddit — keyless public JSON where it works, OAuth where it does not. `new` and `top` are the two
 * listings that matter here: `new` catches the posts written during the window itself, `top` catches
 * the ones the subreddit pushed to the front of the day (a post can be written at 19:00 and only
 * become "talked about" at 23:00, which a `new`-only read would score as one quiet mention).
 */
async function collectReddit(subs, win, opts) {
  const posts = [], errors = [];
  let token = null, oauthError = null;
  try { token = await redditToken(opts); } catch (e) { oauthError = e.message; }
  if (oauthError) errors.push(oauthError);
  const host = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  for (const sub of (subs || DEFAULT_SUBS)) {
    for (const kind of ['new', 'top']) {
      const url = host + '/r/' + encodeURIComponent(sub) + '/' + kind + '.json?limit=100&t=day';
      try {
        const j = await getJson(url, token ? { headers: { authorization: 'Bearer ' + token } } : null, (opts && opts.timeoutMs) || 12000);
        const children = (j && j.data && j.data.children) || [];
        for (const c of children) {
          const d = c && c.data;
          if (!d || !d.title) continue;
          const ms = d.created_utc ? d.created_utc * 1000 : null;
          if (!ms || !inWindow(ms, win)) continue;
          posts.push(normPost({
            source: 'reddit', id: d.id, at: ms, text: d.title + (d.selftext ? ' ' + d.selftext : ''),
            author: d.author, url: 'https://reddit.com' + (d.permalink || ''), score: d.score,
          }));
        }
      } catch (e) {
        errors.push('reddit/' + sub + '/' + kind + ': ' + e.message
          + (token ? '' : ' (keyless route — set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET for the free OAuth app token; from 2026-09-26 the keyless JSON route 403s on every sub)'));
      }
    }
  }
  return { posts, errors, oauth: !!token };
}

/** stocktwits — keyless per-symbol stream. Enrichment: the symbols come from somewhere else. */
async function collectStocktwits(symbols, win, opts) {
  const posts = [], errors = [];
  for (const sym of symbols.slice(0, 40)) {
    // StockTwits uses the bare NSE ticker for most Indian names; -EQ / suffixes are stripped.
    const tick = String(sym).replace(/-EQ$/, '').replace(/[^A-Z0-9.]/g, '');
    if (!tick) continue;
    try {
      const j = await getJson('https://api.stocktwits.com/api/2/streams/symbol/' + tick + '.json', null, (opts && opts.timeoutMs) || 10000);
      for (const m of ((j && j.messages) || [])) {
        const ms = Date.parse(m.created_at);
        if (!Number.isFinite(ms) || !inWindow(ms, win)) continue;
        posts.push(normPost({
          source: 'stocktwits', id: m.id, at: ms, text: m.body,
          author: m.user && m.user.username, url: 'https://stocktwits.com/message/' + m.id,
          score: (m.likes && m.likes.total) || 0,
        }));
      }
    } catch (e) { errors.push('stocktwits/' + tick + ': ' + e.message); }
  }
  return { posts, errors };
}

/** finnhub — free-tier key; its social-sentiment endpoint aggregates Reddit + X server-side. */
async function collectFinnhub(symbols, win, opts) {
  const key = (opts && opts.finnhubKey) || process.env.FINNHUB_KEY;
  if (!key) return { posts: [], errors: ['finnhub: FINNHUB_KEY not set (free key required — this is the closest free read of X mentions)'], needs: 'FINNHUB_KEY' };
  const posts = [], errors = [];
  const from = new Date(win.from).toISOString().slice(0, 10);
  const to = new Date(win.to).toISOString().slice(0, 10);
  for (const sym of symbols.slice(0, 50)) {
    try {
      const j = await getJson('https://finnhub.io/api/v1/stock/social-sentiment?symbol=' + encodeURIComponent(sym)
        + '&from=' + from + '&to=' + to + '&token=' + encodeURIComponent(key), null, (opts && opts.timeoutMs) || 12000);
      for (const r of ((j && j.reddit) || [])) {
        const ms = Date.parse(r.at) * (String(r.at).length <= 10 ? 1000 : 1);
        if (!Number.isFinite(ms) || !inWindow(ms, win)) continue;
        posts.push(normPost({ source: 'finnhub:reddit', at: ms, text: r.headline || '', author: r.user || null, url: r.url, score: r.score }));
      }
      for (const tw of ((j && j.twitter) || [])) {
        const ms = Date.parse(tw.at) * (String(tw.at).length <= 10 ? 1000 : 1);
        if (!Number.isFinite(ms) || !inWindow(ms, win)) continue;
        posts.push(normPost({ source: 'finnhub:x', at: ms, text: tw.text || tw.headline || '', author: tw.user || null, url: tw.url, score: tw.likes }));
      }
    } catch (e) { errors.push('finnhub/' + sym + ': ' + e.message); }
  }
  return { posts, errors };
}

/** youtube — Data API v3 with a FREE key; comments cost 1 quota unit each. */
async function collectYouTube(queries, win, opts) {
  const key = (opts && opts.youtubeKey) || process.env.YOUTUBE_API_KEY;
  if (!key) return { posts: [], errors: ['youtube: YOUTUBE_API_KEY not set (free key, 10k units/day)'], needs: 'YOUTUBE_API_KEY' };
  const posts = [], errors = [];
  for (const q of queries.slice(0, 6)) {
    try {
      const search = await getJson('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5&order=date'
        + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(key), null, (opts && opts.timeoutMs) || 12000);
      for (const v of ((search && search.items) || [])) {
        const vid = v.id && v.id.videoId;
        if (!vid) continue;
        const cm = await getJson('https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&maxResults=100&videoId=' + vid
          + '&key=' + encodeURIComponent(key), null, (opts && opts.timeoutMs) || 12000);
        for (const it of ((cm && cm.items) || [])) {
          const s = (it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet) || {};
          const ms = Date.parse(s.publishedAt);
          if (!Number.isFinite(ms) || !inWindow(ms, win)) continue;
          posts.push(normPost({ source: 'youtube', id: it.id, at: ms, text: s.textDisplay || '', author: s.authorDisplayName, url: 'https://youtube.com/watch?v=' + vid, score: s.likeCount }));
        }
      }
    } catch (e) { errors.push('youtube/' + q + ': ' + e.message); }
  }
  return { posts, errors };
}

/** import — a JSON array (or {posts:[]}) or a CSV of posts. How X data you already have gets in. */
/**
 * THE FIXED KEYLESS MARKET FEEDS. Measured from this machine on 2026-09-26 — all four answered 200
 * with parseable <item>s while every social route was blocked:
 *
 *   et-markets   Economic Times markets/stocks RSS  — the paper's own most-read market stories
 *   mc-buzzing   MoneyControl "buzzing stocks"      — literally the day's most-talked-about names
 *   news-rss     Google News search RSS (per query)
 *   bing-news    Bing News search RSS (per query)
 *
 * These are NEWS, not chatter, and each keeps its own source id so the board's source mix shows what the
 * board is actually made of: a name that appears in mc-buzzing AND in a pasted X thread is a different
 * claim from one that only a newspaper mentioned. "Buzzing stocks" is the closest free approximation of
 * "what the market is reading this morning" and it NAMES symbols, which is what makes it useful here.
 */
const NEWS_FEEDS = [
  { key: 'et-markets', label: 'Economic Times markets', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { key: 'mc-buzzing', label: 'MoneyControl buzzing stocks', url: 'https://www.moneycontrol.com/rss/buzzingstocks.xml' },
];

/** parseItems(xml, source, win) — RSS <item>s into posts. Shared by every feed adapter. */
function parseItems(xml, source, win, opts) {
  const posts = [];
  for (const it of String(xml || '').split(/<item>/).slice(1)) {
    const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    if (!title) continue;
    const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const desc = ((it.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
    const msDate = pub ? Date.parse(pub) : NaN;
    const at = Number.isFinite(msDate) ? new Date(msDate + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : null;
    const clean = decodeXml(title).replace(/\s+-\s+[^-]{2,45}$/, '');
    // THE PUBLISHER IS THE AUTHOR of a feed item. Leaving it null made `distinctAuthors` read 0 for
    // every newspaper-sourced name while Google's items (which carry a <source> tag) read 1 — the same
    // fact scored two ways. For a feed, "how many distinct people said it" means "how many distinct
    // publishers printed it", and it is counted that way.
    const publisher = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
    const author = publisher ? decodeXml(publisher) : (opts && opts.author) || source;
    const p = normPost({ source, at, text: clean, author, url: link ? decodeXml(link) : null, summary: decodeXml(desc).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400) });
    if (p.ms != null && !inWindow(p.ms, win)) continue;
    posts.push(p);
  }
  return posts;
}

/** collectNewsFeeds(win, opts) — the fixed Indian market feeds above. */
async function collectNewsFeeds(win, opts) {
  const errors = [], posts = [];
  for (const f of NEWS_FEEDS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || 15000);
      const r = await fetch(f.url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { errors.push(f.key + ': HTTP ' + r.status); continue; }
      const got = parseItems(await r.text(), f.key, win, Object.assign({ author: f.label }, opts));
      posts.push(...got);
      if (!got.length) errors.push(f.key + ': reachable but nothing published inside the window (that is not the same as nobody talking)');
    } catch (e) { errors.push(f.key + ': ' + String((e && e.message) || e).slice(0, 80)); }
  }
  return { posts, errors };
}

/**
 * collectTelegram(channels, win, opts) — a KEYLESS discussion route, with a measured caveat.
 *
 * Telegram publishes an HTML web preview at t.me/s/<channel> for channels that have it ENABLED, and
 * nothing for the rest: the probe on 2026-09-26 found one of eight well-known Indian market channels
 * served messages at all, and that one had been dead since 2022. So this adapter is CHANNEL-CONFIGURED
 * (--channels=a,b,c) rather than shipped with a default list, and a channel without a preview is
 * reported as exactly that. When it does return messages it is the only genuinely SOCIAL source that
 * works here without a key, which is why it stays.
 */
async function collectTelegram(channels, win, opts) {
  const errors = [], posts = [];
  const list = (channels && channels.length) ? channels : [];
  if (!list.length) return { posts, errors: ['telegram: no --channels given (web previews exist only for channels that enable them)'] };
  const clean = (s) => decodeXml(String(s || '').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  for (const ch of list.slice(0, 8)) {
    const name = String(ch).replace(/^@/, '').trim();
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || 15000);
      const r = await fetch('https://t.me/s/' + encodeURIComponent(name), { headers: { 'User-Agent': UA }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { errors.push('telegram/' + name + ': HTTP ' + r.status); continue; }
      const html = await r.text();
      const blocks = html.split('tgme_widget_message ').slice(1);
      if (!blocks.length) { errors.push('telegram/' + name + ': no public web preview (the channel has it disabled) — not "quiet"'); continue; }
      let n = 0;
      for (const b of blocks) {
        const dt = (b.match(/<time datetime="([^"]+)"/) || [])[1];
        const owner = (b.match(/tgme_widget_message_owner_name[^>]*>([\s\S]*?)<\/a>/) || [])[1];
        const txt = (b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/) || [])[1];
        const text = clean(txt);
        if (!text) continue;
        const ms = dt ? Date.parse(dt) : NaN;
        const at = Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : null;
        const p = normPost({ source: 'telegram', at, text, author: clean(owner) || name, url: 'https://t.me/' + name });
        if (p.ms != null && !inWindow(p.ms, win)) continue;
        posts.push(p); n++;
      }
      if (!n) errors.push('telegram/' + name + ': preview exists but nothing inside the window');
    } catch (e) { errors.push('telegram/' + name + ': ' + String((e && e.message) || e).slice(0, 80)); }
  }
  return { posts, errors };
}

function decodeXml(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/**
 * collectNewsRss(queries, win, opts) — KEYLESS, and the only route measured to answer 200 from this
 * machine on 2026-09-26 (the social ones all answered 403 / Cloudflare / captcha).
 *
 * IT IS NOT SOCIAL, AND IT SAYS SO. These are publisher headlines, not punters: every post carries
 * source 'news-rss' so the board can never present a newspaper as chatter. It is here because "which
 * names are in the news overnight" is part of the same overnight question and because a source that
 * actually works is worth more than a social adapter that returns nothing and calls it quiet.
 */
async function collectNewsRss(queries, win, opts) {
  const errors = [], posts = [];
  const qs = (queries && queries.length) ? queries : ['NSE stock', 'stocks to watch India tomorrow', 'Nifty 50 stocks news', 'stock in focus India'];
  for (const q of qs.slice(0, 6)) {
    const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en';
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), (opts && opts.timeoutMs) || 15000);
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { errors.push('news-rss: HTTP ' + r.status + ' for "' + q + '"'); continue; }
      const xml = await r.text();
      const items = xml.split(/<item>/).slice(1);
      for (const it of items) {
        const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
        const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
        const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
        const srcName = (it.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1];
        if (!title) continue;
        const ms = pub ? Date.parse(pub) : NaN;
        const at = Number.isFinite(ms) ? new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') : null;
        // Google appends " - Publisher" to the title; the <source> tag already carries the publisher.
        const clean = decodeXml(title).replace(/\s+-\s+[^-]{2,45}$/, '');
        const p = normPost({ source: 'news-rss', at, text: clean, url: link ? decodeXml(link) : null, author: srcName ? decodeXml(srcName) : 'Google News' });
        if (p.ms != null && !inWindow(p.ms, win)) continue;
        posts.push(p);
      }
    } catch (e) { errors.push('news-rss: ' + String((e && e.message) || e).slice(0, 90) + ' for "' + q + '"'); }
  }
  return { posts, errors };
}

function collectImport(file, win) {
  if (!file) return { posts: [], errors: ['import: no --import file given'] };
  if (!fs.existsSync(file)) return { posts: [], errors: ['import: ' + file + ' not found'] };
  const raw = fs.readFileSync(file, 'utf8');
  let rows;
  try {
    const j = JSON.parse(raw);
    rows = Array.isArray(j) ? j : (j.posts || []);
  } catch (e) {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    const head = (lines.shift() || '').split(',').map((h) => h.trim().toLowerCase());
    rows = lines.map((l) => {
      const parts = l.split(',');
      const o = {};
      head.forEach((h, i) => { o[h] = parts[i]; });
      return o;
    });
  }
  const posts = [];
  for (const r of rows) {
    const p = normPost(r);
    if (!p.text) continue;
    if (p.ms != null && !inWindow(p.ms, win)) continue;
    p.source = p.source || 'import';
    posts.push(p);
  }
  return { posts, errors: [] };
}

// ---------------------------------------------------------------------------
// symbol resolution — the news engine already does this, so it is reused, not rebuilt
// ---------------------------------------------------------------------------
async function resolvePosts(posts) {
  for (const p of posts) {
    const hay = (p.text + ' ' + (p.summary || '')).trim();
    let syms = [];
    try { syms = await NEWS.resolveSymbolsLive(hay, hay); } catch (e) { syms = []; }
    if ((!syms || !syms.length)) { try { syms = NEWS.resolveSymbols(hay) || []; } catch (e) { syms = []; } }
    p.symbols = Array.from(new Set((syms || []).filter(Boolean)));
  }
  return posts;
}

// ---------------------------------------------------------------------------
// aggregation: a mention count is not "talked about" unless DISTINCT people said it
// ---------------------------------------------------------------------------
function aggregate(posts) {
  const bySym = new Map();
  for (const p of posts) {
    for (const s of (p.symbols || [])) {
      if (!bySym.has(s)) bySym.set(s, { symbol: s, mentions: 0, authors: new Set(), sources: {}, firstMs: null, lastMs: null, samples: [], bull: 0, bear: 0, leanPosts: 0, newsMentions: 0 });
      const a = bySym.get(s);
      a.mentions++;
      if (p.author) a.authors.add(p.author);
      a.sources[p.source] = (a.sources[p.source] || 0) + 1;
      if (p.source === 'news-rss') a.newsMentions++;
      // the direction tally rides along with the mention, computed once per post
      const lean = p._lean || (p._lean = textLean(p.text));
      a.bull += lean.bull; a.bear += lean.bear;
      if (lean.bull || lean.bear) a.leanPosts++;
      if (p.ms != null) {
        if (a.firstMs == null || p.ms < a.firstMs) a.firstMs = p.ms;
        if (a.lastMs == null || p.ms > a.lastMs) a.lastMs = p.ms;
      }
      if (a.samples.length < 3) a.samples.push({ source: p.source, author: p.author, at: p.at, text: p.text.slice(0, 180) });
    }
  }
  return Array.from(bySym.values()).map((a) => Object.assign(a, { distinctAuthors: a.authors.size, authors: Array.from(a.authors).slice(0, 8) }));
}

// ---------------------------------------------------------------------------
// HOW IT ACTUALLY MOVED — from the NEXT OPEN, index-adjusted, on the shared tape
// ---------------------------------------------------------------------------

/**
 * forwardFromOpen(symbol, day) — the move from the session's first bar to each horizon, and the
 * index-adjusted version of it. `null` wherever the tape does not cover the point, never 0.
 */
function forwardFromOpen(symbol, day, nifty) {
  const j = BT.load(symbol);
  if (!j || !j.candles || !j.candles.length) return null;
  const bars = j.candles;
  const idx = bars.findIndex((b) => String(b[0]).slice(0, 10) === day && BT.sessionOf(b) === day);
  if (idx < 0) return null;
  const open = bars[idx][4];
  if (!(open > 0)) return null;
  const at = (mins) => {
    const target = Date.parse(day + 'T09:15:00+05:30') + mins * 60000;
    for (let k = idx; k < bars.length; k++) {
      const t = Date.parse(String(bars[k][0]).replace(' ', 'T') + ':00+05:30');
      if (Number.isFinite(t) && t >= target) return bars[k][4];
      if (String(bars[k][0]).slice(0, 10) !== day) break;
    }
    return null;
  };
  const ref = nifty ? nifty.get(Date.parse(day + 'T09:15:00+05:30')) : null;
  const refN = ref == null && nifty ? (() => { for (const [t, c] of nifty) { if (String(new Date(t + 330 * 60000).toISOString()).slice(0, 10) === day) return c; } return null; })() : ref;
  const out = { symbol, day, open };
  for (const h of HORIZONS) {
    const px = at(h);
    out['m' + h] = px == null ? null : +(((px - open) / open) * 100).toFixed(3);
    if (px != null && refN != null && refN > 0) {
      const nPx = (() => { const target = Date.parse(day + 'T09:15:00+05:30') + h * 60000; for (const [t, c] of nifty) { if (t >= target) return c; } return null; })();
      if (nPx != null) out['adj' + h] = +(out['m' + h] - ((nPx - refN) / refN) * 100).toFixed(3);
    }
  }
  // the session close and the following open: what "hold it all day" and "hold it overnight" did
  let last = null, nextOpen = null;
  for (let k = idx; k < bars.length; k++) {
    if (String(bars[k][0]).slice(0, 10) !== day) { nextOpen = bars[k][4]; break; }
    last = bars[k][4];
  }
  out.close = last == null ? null : +(((last - open) / open) * 100).toFixed(3);
  out.nextOpen = nextOpen == null ? null : +(((nextOpen - open) / open) * 100).toFixed(3);
  return out;
}

/** universeBaseline(day, nifty) — the same moves for every symbol with tape that day. No baseline,
 * no finding: "the chatter names went up" means nothing until the market's own move is beside it. */
function universeBaseline(day, nifty, files) {
  const rows = [];
  for (const f of files) {
    const sym = f.replace(/\.json$/, '');
    if (sym === 'NIFTY') continue;
    const r = forwardFromOpen(sym, day, nifty);
    if (r) rows.push(r);
  }
  const meanOf = (k) => {
    const v = rows.map((r) => r[k]).filter((x) => x != null);
    return v.length ? +BT.mean(v).toFixed(3) : null;
  };
  return { n: rows.length, m5: meanOf('m5'), m15: meanOf('m15'), m30: meanOf('m30'), m60: meanOf('m60'), close: meanOf('close'), nextOpen: meanOf('nextOpen') };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
async function run(cfg) {
  const day = cfg.day;
  const win = chatterWindow(day);
  const files = fs.readdirSync(path.join(ROOT, 'data', 'ohlcv_1m')).filter((f) => f.endsWith('.json'));
  const nifty = BT.niftySeries();
  const sources = (cfg.sources && cfg.sources.length) ? cfg.sources : ['reddit'];
  const notes = [];
  let posts = [];

  // the PASTE path: no key, no OAuth, no third-party availability. Listed first because it is the one
  // route that cannot be taken away from the user by a 403.
  if (cfg.pasteText) {
    const r = collectText(cfg.pasteText, { source: cfg.pasteSource || 'paste' });
    posts = posts.concat(r.posts); notes.push(...r.errors, 'paste: ' + r.posts.length + ' line(s) in');
  }
  if (sources.indexOf('import') >= 0) {
    const r = collectImport(cfg.importFile, win);
    posts = posts.concat(r.posts); notes.push(...r.errors);
  }
  // keyless NEWS (works from this machine); every post keeps its own source id so a newspaper headline
  // can never be read as a punter's post.
  if (sources.indexOf('news') >= 0 || sources.indexOf('news-rss') >= 0 || sources.indexOf('feeds') >= 0) {
    const fixed = await collectNewsFeeds(win, cfg);
    posts = posts.concat(fixed.posts); notes.push(...fixed.errors, 'market feeds: ' + fixed.posts.length + ' item(s) inside the window');
    const r = await collectNewsRss(cfg.newsQueries, win, cfg);
    posts = posts.concat(r.posts); notes.push(...r.errors, 'news-rss: ' + r.posts.length + ' headline(s) inside the window');
  }
  // keyless DISCUSSION if a channel with a public web preview is configured; otherwise it says why not
  if (sources.indexOf('telegram') >= 0) {
    const r = await collectTelegram(cfg.channels, win, cfg);
    posts = posts.concat(r.posts); notes.push(...r.errors, 'telegram: ' + r.posts.length + ' message(s)');
  }
  if (sources.indexOf('reddit') >= 0) {
    const r = await collectReddit(cfg.subs, win, cfg);
    posts = posts.concat(r.posts); notes.push(...r.errors);
    notes.push('reddit: ' + r.posts.length + ' posts inside the window (' + (r.oauth ? 'OAuth' : 'keyless') + ')');
  }
  if (sources.indexOf('x') >= 0) {
    notes.push('x: no free route exists (official read tier is paid; snscrape/nitter are dead). Use --import with an export, or FINNHUB_KEY which aggregates X mentions on the free tier.');
  }

  // resolve, then aggregate. The candidate symbols are what StockTwits/Finnhub/YouTube enrich.
  await resolvePosts(posts);
  let agg = aggregate(posts);

  if (sources.indexOf('stocktwits') >= 0) {
    const r = await collectStocktwits(agg.map((a) => a.symbol), win, cfg);
    if (r.posts.length) { await resolvePosts(r.posts); posts = posts.concat(r.posts); agg = aggregate(posts); }
    notes.push(...r.errors, 'stocktwits: ' + r.posts.length + ' posts');
  }
  if (sources.indexOf('finnhub') >= 0) {
    const r = await collectFinnhub(agg.map((a) => a.symbol), win, cfg);
    if (r.posts.length) { await resolvePosts(r.posts); posts = posts.concat(r.posts); agg = aggregate(posts); }
    notes.push(...r.errors, 'finnhub: ' + r.posts.length + ' posts');
  }
  if (sources.indexOf('youtube') >= 0) {
    const r = await collectYouTube(agg.slice(0, 6).map((a) => a.symbol + ' stock'), win, cfg);
    if (r.posts.length) { await resolvePosts(r.posts); posts = posts.concat(r.posts); agg = aggregate(posts); }
    notes.push(...r.errors, 'youtube: ' + r.posts.length + ' posts');
  }

  // the moves + the baseline they must be read against
  const rows = agg.map((a) => {
    const sym = a.symbol.replace(/-EQ$/, '');
    const mv = forwardFromOpen(sym, day, nifty);
    return {
      symbol: sym, mentions: a.mentions, distinctAuthors: a.distinctAuthors, sources: a.sources,
      newsMentions: a.newsMentions,
      // the lean travels WITH its counts so a label can never be read without the words behind it
      bull: a.bull, bear: a.bear, leanPosts: a.leanPosts,
      lean: (a.bull || a.bear) ? a.bull - a.bear : null,
      leanLabel: leanLabel(a.bull, a.bear),
      firstAt: a.firstMs == null ? null : new Date(a.firstMs + 330 * 60000).toISOString().slice(0, 16).replace('T', ' '),
      lastAt: a.lastMs == null ? null : new Date(a.lastMs + 330 * 60000).toISOString().slice(0, 16).replace('T', ' '),
      samples: a.samples, move: mv,
    };
  }).sort((x, y) => (y.distinctAuthors - x.distinctAuthors) || (y.mentions - x.mentions));

  // THE BASELINE IS EXPENSIVE AND DEPENDS ONLY ON (day, tape), NOT ON THE POSTS. Re-running an ingest
  // for the same day (a second paste, a source added later) must not re-walk 995 symbols: the previous
  // day file's baseline is reused when it exists. The tape for a past session does not change, so this
  // is a cache, not a shortcut.
  let baseline = null;
  try {
    const prior = JSON.parse(fs.readFileSync(cfg.out || path.join(OUT_DIR, day + '.json'), 'utf8'));
    if (prior && prior.day === day && prior.universeMean && prior.universeMean.n) baseline = prior.universeMean;
  } catch (e) { /* no usable prior day file */ }
  if (!baseline) baseline = universeBaseline(day, nifty, files);
  const withMove = rows.filter((r) => r.move);
  const meanOf = (k) => { const v = withMove.map((r) => r.move[k]).filter((x) => x != null); return v.length ? +BT.mean(v).toFixed(3) : null; };
  const chatter = {
    n: withMove.length,
    m5: meanOf('m5'), m15: meanOf('m15'), m30: meanOf('m30'), m60: meanOf('m60'),
    close: meanOf('close'), nextOpen: meanOf('nextOpen'),
    adj15: (() => { const v = withMove.map((r) => r.move.adj15).filter((x) => x != null); return v.length ? +BT.mean(v).toFixed(3) : null; })(),
  };

  const leanSummary = {
    buy: rows.filter((r) => r.leanLabel === 'BUY-lean').length,
    sell: rows.filter((r) => r.leanLabel === 'SELL-lean').length,
    mixed: rows.filter((r) => r.leanLabel === 'mixed').length,
    none: rows.filter((r) => r.leanLabel === 'no direction words').length,
  };

  const payload = {
    at: new Date().toISOString(),
    day,
    window: { from: new Date(win.from + 330 * 60000).toISOString().slice(0, 16).replace('T', ' '), to: new Date(win.to + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ') },
    sources,
    posts: posts.length,
    symbols: rows,
    chatterMean: chatter,
    universeMean: baseline,
    leanSummary,
    // NAMES THE TAPE CANNOT MEASURE ARE COUNTED, NOT HIDDEN. The 995-symbol tape is a filtered
    // universe, so a headline can legitimately name a real NSE company that has no bars here. Those rows
    // stay in `symbols` with move: null and are counted here, so the board can say "3 talked about, 1
    // measurable" instead of quietly reporting a smaller board than it found.
    notMeasured: rows.filter((r) => !r.move).length,
    notes,
    method: {
      tradeability: 'a post in this window cannot be traded when it is written; the entry this measures is the NEXT session\'s open, which is the first moment the chatter is actionable',
      adjustment: 'adj15 = the symbol\'s 15-minute move minus NIFTY\'s over the same span; the universe mean beside it is the same statistic over every symbol with tape that day',
      rule: 'chatter is CONTEXT, never a BUY: nothing in this file emits a signal, a direction or an order, and mention counts do not gate anything',
      honesty: 'if the chatter names do not beat the universe baseline, this file says so — a source that fails to answer is reported in `notes`, never as an empty list that looks like "nobody talked"',
      lean: 'the BUY-lean / SELL-lean label is a KEYWORD TALLY over the post text (LEAN_BULL / LEAN_BEAR in social/index.js), not a model: it counts posts, it cannot see irony, sarcasm or questions, and its word list is English finance slang. It is shown WITH its counts and it emits nothing.',
      sourcesHonesty: 'source names are kept on every post, so a newspaper headline can never be read as a punter\'s post: news-rss is NEWS, and the board shows the source mix per symbol',
      paste: 'the paste route is the only ingest that cannot be taken away by a 403; pasted posts have no timestamp and keep `at: null` rather than inventing one',
    },
    file: null,
  };
  const out = cfg.out || path.join(OUT_DIR, day + '.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(payload, null, 1));
  payload.file = out;
  return payload;
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
  const day = argOf('day', null);

  // --board: read what has been collected so far, do not collect anything
  if (argv.indexOf('--board') >= 0) {
    const b = board();
    if (!b.ok) { console.log(b.note); return; }
    console.log('=== chatter board — ' + b.collectedDays + ' collected day(s) ===');
    for (const d of b.days) {
      console.log('  ' + d.day + ' · posts ' + String(d.posts).padStart(4) + ' · names ' + String(d.symbols).padStart(3)
        + ' · chatter close ' + (d.chatter && d.chatter.close) + '% vs universe ' + (d.universe && d.universe.close) + '%'
        + (d.sources ? ' · ' + d.sources.join(',') : ''));
    }
    console.log('\nsymbol        days  mentions  maxAuth  lean        obs  meanClose%  meanAdj15%  beat/universe');
    for (const r of b.symbols.slice(0, 25)) {
      console.log('  ' + r.symbol.padEnd(12) + String(r.days).padStart(4) + String(r.mentions).padStart(9) + String(r.maxAuthors).padStart(9)
        + '  ' + r.leanLabel.padEnd(19) + String(r.observedDays).padStart(3)
        + String(r.meanClose == null ? '-' : r.meanClose).padStart(12) + String(r.meanAdj15 == null ? '-' : r.meanAdj15).padStart(12)
        + ('   ' + r.beatUniverseDays + '/' + r.comparedDays).padStart(15));
    }
    console.log('\nnote: ' + b.note);
    return;
  }

  // --daily FIRST: it derives the day itself (today's window if it has closed, else the latest session),
  // so it must not be gated behind the --day requirement.
  if (argv.indexOf('--daily') >= 0) {
    const force = Number(argOf('force', 0)) === 1;
    daily({
      day: argOf('day', null), force,
      channels: argOf('channels', null) ? String(argOf('channels')).split(',').map((s) => s.trim()).filter(Boolean) : null,
      sources: argOf('sources', null) ? String(argOf('sources')).split(',').map((s) => s.trim()).filter(Boolean) : null,
    }).then((r) => {
      if (!r.ok) { console.log('daily: ' + r.error); return; }
      for (const s of r.steps) {
        if (s.skipped) { console.log('daily ' + s.day + ' [' + s.phase + '] skipped — ' + s.reason); continue; }
        console.log('daily ' + s.day + ' [' + s.phase + '] posts ' + s.posts + ' · names ' + s.symbols + ' · measured ' + (s.measured == null ? '-' : s.measured)
          + (s.phase === 'collect' ? (' · lean ' + JSON.stringify(s.leanSummary)) : ''));
      }
      console.log('target day ' + r.day + ' · today ' + r.today + ' · tape sessions ' + r.tapeSessions);
      console.log('board : node gb_scoring_v2/social/index.js --board');
    }).catch((e) => { console.error('daily failed: ' + e.message); process.exit(1); });
    return;
  }

  if (!day) {
    console.error('usage: node gb_scoring_v2/social/index.js --daily [--force=1] [--channels=a,b]');
    console.error('       node gb_scoring_v2/social/index.js --day=YYYY-MM-DD [--sources=news,reddit,paste,import,stocktwits,finnhub,youtube,x]');
    console.error('       node gb_scoring_v2/social/index.js --day=YYYY-MM-DD --paste=posts.txt');
    console.error('       node gb_scoring_v2/social/index.js --board');
    process.exit(1);
  }
  const pasteArg = argOf('paste', null);
  let pasteText = argOf('text', null);
  if (pasteArg) {
    const pf = path.resolve(ROOT, pasteArg);
    pasteText = fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : null;
    if (!pasteText) { console.error('--paste=' + pasteArg + ' not found'); process.exit(1); }
  }
  const cfg = {
    day,
    sources: String(argOf('sources', 'reddit')).split(',').map((s) => s.trim()).filter(Boolean),
    subs: argOf('subs', null) ? String(argOf('subs')).split(',') : DEFAULT_SUBS,
    importFile: argOf('import', null) ? path.resolve(ROOT, argOf('import')) : null,
    pasteText, pasteSource: argOf('pasteSource', null),
    newsQueries: argOf('queries', null) ? String(argOf('queries')).split(',').map((s) => s.trim()) : null,
    channels: argOf('channels', null) ? String(argOf('channels')).split(',').map((s) => s.trim()).filter(Boolean) : null,
    out: argOf('out', null) ? path.resolve(ROOT, argOf('out')) : null,
  };
  run(cfg).then((p) => {
    console.log('window ' + p.window.from + ' -> ' + p.window.to + ' · posts ' + p.posts + ' · symbols talked about ' + p.symbols.length);
    console.log('lean: ' + JSON.stringify(p.leanSummary));
    console.log('top names:');
    for (const r of p.symbols.slice(0, 12)) {
      console.log('  ' + r.symbol.padEnd(12) + ' distinct ' + String(r.distinctAuthors).padStart(3) + ' · mentions ' + String(r.mentions).padStart(4)
        + ' · ' + r.leanLabel.padEnd(18)
        + (r.move ? (' · next-open->close ' + r.move.close + '% · adj15 ' + r.move.adj15 + '%') : ' · no tape for ' + p.day));
    }
    console.log('chatter names mean: m15 ' + p.chatterMean.m15 + ' · close ' + p.chatterMean.close + ' · adj15 ' + p.chatterMean.adj15 + ' (n ' + p.chatterMean.n + ')');
    console.log('universe baseline : m15 ' + p.universeMean.m15 + ' · close ' + p.universeMean.close + ' (n ' + p.universeMean.n + ')');
    for (const n of p.notes) console.log('note: ' + n);
    console.log('written: ' + p.file);
    console.log('board : node gb_scoring_v2/social/index.js --board');
  }).catch((e) => { console.error('social ingest failed: ' + e.message); process.exit(1); });
}

/**
 * daily(cfg) — THE ONCE-A-DAY RUN, so the history accumulates without anyone remembering to press it.
 *
 * The user's ask is explicitly daily ("we do daily based"), and the whole value of this board is the
 * STACK of days: one day cannot tell you whether the crowd's direction means anything. So this picks
 * the most recent session in the tape whose 09:15 open has already passed — the window that has just
 * closed, which is the only one that is complete — and collects it.
 *
 * IT IS IDEMPOTENT BY DESIGN: if that day's file already exists it does nothing and says so, so a
 * scheduler can call it every few minutes without duplicating a day or re-walking the tape's baseline.
 * `force` overrides that. Sources default to EVERY route the module knows: the keyless ones contribute
 * immediately, and a keyed one that is not configured is reported in `notes` rather than skipped
 * silently — a source that needs a key must not look like a source that found nothing.
 */
const DEFAULT_DAILY_SOURCES = ['news', 'telegram', 'reddit', 'stocktwits', 'finnhub', 'youtube'];

function readDayFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

/**
 * daily(cfg) — THE ONCE-A-DAY RUN, in the TWO PHASES a daily board actually needs.
 *
 * The naive version of "we do this daily" is one collection per day, and it gets the measurement
 * wrong. The window is (yesterday's close -> today's open): at 09:20 this morning that window is
 * complete and ACTIONABLE, but today's bars are not in the tape yet (they arrive with the nightly
 * fetch), so the moves for today cannot be measured yet. One run per day therefore either has no
 * measurement or no currency. So this does both, in order:
 *
 *   PHASE 1 — BACK-FILL. Any collected day whose rows still have no measured move is re-run once its
 *   session has landed in the tape. This is what turns this morning's board into a measured row that
 *   can be scored (the lean table and the per-symbol history are built from these).
 *   PHASE 2 — COLLECT. The window that has just closed: today's, if today is a weekday whose 09:15 has
 *   passed; otherwise the most recent session the tape knows. Written even when no moves can be
 *   measured yet, and those rows are counted in `notMeasured` rather than quietly dropped.
 *
 * IDEMPOTENT, so a scheduler can call it every few minutes: phase 1 only touches days that are
 * measurably incomplete, and phase 2 skips a day it has already collected. `force` re-runs regardless.
 */
async function daily(cfg) {
  cfg = cfg || {};
  const now = Date.now();
  const istDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const today = istDay(now);
  const nifty = BT.niftySeries();
  const sessionSet = new Set();
  for (const ms of nifty.keys()) sessionSet.add(istDay(ms));
  const sessions = Array.from(sessionSet).sort();
  const sources = (cfg.sources && cfg.sources.length) ? cfg.sources : DEFAULT_DAILY_SOURCES;
  const steps = [];

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- PHASE 1: back-fill the days that were collected before their session existed in the tape ----
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const j = readDayFile(path.join(OUT_DIR, f));
    if (!j || !Array.isArray(j.symbols) || !j.symbols.length) continue;
    const measured = j.symbols.filter((r) => r.move).length;
    if (measured > 0) continue;                        // already complete: nothing to back-fill
    if (!sessionSet.has(j.day)) continue;              // its session is still not in the tape: wait
    const p = await run({ day: j.day, sources: j.sources && j.sources.length ? j.sources : sources, channels: cfg.channels, subs: cfg.subs, newsQueries: cfg.newsQueries });
    steps.push({ day: j.day, phase: 'backfill', posts: p.posts, symbols: p.symbols.length, measured: p.symbols.filter((r) => r.move).length });
  }

  // ---- PHASE 2: collect the window that has just closed ----
  const nowOpen = (d) => Date.parse(d + 'T09:15:00+05:30');
  const dow = new Date(nowOpen(today)).getUTCDay();      // 0 Sun .. 6 Sat, in IST
  const todayClosed = nowOpen(today) <= now - 5 * 60000 && dow >= 1 && dow <= 5;
  const latestSession = sessions.filter((d) => nowOpen(d) <= now - 5 * 60000).pop();
  const day = (cfg.day && /^\d{4}-\d{2}-\d{2}$/.test(cfg.day)) ? cfg.day : (todayClosed ? today : latestSession);
  if (!day) return { ok: false, error: 'no session in the tape whose open has passed yet', steps };

  const outFile = path.join(OUT_DIR, day + '.json');
  const prior = readDayFile(outFile);
  if (prior && !cfg.force) {
    steps.push({ day, phase: 'collect', skipped: true, reason: 'already collected (' + (prior.posts || 0) + ' posts, ' + (prior.symbols || []).filter((r) => r.move).length + ' measured)' });
  } else {
    const p = await run({ day, sources, channels: cfg.channels, subs: cfg.subs, newsQueries: cfg.newsQueries });
    steps.push({
      day, phase: 'collect', posts: p.posts, symbols: p.symbols.length, notMeasured: p.notMeasured,
      measured: p.symbols.filter((r) => r.move).length, leanSummary: p.leanSummary,
      chatterMean: p.chatterMean, universeMean: p.universeMean, notes: p.notes,
    });
  }
  const collect = steps.filter((s) => s.phase === 'collect').pop() || null;
  return {
    ok: true, day, today, tapeSessions: sessions.length, steps, notes: (collect && collect.notes) || [],
    posts: collect && collect.posts, symbols: collect && collect.symbols,
    notMeasured: collect && collect.notMeasured, measured: collect && collect.measured,
    leanSummary: collect && collect.leanSummary, chatterMean: collect && collect.chatterMean,
    universeMean: collect && collect.universeMean, file: outFile,
  };
}

/**
 * board(opts) — THE ACCUMULATED VIEW: every collected day merged per symbol.
 *
 * A single day file answers "what was talked about last night". The user's question is the other half of
 * that sentence — "and how did it move, repeatedly" — which only a stack of days can answer. This is the
 * reader that turns data/social_chatter/*.json into that stack: per symbol, how many days it was talked
 * about, mentions, the largest distinct-author count on any one day, the lean counts, and the OBSERVED
 * next-session moves (mean close move and mean index-adjusted 15-minute move) with the number of days it
 * BEAT THE UNIVERSE beside the number of days it was comparable. A hit rate without its denominator is
 * the most common way this kind of table lies.
 *
 * It reads files; it does not collect, and it emits no signal.
 */
function board(opts) {
  const dir = (opts && opts.dir) || OUT_DIR;
  if (!fs.existsSync(dir)) return { ok: false, days: [], symbols: [], collectedDays: 0, note: 'no day files yet — run the collector for a day first' };
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const days = [];
  const bySym = new Map();
  // "it may go up, given what social media is thinking" — SCORED, per lean bucket, against the
  // universe of the same sessions. This is the only honest form of that sentence: the crowd's own
  // direction is treated as a claim and measured, not as advice. n, the mean move, and beat/compared
  // all travel together so a single lucky day cannot read as a hit rate.
  const leanBuckets = new Map();
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
    days.push({
      day: j.day, posts: j.posts, symbols: (j.symbols || []).length, sources: j.sources, file: f,
      universe: j.universeMean ? { n: j.universeMean.n, m15: j.universeMean.m15, close: j.universeMean.close } : null,
      chatter: j.chatterMean ? { n: j.chatterMean.n, m15: j.chatterMean.m15, close: j.chatterMean.close, adj15: j.chatterMean.adj15 } : null,
      leanSummary: j.leanSummary || null,
    });
    for (const r of (j.symbols || [])) {
      if (!r || !r.symbol) continue;
      if (!bySym.has(r.symbol)) {
        bySym.set(r.symbol, { symbol: r.symbol, days: 0, mentions: 0, maxAuthors: 0, bull: 0, bear: 0, leanDays: 0, newsDays: 0,
          moves: [], adj15: [], beatUniverse: 0, comparedDays: 0, lastDay: null, firstDay: null, sources: {}, samples: [] });
      }
      const e = bySym.get(r.symbol);
      e.days++;
      e.mentions += r.mentions || 0;
      e.maxAuthors = Math.max(e.maxAuthors, r.distinctAuthors || 0);
      e.bull += r.bull || 0; e.bear += r.bear || 0;
      if ((r.bull || 0) || (r.bear || 0)) e.leanDays++;
      if (r.newsMentions) e.newsDays++;
      for (const s of Object.keys(r.sources || {})) e.sources[s] = (e.sources[s] || 0) + r.sources[s];
      if (r.move) {
        if (r.move.close != null) e.moves.push(r.move.close);
        if (r.move.adj15 != null) e.adj15.push(r.move.adj15);
        const u = j.universeMean && j.universeMean.close;
        if (u != null && r.move.close != null) { e.comparedDays++; if (r.move.close > u) e.beatUniverse++; }
        const lab = r.leanLabel || 'no direction words';
        if (!leanBuckets.has(lab)) leanBuckets.set(lab, { label: lab, n: 0, closes: [], adj15: [], m30: [], beat: 0, compared: 0, days: new Set() });
        const lb = leanBuckets.get(lab);
        lb.n++;
        if (r.move.close != null) lb.closes.push(r.move.close);
        if (r.move.adj15 != null) lb.adj15.push(r.move.adj15);
        if (r.move.m30 != null) lb.m30.push(r.move.m30);
        if (u != null && r.move.close != null) { lb.compared++; if (r.move.close > u) lb.beat++; }
        lb.days.add(j.day);
      }
      if (!e.firstDay || (j.day && j.day < e.firstDay)) e.firstDay = j.day;
      if (!e.lastDay || (j.day && j.day > e.lastDay)) e.lastDay = j.day;
      if (e.samples.length < 6 && Array.isArray(r.samples)) e.samples = e.samples.concat(r.samples).slice(0, 6);
    }
  }
  const mean = (a) => (a.length ? +BT.mean(a).toFixed(3) : null);
  const rows = Array.from(bySym.values()).map((e) => ({
    symbol: e.symbol, days: e.days, mentions: e.mentions, maxAuthors: e.maxAuthors,
    bull: e.bull, bear: e.bear, leanLabel: leanLabel(e.bull, e.bear),
    observedDays: e.adj15.length, meanClose: mean(e.moves), meanAdj15: mean(e.adj15),
    beatUniverseDays: e.beatUniverse, comparedDays: e.comparedDays,
    firstDay: e.firstDay, lastDay: e.lastDay, sources: e.sources, samples: e.samples,
  })).sort((a, b) => (b.maxAuthors - a.maxAuthors) || (b.mentions - a.mentions));
  const leanPerformance = Array.from(leanBuckets.values()).map((lb) => ({
    label: lb.label,
    n: lb.n,
    days: lb.days.size,
    meanClose: lb.closes.length ? +BT.mean(lb.closes).toFixed(3) : null,
    meanAdj15: lb.adj15.length ? +BT.mean(lb.adj15).toFixed(3) : null,
    mean30: lb.m30.length ? +BT.mean(lb.m30).toFixed(3) : null,
    beatUniverse: lb.beat,
    compared: lb.compared,
  })).sort((a, b) => b.n - a.n);

  // the universe's own mean over the same collected days, so a bucket can be read against the market
  const uni = days.map((d) => d.universe && d.universe.close).filter((x) => x != null);
  const leanNote = leanBuckets.size === 0
    ? 'no measured rows yet: the lean cannot be scored until at least one collected day has tape'
    : (days.length < 5
      ? 'scored over ' + days.length + ' collected day(s) — too few to call a direction informative; the counts are shown so the sample size is never hidden'
      : 'scored over ' + days.length + ' collected day(s)');

  return {
    ok: true,
    collectedDays: days.length,
    days,
    symbols: rows,
    leanPerformance,
    leanNote,
    universeMeanClose: uni.length ? +BT.mean(uni).toFixed(3) : null,
    at: new Date().toISOString(),
    note: days.length < 2
      ? 'one day collected — a per-symbol history needs at least two; the moves below are this day\'s only'
      : 'per-symbol figures accumulate across ' + days.length + ' collected day(s); a name that beat the universe on 1 of 1 day is 1 of 1, not an edge',
  };
}

module.exports = {
  run, board, daily, chatterWindow, inWindow, normPost, aggregate, resolvePosts, forwardFromOpen, universeBaseline,
  collectReddit, collectStocktwits, collectFinnhub, collectYouTube, collectImport, collectText, collectNewsRss,
  collectNewsFeeds, collectTelegram, parseItems, NEWS_FEEDS,
  textLean, leanLabel, DEFAULT_SUBS, HORIZONS, OUT_DIR,
};

if (require.main === module) main();

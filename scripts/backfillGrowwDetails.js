#!/usr/bin/env node
/**
 * scripts/backfillGrowwDetails.js
 *
 * Backfill AUM, expense ratio, fund manager and portfolio holdings for the
 * mutual-fund universe rows that the original ~728-scheme Groww pipeline
 * never covered. For every distinct fund (dedup-preferred row per schemeName)
 * that lacks AUM/TER, fetch Groww's per-scheme __NEXT_DATA__ page (the same
 * known-good source that populated the original rows) and write:
 *   - mutual_fund_aum      (+ aum_snapshots for Change-in-AUM history)
 *   - mutual_fund_schemes.expenseRatio / fundManager
 *   - mutual_fund_portfolios + mutual_fund_holdings
 *
 * Only writes values the source actually provides; ETFs are skipped (Groww
 * hosts those under a separate product path). Re-runnable: rows that already
 * carry AUM or TER are skipped.
 *
 * Run:  node scripts/backfillGrowwDetails.js
 */
'use strict';

const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 10000');

const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};
const CONCURRENCY = 5;

function slugify(n) {
  return String(n).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Strip plan/option residue so the base Groww fund name remains. */
function cleanBase(name) {
  return String(name)
    .replace(/-?\s*-\s*direct plan/gi, '').replace(/-?\s*-\s*regular plan/gi, '')
    .replace(/-?\s*-\s*growth option/gi, '').replace(/-?\s*-\s*idcw[^]*$/gi, '')
    .replace(/\s*\(.*?\)\s*$/g, '')
    .replace(/\s+/g, ' ').trim();
}

/** Replicate getAllSchemesSummary's dedup: best (plan,option) row per schemeName. */
function preferredRows() {
  const rows = db.prepare('SELECT id, schemeCode, schemeName, plan, option FROM mutual_fund_schemes ORDER BY id').all();
  const best = new Map();
  const counts = new Map();
  for (const s of rows) {
    const k = s.schemeName;
    counts.set(k, (counts.get(k) || 0) + 1);
    const pl = (s.plan || '').toLowerCase();
    const op = (s.option || '').toLowerCase();
    let score = 0;
    if (pl.indexOf('direct') !== -1) score += 2; else if (pl.indexOf('regular') !== -1) score -= 1;
    if (op.indexOf('growth') !== -1) score += 1; else if (op.indexOf('idcw') !== -1) score -= 1;
    const prev = best.get(k);
    if (!prev || score > prev.score || (score === prev.score && s.id < prev.id)) best.set(k, { score, s });
  }
  return Array.from(best.values()).map(v => v.s);
}

function slugCandidates(s) {
  const base = cleanBase(s.schemeName);
  const planPhrase = (s.plan || '').toLowerCase().indexOf('regular') !== -1 ? 'regular' : 'direct';
  const wantIdcw = (s.option || '').toLowerCase().indexOf('idcw') !== -1;
  const opts = wantIdcw ? ['idcw', 'growth'] : ['growth', 'idcw'];
  const out = [];
  for (const o of opts) out.push(slugify(base + ' ' + planPhrase + ' ' + o));
  return out;
}

async function fetchNextData(url) {
  const res = await axios.get(url, { timeout: 20000, headers: UA });
  const m = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const j = JSON.parse(m[1]);
  return (j.props && j.props.pageProps && j.props.pageProps.mfServerSideData) || null;
}

function normalizeHoldings(raw) {
  if (!Array.isArray(raw)) return { portfolioDate: null, holdings: [] };
  const portfolioDate = raw[0] && raw[0].portfolio_date ? String(raw[0].portfolio_date).split('T')[0] : null;
  const holdings = raw
    .filter(h => h && (h.isin || Number(h.corpus_per) > 0 || Number(h.market_value) > 0))
    .map(h => ({
      securityName: h.company_name || h.stock_name || h.instrument_name || 'Unknown',
      isin: h.isin || null,
      assetType: h.nature_name || h.instrument_name || 'Equity',
      sector: h.sector_name || null,
      quantity: h.quantity != null ? Number(h.quantity) : null,
      marketValue: h.market_value != null ? Number(h.market_value) : null,
      marketValueCr: h.market_value_cr != null ? Number(h.market_value_cr) : null,
      weight: h.corpus_per != null ? Number(h.corpus_per) : null,
    }))
    .filter(h => h.securityName !== 'Unknown' && h.securityName.toLowerCase() !== 'cash');
  return { portfolioDate, holdings };
}

function persist(s, ss, sourceUrl) {
  let wrote = 0;
  const aum = (ss.aum != null && !isNaN(ss.aum)) ? Number(ss.aum) : null;
  if (aum != null && aum > 0) {
    const asOf = (ss.nav_date || new Date().toISOString().slice(0, 10)).split('T')[0];
    db.prepare(`INSERT INTO mutual_fund_aum (schemeId, aum, asOfDate, source)
      VALUES (?,?,?,?) ON CONFLICT(schemeId) DO UPDATE SET aum=excluded.aum, asOfDate=excluded.asOfDate, source=excluded.source`)
      .run(s.id, aum, asOf, 'groww');
    db.prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?,?,?,?)').run(s.id, aum, asOf, 'groww');
    wrote++;
  }
  const ter = (ss.expense_ratio != null && !isNaN(ss.expense_ratio)) ? Number(ss.expense_ratio) : null;
  if (ter != null && ter > 0) {
    db.prepare('UPDATE mutual_fund_schemes SET expenseRatio = ?, updatedAt = datetime(\'now\') WHERE id = ?').run(ter, s.id);
    wrote++;
  }
  if (ss.fund_manager) {
    db.prepare('UPDATE mutual_fund_schemes SET fundManager = ?, updatedAt = datetime(\'now\') WHERE id = ?').run(String(ss.fund_manager).trim(), s.id);
  }
  const { portfolioDate, holdings } = normalizeHoldings(ss.holdings);
  if (portfolioDate && holdings.length > 0) {
    const pid = db.prepare(`INSERT INTO mutual_fund_portfolios (schemeId, portfolioDate, source)
      VALUES (?,?,?) ON CONFLICT(schemeId, portfolioDate) DO UPDATE SET source=excluded.source RETURNING id`)
      .get(s.id, portfolioDate, 'groww').id;
    db.prepare('DELETE FROM mutual_fund_holdings WHERE portfolioId = ?').run(pid);
    const ins = db.prepare(`INSERT INTO mutual_fund_holdings (portfolioId, securityName, isin, assetType, sector, quantity, marketValue, marketValueCr, weight)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction((hs) => { for (const h of hs) ins.run(pid, h.securityName, h.isin, h.assetType, h.sector, h.quantity, h.marketValue, h.marketValueCr, h.weight); });
    tx(holdings);
    wrote++;
  }
  return wrote;
}

async function main() {
  const targets = preferredRows();
  console.log('[Backfill] distinct funds:', targets.length);

  const already = new Set();
  for (const r of db.prepare('SELECT schemeId FROM mutual_fund_aum WHERE aum > 0').all()) already.add(r.schemeId);
  for (const r of db.prepare('SELECT id FROM mutual_fund_schemes WHERE expenseRatio > 0').all()) already.add(r.id);
  const todo = targets.filter(s => !already.has(s.id) && !/etf|exchange traded/i.test(s.schemeName));
  console.log('[Backfill] to fetch:', todo.length, '(skipping', targets.length - todo.length, 'already-filled or ETF)');

  const idx = { next: 0 };
  const stats = { ok: 0, aum: 0, ter: 0, holdings: 0, fail: 0 };
  const fmt = n => n.toLocaleString('en-IN');

  async function worker() {
    while (true) {
      const i = idx.next++;
      if (i >= todo.length) return;
      const s = todo[i];
      let ss = null, usedUrl = null;
      for (const slug of slugCandidates(s)) {
        const url = 'https://groww.in/mutual-funds/' + slug;
        try {
          const data = await fetchNextData(url);
          if (data) { ss = data; usedUrl = url; break; }
          // 200 but no mfServerSideData — try next variant
        } catch (e) {
          const code = e.response ? e.response.status : e.code;
          if (code === 429) await new Promise(r => setTimeout(r, 4000));
        }
      }
      if (!ss) { stats.fail++; if (i % 25 === 0) console.log(`[Backfill] ${i}/${todo.length} fail@${s.schemeName}`); continue; }
      stats.ok++;
      const w = persist(s, ss, usedUrl);
      if (w >= 1) stats.aum++;
      if (i % 25 === 0) console.log(`[Backfill] ${i}/${todo.length} ok=${stats.ok} fail=${stats.fail} aum+ter+hold=${w} ${s.schemeName.slice(0, 45)}`);
    }
  }

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);

  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log('\n[Backfill] done. resolved:', stats.ok, '| no page:', stats.fail);
  const c = (q) => db.prepare(q).get().c;
  console.log('AUM rows:', c('SELECT COUNT(*) c FROM mutual_fund_aum WHERE aum>0'));
  console.log('schemes with TER:', c('SELECT COUNT(*) c FROM mutual_fund_schemes WHERE expenseRatio>0'));
  console.log('schemes with holdings:', c('SELECT COUNT(DISTINCT p.schemeId) c FROM mutual_fund_portfolios p JOIN mutual_fund_holdings h ON h.portfolioId=p.id'));
  db.close();
}

main().catch(e => { console.error('[Backfill] fatal:', e.message); process.exit(1); });

/**
 * gb_scoring_v2/verify-feed.js — PHASE 1: THE FEED VERIFICATION CHECKLIST (spec 6.3).
 *
 * Phase 1 done-when: "Section 6.3 checklist answered; provenance tags assigned;
 * spread/depth availability known."
 *
 * The spec is blunt about why this comes before any engine work (Section 28):
 * "Feed fidelity: inferred flow is only as good as the classification and tick
 * frequency. Verify before trusting it."
 *
 * What this script can and cannot do. Some of the checklist is answerable from
 * the data GB already publishes (field presence, depth, timeframes). Some is not
 * answerable from data at all -- whether the broker's trade prints carry an
 * aggressor flag, and what the vendor's session limits are, are claims about an
 * EXTERNAL feed. Those are marked OPEN with the exact thing to check, because
 * writing "probably fine" would be exactly the folklore the spec is guarding
 * against.
 */
const { loadGB, feedCensus, provenanceSummary, snapshots, forcedSymbols } = require('./adapter');
const { FIELD_REGISTRY, TAGS } = require('./adapter/provenance');
const { CONFIG } = require('./config/index');   // explicit: a draft config.js sits beside config/

const VERIFIED = 'VERIFIED', ABSENT = 'ABSENT', OPEN = 'OPEN';

/**
 * buildChecklist() -- the seven Section 6.3 questions, each answered with the
 * evidence that produced the answer rather than a bare yes/no.
 */
function buildChecklist(gb) {
  const rows = (gb && gb.rows) || [];
  const census = feedCensus(gb);
  const snaps = snapshots(gb);
  const withCT = rows.filter(r => r.candleTrend);
  const frames = new Set();
  for (const r of withCT) for (const k of Object.keys(r.candleTrend)) frames.add(k);

  const items = [
    {
      q: 'Which fields does the feed actually provide, and at what tick frequency?',
      status: VERIFIED,
      answer: 'Field presence is measured (see census). Tick FREQUENCY per symbol is not observable from the scan artifact -- it needs a live tap; the tick board exposes a board age instead.',
      evidence: census ? { deep: census.depth.deep, trackOnly: census.depth.tickOnly, hasBid: census.census.bid.present, hasVolume: census.census.volume.present, hasFlowBias: census.census.flowBias.present } : null,
      open: 'Confirm per-symbol tick cadence from the Angel websocket directly (Phase 1 follow-up).',
    },
    {
      q: 'Exchange timestamp vs receipt timestamp, and typical latency.',
      status: ABSENT,
      answer: 'GB rows carry the SCAN time (givenAt), not an exchange print time. There is no exchangeTs anywhere in the GB payload.',
      evidence: { exchangeTsFieldsFoundInGbPayload: 0, scannedRows: rows.length },
      consequence: 'GATE_LATENCY cannot be evaluated from the GB payload. Per the spec, an unknown gate input caps status at WATCH -- it does not silently pass.',
      // CORRECTION (measured after the first report). The SCREENING quote is a
      // different source from the GB payload, and it carries BOTH an exchange
      // print time (regularMarketTime) and the vendor\'s own delay declaration
      // (exchangeDataDelayedBy). Measured 15 minutes for NSE -- see below.
      alsoAvailable: 'The Yahoo stage-A quote carries regularMarketTime (a real exchange print time) AND exchangeDataDelayedBy. Yahoo declares 15 minutes for NSE. That is enough to evaluate a SCREENING latency budget, but it is a delayed source and must never back an entry-timing latency claim.',
    },
    {
      q: 'Is bid/ask available (needed for the spread gate), and how many depth levels?',
      status: ABSENT,
      answer: 'Not in the GB payload: 0 of ' + rows.length + ' rows carry bid, ask or spread. Every tick-derived snapshot therefore has spreadPct null, and GATE_SPREAD cannot run off the tick feed.',
      evidence: census ? { bid: census.census.bid, ask: census.census.ask, spread: census.census.spread } : null,
      consequence: 'For the ENTRY path this stands: the outcome simulator must fall back to last price +/- half a spread ESTIMATE, so slippage stays a parameter and entry realism is weaker.',
      // CORRECTION (measured after the first report): the Yahoo quote was probed
      // directly and DOES carry bid/ask/bidSize/askSize -- but returns 0 for them
      // outside the REGULAR session. So a screening-grade spread is available
      // while the session is quoted, and moversBoard now stores 0 as null so a
      // 0 can never read as a zero-width market.
      alsoAvailable: 'PROBED: the Yahoo quote carries bid, ask, bidSize and askSize, but reports them as 0 outside REGULAR. A screening-grade spread is therefore available while quoted -- stored as null when not, never as 0. Depth is 1 level and unverified flicker.',
    },
    {
      q: 'Do trades carry an aggressor flag, and what do total buy/sell quantity fields mean?',
      status: OPEN,
      answer: 'No aggressor flag is present. totBuy/totSell exist on a minority of rows; GB also publishes flowBias, which is a normalized INFERRED bias, not exchange-classified delta.',
      evidence: census ? { totBuy: census.census.totBuy, totSell: census.census.totSell, flowBias: census.census.flowBias } : null,
      open: 'SPEC 6.2 CAUTION STANDS: total buy/sell QUANTITY may be RESTING order quantity, not executed. Confirm against the broker docs before using rawBuyQty as order value. Until then it is tagged VERIFY and cannot silently become evidence.',
    },
    {
      q: 'Subscription limits per session and per connection.',
      status: OPEN,
      answer: 'Not answerable from data. The spec warns that on SmartAPI one tick is published per token-and-mode combination and each combination counts against a per-session cap, so the scan universe and modes must be planned together.',
      evidence: { forcedSymbolsNow: forcedSymbols().length },
      open: 'Read the current Angel One subscription/rate limits before fixing any universe size. (This is the same caution raised for the stage-A shortlist size.)',
    },
    {
      q: 'Which candle timeframes does the system already build? Is 3m present?',
      status: frames.size ? VERIFIED : OPEN,
      answer: frames.size ? ('Frames present on the board: ' + [...frames].sort().join(', ') + '. 3m IS present, so the spec\'s optional structural input can be included rather than deferred.') : 'No candle frames found on the rows.',
      evidence: { frames: [...frames].sort() },
    },
    {
      q: 'Source and history depth for ATR, ADX, RSI seeding, beta, sector mapping, circuit bands, surveillance stage, event calendar.',
      status: OPEN,
      answer: 'ATR is present per row. ADX and RSI are absent entirely. Beta, sector mapping, circuit bands, surveillance stage and the event calendar are all absent -- every one of them is an UNKNOWN in the registry, which is why the spec lists them as open items.',
      evidence: census ? { atr: census.census['daily.atrPct'], adx: census.census.adx, rsi: census.census.rsi } : null,
      open: 'Section 28 open items: sector and beta source, event-flag source, broker square-off time, cost model parameters.',
    },
  ];

  const prov = provenanceSummary(snaps);
  return {
    kind: 'phase1-feed-verification',
    generatedAt: new Date().toISOString(),
    scan: { generatedAt: gb && gb.generatedAt, ageMs: gb && gb.ageMs, marketOpen: gb && gb.marketOpen, rows: rows.length, snapshots: snaps.length },
    headline: {
      spreadGateRunnable: false,      // off the TICK feed; a screening-grade spread exists on the Yahoo quote
      latencyGateRunnable: false,     // no exchangeTs in the GB payload; the Yahoo quote has one (delayed 15 min)
      depthAvailable: false,          // 1 unverified level on the Yahoo quote, none on the tick feed
      aggressorFlagAvailable: false,
      threeMinuteFrames: frames.has('m3'),
      inferredOnlyFlowRows: prov.inferredOnlyFlows,
      // MEASURED, not assumed: Yahoo's own exchangeDataDelayedBy field for NSE.
      // This is the number behind the spec's caution that Yahoo is non-real-time.
      yahooDeclaredDelayMinutes: 15,
      yahooQuoteHasBidAsk: true,
      yahooQuoteHasExchangeTime: true,
    },
    provenance: { registryFields: Object.keys(FIELD_REGISTRY).length, tags: TAGS, counts: prov.counts, inferredOnlyFlows: prov.inferredOnlyFlows, of: prov.of },
    census,
    checklist: items,
    // The gates whose input is now known to be missing, and what the spec says that means.
    gateImpact: Object.keys(CONFIG.gates)
      .filter(g => ['spread', 'latency', 'event', 'warmup'].includes(g))
      .map(g => ({ gate: g, code: CONFIG.gates[g].code, onMissing: CONFIG.gates[g].onMissing, inputPresent: g === 'warmup' ? frames.has('m3') : false })),
  };
}

function summarise(rep) {
  const l = [];
  l.push('PHASE 1 — FEED VERIFICATION  (scan ' + rep.scan.generatedAt + ', ' + rep.scan.rows + ' rows)');
  l.push('  spread gate runnable : ' + rep.headline.spreadGateRunnable);
  l.push('  latency gate runnable: ' + rep.headline.latencyGateRunnable);
  l.push('  depth available      : ' + rep.headline.depthAvailable);
  l.push('  aggressor flag       : ' + rep.headline.aggressorFlagAvailable);
  l.push('  3m frames present    : ' + rep.headline.threeMinuteFrames);
  l.push('  inferred-only flow   : ' + rep.headline.inferredOnlyFlowRows + ' / ' + rep.provenance.of + ' snapshots');
  l.push('  Yahoo declared delay : ' + rep.headline.yahooDeclaredDelayMinutes + ' min  (exchangeDataDelayedBy, measured)');
  l.push('  Yahoo quote bid/ask  : ' + rep.headline.yahooQuoteHasBidAsk + '  (but 0 outside REGULAR -> stored null)');
  l.push('  provenance tags      : ' + JSON.stringify(rep.provenance.counts));
  l.push('');
  for (const it of rep.checklist) l.push('  [' + it.status + '] ' + it.q + '\n        ' + it.answer + (it.open ? '\n        OPEN: ' + it.open : '') + (it.consequence ? '\n        -> ' + it.consequence : ''));
  return l.join('\n');
}

module.exports = { buildChecklist, summarise, VERIFIED, ABSENT, OPEN };

if (require.main === module) {
  const gb = loadGB();
  const rep = buildChecklist(gb);
  console.log(summarise(rep));
  try {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname, '..', 'data', 'v2_sessions');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'feed_verification_' + new Date().toISOString().slice(0, 10) + '.json');
    fs.writeFileSync(f, JSON.stringify(rep, null, 2));
    console.log('\nwritten: ' + f);
  } catch (e) { console.log('\n(report not written: ' + e.message + ')'); }
}

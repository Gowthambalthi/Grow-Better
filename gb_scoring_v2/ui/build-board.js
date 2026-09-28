/**
 * gb_scoring_v2/ui/build-board.js — THE SHADOW BOARD, OLD BESIDE NEW.
 *
 * THE COMPLAINT THIS ANSWERS: "i dont see any change frontend it still using old
 * logic". That was true, and it was true for a reason worth saying plainly:
 * Spec Section 2 says the new engine runs in SHADOW MODE and never modifies the old
 * engine, and Section 27 puts the side-by-side UI at Phase 16, after validation. So
 * nothing in public/index.html was ever going to change on its own. The work was real
 * but invisible, which is a bad place for it to be.
 *
 * This builder makes it visible WITHOUT touching the live app:
 *   * it reads the same GB output the live board reads, through the read-only adapter;
 *   * it runs the V3 gates, momentum, location and candle layers over every row;
 *   * it writes ONE self-contained HTML file (data inlined, no server, no fetch), so
 *     it can be opened beside the real board and compared row by row.
 *
 * IT DECIDES NOTHING. No route, no engine, no decision path reads this file. The old
 * engine keeps trading exactly as before. When the two disagree, the page shows WHY,
 * which is the whole point of a shadow view (Section 27: "the user can see exactly
 * why the engines disagree").
 *
 * Usage:
 *   node gb_scoring_v2/ui/build-board.js
 *   node gb_scoring_v2/ui/build-board.js --out=gb_scoring_v2/ui/board.html
 */
const fs = require('fs');
const path = require('path');
const { CONFIG, hash, stamp } = require('./../config/index');
const adapter = require('./../adapter');
const { runGates } = require('./../gates');
const momentum = require('./../momentum');
const location = require('./../location');
const candles = require('./../candles');
const { score } = require('./../score');

const out = (() => {
  const a = process.argv.find((x) => x.startsWith('--out='));
  return a ? a.split('=')[1] : path.join(__dirname, 'board.html');
})();

const isKnown = adapter.isKnown;
const num = (v) => (isKnown(v) && typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * directionOf(row) — the trade side, taken ONLY from what the row itself records.
 * Never inferred from the outcome, never guessed from the sign of the momentum: a
 * shadow view that fabricates a direction would show disagreements the engine never
 * had. When the row carries no side (which is normal for HOLD/TRACK rows before a
 * setup forms), the direction gate caps at WATCH and the page says so.
 */
function directionOf(row) {
  const w = String(row.want || '').toUpperCase();
  if (w === 'LONG' || w === 'BUY') return 'LONG';
  if (w === 'SHORT' || w === 'SELL') return 'SHORT';
  const s = String(row.signal || '').toUpperCase();
  if (s === 'BUY') return 'LONG';
  if (s === 'SHORT') return 'SHORT';
  const d = num(row.dirSign);
  if (d === 1) return 'LONG';
  if (d === -1) return 'SHORT';
  return null;
}

function fmtNum(v, d = 2) {
  return v == null || v === '' ? null : (typeof v === 'number' ? +v.toFixed(d) : v);
}

/**
 * displayLean(it) — WHICH WAY THE EVIDENCE LEANS, for the arrow column.
 *
 * This is a DISPLAY read for sorting and scanning, NOT a V3 decision: V3 has no score
 * yet (Phase 11), so nothing here is a BUY. It answers "if this row eventually became a
 * trade, which side would the evidence be on?" by summing only the direction-bearing
 * evidence that actually exists on the row, each bounded to [-1, +1]:
 *
 *   momentum fast + structural   (Phase 5 normalized ROC, agreement-damped)
 *   location aligned value       (Phase 9: POC / VA / VWAP position vs the side)
 *   flow delta                   (buyer vs seller pressure, INFERRED — labeled as such)
 *   candle trend value           (m1..m15 agreement, DISPLAY-ONLY per spec §17)
 *
 * Scaled to [-100, +100]. Sign = direction; magnitude = how much evidence agrees.
 * Rows with no evidence at all stay at 0 and sort last.
 */
function displayLean(it) {
  const parts = [];
  if (it.momentum.fast != null) parts.push(Math.max(-1, Math.min(1, it.momentum.fast)));
  if (it.momentum.structural != null) parts.push(Math.max(-1, Math.min(1, it.momentum.structural)));
  if (it.location.value != null) parts.push(Math.max(-1, Math.min(1, it.location.value)));
  if (it.proto.flowBias != null) parts.push(Math.max(-1, Math.min(1, it.proto.flowBias)));
  if (it.candles.trendValue != null) parts.push(Math.max(-1, Math.min(1, it.candles.trendValue)));
  if (!parts.length) return { value: 0, parts: 0 };
  const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
  return { value: Math.round(mean * 100), parts: parts.length };
}

/** A one-line REASON FOR the lean: the strongest evidence pieces, named, with values. */
function reasonFor(it, lean) {
  if (!lean.parts) return 'no directional evidence on the row';
  const bits = [];
  const f = it.proto;
  const rocTxt = [[f.roc10, '10s'], [f.roc20, '20s'], [f.roc30, '30s'], [f.roc1m, '1m'], [f.roc3m, '3m'], [f.roc5m, '5m'], [f.roc15m, '15m']]
    .filter(([v]) => v != null);
  if (rocTxt.length) {
    const best = rocTxt.reduce((a, b) => (Math.abs(b[0]) > Math.abs(a[0]) ? b : a));
    bits.push(best[1] + ' ROC ' + (best[0] > 0 ? '+' : '') + best[0] + '%');
  }
  if (it.momentum.fast != null) bits.push('momentum ' + (it.momentum.fast > 0 ? 'up' : 'down') + ' ' + Math.abs(it.momentum.fast).toFixed(2));
  if (it.location.value != null) bits.push('at ' + (it.location.value > 0 ? 'supportive' : 'opposed') + ' location ' + Math.abs(it.location.value).toFixed(2));
  if (f.flowBias != null) bits.push('flow ' + (f.flowBias > 0 ? 'buyers' : 'sellers') + ' ' + Math.abs(f.flowBias).toFixed(2));
  if (it.candles.pattern) bits.push(it.candles.pattern);
  const volBits = [];
  if (f.volX != null) volBits.push('vol ' + f.volX + 'x');
  if (f.volume != null) volBits.push(Math.round(f.volume / 1000) + 'k traded');
  if (volBits.length) bits.push(volBits.join(', '));
  return bits.join(' · ');
}

/**
 * THE DECISION MUST SEE THE LIVE MARKET, NOT THE LAST SCAN.
 *
 * Everything downstream of here — price evidence → momentum → score → the Signal column — was
 * built from `live_signals.json`, a snapshot the scan writes roughly once a minute. The 3m and 15m
 * frames in it were therefore up to a minute old AND, worse, could be null on any symbol the scan
 * had not deep-read this cycle, in which case the decision ran on partial evidence it could not
 * tell was partial.
 *
 * The tick board already carries the whole ridge (10s/15s/20s/30s/40s/50s and 1m/3m/5m/15m, each
 * anchored on ticks or on a real minute bar) rebuilt every five seconds. Overlaying it onto the
 * rows BEFORE the snapshots are made means the score, the phase, the timing guards and the entry
 * plan are all evaluated against the tape as it is now, while the structural evidence the tick
 * feed cannot carry — depth, VWAP/POC, quality, screening — stays from the scan that measured it.
 *
 * That split is deliberate and reported, not hidden: `framesAgeMs` (seconds) and `ageMs` (a minute)
 * answer different questions, exactly like `tickAt` vs `generatedAt` on the old board.
 */
function overlayLiveFrames(gb) {
  const none = { at: null, ageMs: null, overlaid: 0, total: 0, fromTicks: 0, fromBars: 0 };
  let board = null;
  try { board = require('../../common/market/tickBoard').getBoard(); } catch (_) { return none; }
  if (!board || !Array.isArray(board.stocks) || !board.stocks.length) return none;
  const tmap = new Map(board.stocks.map((t) => [String(t.symbol).toUpperCase(), t]));
  const rows = gb.rows || [];
  let overlaid = 0;
  for (const r of rows) {
    const t = tmap.get(String(r.symbol).toUpperCase());
    if (!t) continue;
    let touched = false;
    const set = (k, v) => { if (v != null) { r[k] = v; touched = true; } };
    // the tick-scale ladder — always tick-precise when present
    set('s10', t.s10); set('s15', t.s15); set('s20', t.s20);
    set('s30', t.s30); set('s40', t.s40); set('s50', t.s50);
    // THE 10-SECOND GRID (ROC 10s/20s/30s), the user's own fast ladder: one sample per 10s,
    // ROC(20s) = now vs two buckets back. These are what the table's three fast ROC columns
    // show, and ROC(20s) is the fast confirmation the decision gate reads.
    set('roc10', t.roc10); set('roc20', t.roc20); set('roc30', t.roc30);
    // THE SLOW FRAMES ARE ASSIGNED EVEN WHEN NULL, and that is the point. `set` above only
    // writes non-null values, so a symbol whose tick history does not reach the 3m/5m/15m frame
    // kept whatever the ~60s scan had stamped — the exact "3m late / 15m late" defect the user
    // reported. A null here must survive into the timing block so the scorer REFUSES on "no
    // readable frame" instead of scoring a minute-old number as if it were a live one.
    r.roc1 = t.m1 == null ? null : t.m1;
    r.roc3 = t.m3 == null ? null : t.m3;
    r.roc5 = t.m5 == null ? null : t.m5;
    r.roc15 = t.m15 == null ? null : t.m15;
    touched = true;   // the row HAS a live read; the values may still be null, which is a fact
    // the price the plan will be built at. A stop distance derived from a minute-old price is
    // simply the wrong distance, so the entry/stop/target come off the live print.
    set('price', t.ltp);
    // the move's own lifecycle, so the scorer can refuse to enter a move that already happened
    if (t.phase !== undefined && t.phase !== null) { r.phase = t.phase; r.phaseNote = t.phaseNote || null; touched = true; }
    if (touched) { r.liveFrames = true; r.liveSrc = t.ladderSrc || null; overlaid++; }
  }
  const ageMs = board.generatedAt ? Date.now() - Date.parse(board.generatedAt) : null;
  return {
    at: board.generatedAt || null,
    ageMs,
    overlaid,
    total: rows.length,
    fromTicks: board.slowFromTicks || 0,
    fromBars: board.slowFromBars || 0,
  };
}

function build() {
  const gb = adapter.loadGB();
  // LIVE FRAMES IN, BEFORE ANY EVIDENCE IS DERIVED. Everything below reads these.
  const liveFrames = overlayLiveFrames(gb);
  const rows = gb.rows || gb.signals || [];
  const snaps = adapter.snapshots(gb, {});
  const bySymbol = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r]));
  const generatedAt = gb.generatedAt || null;
  const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt) : null;

  const items = [];
  let blocked = 0, watch = 0, pass = 0;
  for (const s of snaps) {
    const row = bySymbol.get(String(s.symbol).toUpperCase()) || {};
    const direction = directionOf(row);
    const gates = runGates(s, {
      direction, now: Date.now(),
      receiptTs: Date.parse(s.receiptTs) || Date.now(),
      market: gb.market || null, banned: gb.banned || [],
    });
    const mom = momentum.momentumEvidence(s, {});
    const loc = location.locationEvidence(s, { direction });
    const can = candles.candleEvidence(s, { direction });

    // THE MEASURED LEVELS, captured BEFORE the evidence objects below take their names.
    // The score's stop is structural (this feed has no ATR at all), so it needs the raw
    // VWAP / value-area / POC / day extremes / prior close rather than the evidence wrapper.
    const levels = {
      vwap: s.location ? s.location.vwap : null,
      val: s.location ? s.location.val : null,
      vah: s.location ? s.location.vah : null,
      poc: s.location ? s.location.poc : null,
      dayHigh: s.candles ? s.candles.dayHigh : null,
      dayLow: s.candles ? s.candles.dayLow : null,
      prevClose: s.reference ? s.reference.close : null,
    };

    // TIMING, HANDED TO THE DECISION. The board measures the move's lifecycle (`phase`, from the
    // ladder's magnitude plus last-10s velocity) and carries the whole 10s→15m ridge. None of it
    // used to reach the score, so the engine could NOT know it was entering a finished move —
    // which is how a correct direction turns into a loss. These four frames plus the phase are
    // the timing block; the scorer refuses SIGNAL on a late move or one fighting its own frame.
    const timing = {
      phase: isKnown(row.phase) ? row.phase : null,
      phaseNote: row.phaseNote || null,
      // THE FAST LADDER, from the 10-second grid. ROC(20s) is the single fast confirmation the
      // order-flow gate uses (the plan collapses the old 10s/15s/30s/40s/50s ridge into one
      // number precisely because five correlated fast frames were the overfitting problem). The
      // scorer reads it only as a REFUSAL: a buy with the 20s frame falling hard is refused.
      roc10s: fmtNum(row.roc10, 2),
      roc20s: fmtNum(row.roc20, 2),
      roc30s: fmtNum(row.roc30, 2),
      gridSamples: row.rocGrid ? row.rocGrid.samples : null,
      // FIELD NAMES ARE THE SCAN ROW'S OWN (roc1/roc3/roc5/roc15) — not the snapshot's
      // roc1m/roc3m/roc5m/roc15m names, which is a DIFFERENT object further down the chain.
      // Reading the snapshot names here returned null on every row, which made requireSlowFrame
      // refuse all 549 of them — the guard worked perfectly on evidence that never arrived.
      roc1m: fmtNum(row.roc1, 2),
      roc3m: fmtNum(row.roc3, 2),
      roc5m: fmtNum(row.roc5, 2),
      roc15m: fmtNum(row.roc15, 2),
      // which base each slow frame used ('tick' = sub-second, 'bar' = one-minute bar anchor),
      // carried through so a coarse frame is visible rather than implied precise
      // overlayLiveFrames stamps the base on `liveSrc` (this row's live read), which is a
      // different thing from the Server's overlay on the signals endpoint. Reading `slowSrc`
      // here silently yielded null on every row, so the page could not say how coarse a frame was.
      slowSrc: row.liveSrc || row.slowSrc || null,
    };

    // PHASE 11. The only call in V3 that can say "this is a trade". Its direction is DERIVED
    // FROM ITS OWN EVIDENCE — it is deliberately not handed the old engine's side.
    const sc = score(Object.assign({}, s, { levels, momentum: mom, location: loc, candles: can, timing }), { gates });

    if (gates.status === 'BLOCKED') blocked++; else if (gates.status === 'WATCH') watch++; else pass++;

    items.push({
      symbol: s.symbol,
      depth: s.depth,
      price: fmtNum(s.price, 2),
      direction,
      score: {
        status: sc.status,
        direction: sc.direction,
        directionSource: sc.directionSource,
        points: sc.points,
        availablePoints: sc.availablePoints,
        requiredPoints: sc.requiredPoints,
        coverage: sc.coverage,
        groups: sc.groups.map((g) => ({ name: g.name, points: g.points, max: g.max, state: g.state })),
        missing: sc.missing,
        notRunnable: sc.notRunnable,
        blockers: sc.blockers,
        text: sc.text,
        plan: sc.plan,
        // the TIMING refusal, kept distinct from "not enough points": a row can be strong and
        // still refused because the move already happened, and those two must not read alike
        timing: sc.timing,
      },
      // the live frame ladder the decision just used, so the page can show what the score saw
      timing: timing,
      old: {
        engine: isKnown(row.engine) ? row.engine : null,
        score: num(row.score),
        signal: isKnown(row.signal) ? row.signal : null,
        label: isKnown(row.label) ? row.label : null,
        phase: isKnown(row.phase) ? row.phase : null,
      },
      gates: {
        status: gates.status,
        blockedBy: gates.blockedBy,
        text: gates.text,
        reasons: gates.reasons.map((r) => r.code + (r.detail ? ': ' + r.detail : '')),
        risks: gates.risks,
        notRunnable: gates.notRunnable.map((n) => n.code || n.gate),
        coverageCapped: gates.coverageCapped,
        coverage: s.coverage ? s.coverage.overall : null,
      },
      momentum: {
        fast: fmtNum(mom.fast, 3), structural: fmtNum(mom.structural, 3), acceleration: fmtNum(mom.acceleration, 3),
        priorMove: fmtNum(mom.priorMove, 3),
        text: mom.text,
        missing: mom.missing.slice(0, 3),
      },
      location: {
        value: fmtNum(loc.value, 3), raw: fmtNum(loc.raw, 3),
        agreement: loc.agreement,
        parts: loc.parts.map((p) => ({ name: p.name, value: fmtNum(p.value, 3), aligned: fmtNum(p.aligned, 3), detail: p.detail })),
        poc: fmtNum(s.location.poc, 2), vwap: fmtNum(s.location.vwap, 2),
        vah: fmtNum(s.location.vah, 2), val: fmtNum(s.location.val, 2),
        pocDistPct: s.location.poc != null && s.price != null && s.location.poc > 0
          ? fmtNum(((s.price - s.location.poc) / s.location.poc) * 100, 3) : null,
        vwapDistPct: s.location.vwap != null && s.price != null && s.location.vwap > 0
          ? fmtNum(((s.price - s.location.vwap) / s.location.vwap) * 100, 3) : null,
        nearLevels: loc.nearLevels,
        display: loc.display,
        text: loc.text,
        missing: loc.missing,
      },
      candles: {
        value: fmtNum(can.value, 3),
        gap: can.gap ? { openPct: can.gap.openPct, dir: can.gap.dir, fillPct: can.gap.fillPct, state: can.gap.state, sizeVsAtrX: can.gap.sizeVsAtrX, text: can.gap.text, obstacles: can.gap.obstacles } : null,
        pattern: can.pattern ? can.pattern.parts.pattern : null,
        patternLean: can.pattern ? can.pattern.parts.patternLean : null,
        trendValue: can.pattern ? fmtNum(can.pattern.parts.trendValue, 3) : null,
        trendAgreement: can.pattern ? can.pattern.parts.trendAgreement : null,
        agree: can.pattern ? can.pattern.parts.agree : null,
        scored: can.scored, points: can.points,
        text: can.text,
        missing: can.missing,
      },
      screener: {
        avgVol20: fmtNum(s.reference.avgVol20, 0),
        atrPct: fmtNum(s.price_evidence.atrPct, 2),
        dayPct: fmtNum(s.reference.dayPct, 2),
        marketCapCr: fmtNum(s.reference.marketCap != null ? s.reference.marketCap / 1e7 : null, 0),
        delayedBy: s.screening ? s.screening.delayedBy : null,
        screeningSpread: s.screening ? s.screening.spreadPct : null,
      },
      proto: {
        // THE FULL LADDER the strategy actually watches, in scan order:
        // 10s / 20s / 30s (tick windows), 15s, then 1m / 3m / 5m / 15m / 60m.
        roc10: fmtNum(s.price_evidence.roc10, 2), roc20: fmtNum(s.price_evidence.roc20, 2),
        roc30: fmtNum(s.price_evidence.roc30, 2), roc15s: fmtNum(s.price_evidence.roc15s, 2),
        roc1m: fmtNum(s.price_evidence.roc1m, 2), roc3m: fmtNum(s.price_evidence.roc3m, 2),
        roc5m: fmtNum(s.price_evidence.roc5m, 2), roc15m: fmtNum(s.price_evidence.roc15m, 2),
        roc60m: fmtNum(s.price_evidence.roc60m, 2),
        flowBias: fmtNum(s.flow.delta, 3),
        volume: num(s.flow.volume),
        volX: fmtNum(s.flow.volumeRatio, 2),
        rawBuyQty: num(s.flow.rawBuyQty), rawSellQty: num(s.flow.rawSellQty),
        buyPressure: fmtNum(s.flow.buyPressure, 3), sellPressure: fmtNum(s.flow.sellPressure, 3),
        flowInferred: !!(s.flow.provenance && s.flow.provenance.inferred && s.flow.provenance.inferred.includes('delta')),
        missingCount: s.missing.length,
      },
    });
    const lean = displayLean(items[items.length - 1]);
    items[items.length - 1].lean = lean;
    items[items.length - 1].reasonFor = reasonFor(items[items.length - 1], lean);
  }

  // WHY NOTHING IS A SIGNAL YET, computed from the rows rather than asserted. This is
  // the single most useful line on the page: it stops "the new engine shows nothing"
  // from being read as "the new engine is broken".
  const covCapped = items.filter((i) => i.gates.coverageCapped).length;
  const noDirection = items.filter((i) => !i.direction).length;
  const reasonCounts = {};
  for (const it of items) for (const r of it.gates.reasons) {
    const code = String(r).split(':')[0];
    reasonCounts[code] = (reasonCounts[code] || 0) + 1;
  }
  const insights = {
    coverageCapped: covCapped,
    noDirection,
    topReasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, n]) => ({ code, n })),
    scoreBuilt: true,
    timingVetoed: items.filter((i) => i.score.timing && i.score.timing.blocked).length,
    whyNoSignal: [
      'Phase 11 IS built, so SIGNAL is reachable: the bar is ' + (CONFIG.score.decision.signalThreshold) + ' of ' + CONFIG.score.totalPoints + ' scaled to the points this feed can actually read, and a SIGNAL with no derivable stop is refused outright.',
      covCapped + ' of ' + items.length + ' rows are below the WATCH coverage cap ' + CONFIG.score.coverage.capsAtWatchBelow + ': RSI, ADX, sector return and beta do not exist in this feed (Phase 1), so their groups are empty.',
      noDirection + ' of ' + items.length + ' rows carry no trade side: the side is derived from this engine\'s own evidence and mixed evidence deliberately yields NO side rather than a coin flip.',
      'TIMING REFUSALS ARE SEPARATE FROM POINTS: ' + items.filter((i) => i.score.timing && i.score.timing.blocked).length + ' rows earned points but are refused because the move already happened (phase LATE/EXHAUSTED) or because the row is fighting its own 5m/15m frame. A high score on a finished move is the trade that loses money, so timing is checked BEFORE the score.',
    ],
  };

  const payload = {
    kind: 'v3-shadow-board',
    insights,
    builtAt: new Date().toISOString(),
    generatedAt,
    ageMs,
    // TWO CLOCKS AGAIN, and for the same reason as the old board's tickAt/generatedAt split:
    //   ageMs        — how old the SCAN is (structure: depth, VWAP/POC, quality, screening)
    //   framesAt/    — how old the FRAMES the decision just used are (the tick board, 5s)
    //   framesAgeMs
    // Without this the page could only imply that a decision made on a one-minute-old snapshot
    // was as fresh as one made on live ticks. It is not, and the difference is the whole point.
    framesAt: liveFrames.at,
    framesAgeMs: liveFrames.ageMs,
    liveFrames: {
      overlaid: liveFrames.overlaid,
      rows: liveFrames.total,
      fromTicks: liveFrames.fromTicks,
      fromBars: liveFrames.fromBars,
      note: 'price evidence and the whole ROC ridge were taken from the live tick board before the decision was scored; structure still comes from the scan',
    },
    marketOpen: !!gb.marketOpen,
    market: gb.market || null,
    configHash: hash(),
    stamp: stamp(CONFIG),
    weightsLocked: CONFIG.score.weightsLocked,
    metricLocked: CONFIG.validation.locked,
    counts: {
      rows: snaps.length,
      deep: snaps.filter((s) => s.depth === 'deep').length,
      blocked, watch, pass,
      // THE NEW ENGINE'S OWN DECISION COUNTS — separate from the GATE counts above, because a
      // WATCH gate and a SIGNAL decision are different questions and conflating them is what
      // made the old board read "0 BUY" over live positions.
      decided: {
        signal: items.filter((i) => i.score.status === 'SIGNAL').length,
        watch: items.filter((i) => i.score.status === 'WATCH').length,
        blocked: items.filter((i) => i.score.status === 'BLOCKED').length,
        long: items.filter((i) => i.score.status === 'SIGNAL' && i.score.direction === 'UP').length,
        short: items.filter((i) => i.score.status === 'SIGNAL' && i.score.direction === 'DOWN').length,
      },
    },
    provenance: adapter.provenanceSummary ? adapter.provenanceSummary(snaps) : null,
    notices: [
      'THIS PAGE DECIDES NOTHING. It is a shadow view: the old engine is the only thing trading.',
      'V3 Phase 11 (the 58-point score) is not built, so there is no new score here — only gates and evidence groups.',
      'Candle context is DISPLAY-ONLY per spec Section 17 and contributes 0 points.',
      'POC / value area / VWAP are scored location evidence (spec Section 14). Camarilla zone is display-only.',
    ],
    items,
  };
  return payload;
}

function html(payload) {
  const data = JSON.stringify(payload);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>V3 Shadow Board — old beside new</title>
<style>
 :root{--bg:#0b0e13;--panel:#131822;--panel2:#0f141d;--line:#232c3a;--txt:#dbe2ee;--dim:#8b96a8;--acc:#4da3ff;
       --up:#2ecc71;--dn:#ff5c5c;--warn:#ffb020;--block:#ff4d6d;--ok:#37d67a;}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 header{position:sticky;top:0;z-index:5;background:linear-gradient(180deg,#101725,#0d131d);border-bottom:1px solid var(--line);padding:10px 14px}
 h1{margin:0 0 4px;font-size:15px;letter-spacing:.2px}
 h1 span{color:var(--acc)}
 .sub{color:var(--dim);font-size:11.5px}
 .banner{margin:8px 0 0;padding:8px 10px;border:1px solid #3a2f12;background:#1b1608;border-radius:6px;color:#ffd88a;font-size:11.5px}
 .banner b{color:#ffc44d}
 .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
 .pill{border:1px solid var(--line);background:var(--panel2);border-radius:99px;padding:3px 9px;font-size:11px;color:var(--dim)}
 .pill b{color:var(--txt)}
 input,select{background:var(--panel2);border:1px solid var(--line);color:var(--txt);border-radius:6px;padding:5px 8px;font-size:12px}
 table{width:100%;border-collapse:collapse}
 th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-variant-numeric:tabular-nums}
 th{position:sticky;top:0;background:#0f141d;z-index:4;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
 tbody tr:hover{background:#151c28;cursor:pointer}
 td.sym{font-weight:600}
 .tag{display:inline-block;border-radius:4px;padding:1px 6px;font-size:10.5px;border:1px solid var(--line);color:var(--dim)}
 .s-BLOCKED{color:#fff;background:#5c1730;border-color:#8c2445}
 .s-WATCH{color:#1d1400;background:#ffc44d;border-color:#ffc44d}
 .s-PASS{color:#06240f;background:#37d67a;border-color:#37d67a}
 .pos{color:var(--up)} .neg{color:var(--dn)} .flat{color:var(--dim)}
 .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 details{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:0 0 8px;padding:10px 12px}
 summary{cursor:pointer;font-weight:600;color:var(--acc)}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:8px}
 .card{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
 .card h3{margin:0 0 6px;font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
 .kv{display:flex;justify-content:space-between;gap:10px;padding:1.5px 0;font-size:12px}
 .kv span:first-child{color:var(--dim)}
 ul{margin:4px 0 0 16px;padding:0}
 li{font-size:11.5px;color:#c3ccdb;margin:2px 0}
 .note{color:var(--dim);font-size:11px;margin-top:6px}
 footer{color:var(--dim);font-size:11px;padding:14px;border-top:1px solid var(--line)}
</style></head><body>
<header>
  <h1>V3 SHADOW BOARD <span>· old engine beside the new layers</span></h1>
  <div class="sub">
    config <b class="mono">${payload.configHash}</b>
    · weightsLocked <b>${payload.weightsLocked}</b> · metricLocked <b>${payload.metricLocked}</b>
    · GB scan <b>${payload.generatedAt || 'n/a'}</b>
    · data age <b id="age"></b>
    · market ${payload.marketOpen ? '<b class="pos">OPEN</b>' : '<b class="neg">CLOSED</b>'}
    ${payload.market ? '· mood <b>' + (payload.market.mood || '') + '</b>' : ''}
  </div>
  <div class="banner">
    <b>Shadow only — this page decides nothing.</b> The old engine is the only thing trading.
    V3 Phase 11 (the 58-point score) is not built yet, so there is <b>no new score</b> here:
    these are the gate verdicts and the evidence groups that will feed it.
    <ul>${payload.insights.whyNoSignal.map((w) => '<li>' + w + '</li>').join('')}</ul>
  </div>
  <div class="bar">
    <input id="q" placeholder="filter symbol…" size="16"/>
    <select id="st"><option value="">all gate statuses</option><option>BLOCKED</option><option>WATCH</option><option>PASS</option></select>
    <select id="dp"><option value="">all depths</option><option value="deep">deep</option><option value="tick-only">tick-only</option></select>
    <select id="srt">
      <option value="lean">sort: lean (evidence direction)</option>
      <option value="roc30">sort: 30s ROC</option>
      <option value="roc1m">sort: 1m ROC</option>
      <option value="vol">sort: volume ratio</option>
      <option value="flow">sort: flow delta</option>
      <option value="price">sort: price change</option>
      <option value="sym">sort: symbol</option>
    </select>
    <span class="pill">rows <b>${payload.counts.rows}</b></span>
    <span class="pill">deep <b>${payload.counts.deep}</b></span>
    <span class="pill" style="border-color:#8c2445">BLOCKED <b>${payload.counts.blocked}</b></span>
    <span class="pill" style="border-color:#ffc44d">WATCH <b>${payload.counts.watch}</b></span>
    <span class="pill" style="border-color:#37d67a">PASS <b>${payload.counts.pass}</b></span>
    <span id="shown" class="pill">showing <b>0</b></span>
  </div>
</header>
<main style="padding:12px">
<div id="cards"></div>
<table>
  <thead><tr>
    <th>Lean</th><th>Symbol</th><th>Side · reason for the lean</th>
    <th>ROC ladder 10s→15m</th><th>Volume · flow</th><th>Price · day %</th>
    <th>V3 gates</th><th>Old engine</th>
  </tr></thead>
  <tbody id="tb"></tbody>
</table>
</main>
<footer>
  Built ${payload.builtAt} from the same GB output the live board reads, through the read-only adapter.
  Regenerate with <span class="mono">node gb_scoring_v2/ui/build-board.js</span>.
  Rejected/gate-capped rows are listed here on purpose: recording and showing the candidates the old
  engine drops is the only way the blocked audit (spec Section 21.4) can ever be answered.
</footer>
<script>
const DATA = ${data};
const $ = (s) => document.querySelector(s);
const n = (v, d) => (v == null ? '—' : (typeof v === 'number' ? v.toFixed(d == null ? 2 : d) : v));
const cls = (v) => (v == null ? 'flat' : v > 0 ? 'pos' : v < 0 ? 'neg' : 'flat');
// A gap OBJECT can exist while its fields are null: GB allocates the block before
// it has the candles to fill it. Treating a present container as "we have a gap"
// printed undefined on the first build, so the check is on the VALUE, not the block.
function gapCell(c){
  const g = c.gap;
  if (!g || g.openPct == null) return 'not on the row';
  return (g.dir || '?') + ' ' + n(g.openPct, 2) + '%' + (g.state ? ' · ' + g.state : '');
}
function ageStr(ms){
  if (ms == null) return 'n/a';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'live';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
$('#age').textContent = ageStr(DATA.ageMs);
// LEAN ARROW: ▲ up, ▼ down, ◆ mixed (strong evidence both ways cancels), · none.
// Strength bars show how MANY of the five evidence groups contributed.
function leanCell(it){
  const v = it.lean ? it.lean.value : 0, k = it.lean ? it.lean.parts : 0;
  if (!k) return '<span class="flat">·</span><div class="note">no evidence</div>';
  const arrow = Math.abs(v) < 8 ? '◆' : (v > 0 ? '▲' : '▼');
  const cl = Math.abs(v) < 8 ? 'flat' : (v > 0 ? 'pos' : 'neg');
  return '<span class="' + cl + '" style="font-size:15px">' + arrow + '</span>'
    + '<div class="mono ' + cl + '">' + (v > 0 ? '+' : '') + v + '</div>'
    + '<div class="note">' + k + '/5 groups</div>';
}
function rocCell(f){
  // One compact line, ladder order, each with its sign colour. Missing = —.
  const items = [[f.roc10,'10s'],[f.roc20,'20s'],[f.roc30,'30s'],[f.roc1m,'1m'],[f.roc3m,'3m'],[f.roc5m,'5m'],[f.roc15m,'15m']];
  return items.map(([v,k]) =>
    '<span class="mono ' + cls(v) + '">' + k + ' ' + (v==null?'—':(v>0?'+':'')+v) + '</span>').join(' ');
}
function volFlowCell(f){
  const bits = [];
  if (f.volume != null) bits.push('vol <span class="mono">' + Math.round(f.volume/1000) + 'k</span>');
  if (f.volX != null) bits.push('<span class="mono">' + f.volX + 'x</span>');
  if (f.flowBias != null) bits.push('Δ <span class="mono ' + cls(f.flowBias) + '">' + (f.flowBias>0?'+':'') + f.flowBias + '</span>');
  if (f.rawBuyQty != null && f.rawSellQty != null)
    bits.push('<span class="pos">B ' + Math.round(f.rawBuyQty/1000) + 'k</span>/<span class="neg">S ' + Math.round(f.rawSellQty/1000) + 'k</span>');
  if (f.flowInferred) bits.push('<span class="note">inferred</span>');
  return bits.join(' · ') || '—';
}
function rowHtml(it){
  const o = it.old, g = it.gates, f = it.proto;
  const oldTxt = [o.engine, o.score != null ? 'score ' + o.score : null, o.signal].filter(Boolean).join(' · ');
  return '<td>' + leanCell(it) + '</td>'
    + '<td class="sym">' + it.symbol + '<div class="tag">' + it.depth + '</div></td>'
    + '<td class="note" style="max-width:260px">' + (it.reasonFor || '—') + '</td>'
    + '<td>' + rocCell(f) + '</td>'
    + '<td>' + volFlowCell(f) + '</td>'
    + '<td class="mono">' + n(it.price, 2) + '</td>'
    + '<td><span class="tag s-' + g.status + '">' + g.status + '</span>'
      + (g.blockedBy ? '<div class="tag" style="border-color:#8c2445">' + g.blockedBy + '</div>' : '')
      + '<div class="note">' + (g.reasons[0] || '') + '</div></td>'
    + '<td class="note">' + oldTxt + '</td>';
}
function detailHtml(it){
  const g = it.gates, m = it.momentum, l = it.location, c = it.candles, s = it.screener, p = it.proto;
  const kv = (a, b) => '<div class="kv"><span>' + a + '</span><span class="mono">' + b + '</span></div>';
  return '<summary>' + it.symbol + ' — why the two views differ</summary>'
    + '<div class="grid">'
    + '<div class="card"><h3>Old engine</h3>'
      + kv('engine', it.old.engine || '—') + kv('score', it.old.score == null ? '—' : it.old.score)
      + kv('signal', it.old.signal || '—') + kv('label', it.old.label || '—')
      + '<div class="note">This is the reading the live board is showing.</div></div>'
    + '<div class="card"><h3>V3 gates</h3>'
      + kv('status', g.status) + kv('blocked by', g.blockedBy || '—') + kv('coverage', g.coverage == null ? '—' : g.coverage)
      + '<ul>' + g.reasons.map((r) => '<li>' + r + '</li>').join('') + '</ul>'
      + (g.risks.length ? '<div class="note">risks: ' + g.risks.join(', ') + '</div>' : '')
      + (g.notRunnable.length ? '<div class="note">not runnable (source absent): ' + g.notRunnable.join(', ') + '</div>' : '')
      + '</div>'
    + '<div class="card"><h3>Momentum</h3>' + kv('fast', n(m.fast, 3)) + kv('structural', n(m.structural, 3))
      + kv('acceleration', n(m.acceleration, 3)) + kv('prior move', n(m.priorMove, 3))
      + '<div class="note">' + m.text + '</div>'
      + (m.missing.length ? '<div class="note">missing: ' + m.missing.join(', ') + '</div>' : '') + '</div>'
    + '<div class="card"><h3>Location — POC is scored here</h3>'
      + kv('value (aligned)', n(l.value, 3)) + kv('raw', n(l.raw, 3)) + kv('agreement', l.agreement == null ? '—' : l.agreement)
      + kv('POC', n(l.poc, 2) + ' (' + (l.pocDistPct == null ? '—' : n(l.pocDistPct, 2) + '%') + ')')
      + kv('VWAP', n(l.vwap, 2) + ' (' + (l.vwapDistPct == null ? '—' : n(l.vwapDistPct, 2) + '%') + ')')
      + kv('VAH / VAL', n(l.vah, 2) + ' / ' + n(l.val, 2))
      + '<ul>' + l.parts.map((x) => '<li>' + x.name + ' ' + n(x.value, 3) + ' — ' + (x.detail || '') + '</li>').join('') + '</ul>'
      + '<div class="note">DISPLAY-ONLY: Camarilla ' + (l.display.camZone || '—') + ', day-range position ' + (l.display.posInRange == null ? '—' : l.display.posInRange) + '</div>'
      + (l.nearLevels.length ? '<div class="note">at a level: ' + l.nearLevels.map((x) => x.level + ' ' + x.distancePct + '%').join(', ') + '</div>' : '')
      + '</div>'
    + '<div class="card"><h3>Candles — gap between candles</h3>'
      + (c.gap && c.gap.openPct != null
        ? kv('gap', (c.gap.dir || '?') + ' ' + n(c.gap.openPct, 2) + '%')
          + kv('fill', (c.gap.fillPct == null ? '—' : c.gap.fillPct + '%') + ' → ' + (c.gap.state || ''))
          + kv('size vs ATR', n(c.gap.sizeVsAtrX, 2) + 'x')
        : kv('gap', (c.gap ? 'block present but EMPTY on the row' : 'absent from the row')))
      + kv('pattern', c.pattern || '—') + kv('candle trend', n(c.trendValue, 3) + ' (' + (c.trendAgreement == null ? '—' : Math.round(100 * c.trendAgreement) + '% agree') + ')')
      + kv('points', c.points + ' (display-only)')
      + '<div class="note">' + c.text + '</div>'
      + (c.gap && c.gap.obstacles && c.gap.obstacles.length ? '<div class="note">gap magnet: ' + c.gap.obstacles.map((o) => o.side + ' ' + o.pct + '%').join(', ') + '</div>' : '')
      + '</div>'
    + '<div class="card"><h3>Raw inputs — the full ladder</h3>'
      + kv('ROC 10s / 15s / 20s / 30s', n(p.roc10, 2) + ' / ' + n(p.roc15s, 2) + ' / ' + n(p.roc20, 2) + ' / ' + n(p.roc30, 2))
      + kv('ROC 1m / 3m / 5m', n(p.roc1m, 2) + ' / ' + n(p.roc3m, 2) + ' / ' + n(p.roc5m, 2))
      + kv('ROC 15m / 60m', n(p.roc15m, 2) + ' / ' + n(p.roc60m, 2))
      + kv('volume', p.volume == null ? '—' : Math.round(p.volume / 1000) + 'k · ' + n(p.volX, 2) + 'x ratio')
      + kv('flow Δ (inferred?)', n(p.flowBias, 3) + (p.flowInferred ? '  · INFERRED, not observed' : ''))
      + kv('buy / sell qty', (p.rawBuyQty == null ? '—' : Math.round(p.rawBuyQty / 1000) + 'k') + ' / ' + (p.rawSellQty == null ? '—' : Math.round(p.rawSellQty / 1000) + 'k'))
      + kv('buy / sell pressure', n(p.buyPressure, 3) + ' / ' + n(p.sellPressure, 3))
      + kv('flow bias', n(p.flowBias, 3)) + kv('volume x', n(p.volX, 2))
      + kv('ATR%', n(s.atrPct, 2)) + kv('20d avg vol', s.avgVol20 == null ? '—' : s.avgVol20.toLocaleString())
      + kv('market cap Cr', s.marketCapCr == null ? '—' : s.marketCapCr.toLocaleString())
      + kv('screening delay', s.delayedBy == null ? '—' : s.delayedBy + ' min')
      + kv('missing fields', p.missingCount) + '</div>'
    + '</div>';
}
const SORTS = {
  lean:   (a, b) => (b.lean.value - a.lean.value),
  roc30:  (a, b) => ((b.proto.roc30 || -99) - (a.proto.roc30 || -99)),
  roc1m:  (a, b) => ((b.proto.roc1m || -99) - (a.proto.roc1m || -99)),
  vol:    (a, b) => ((b.proto.volX || 0) - (a.proto.volX || 0)),
  flow:   (a, b) => ((b.proto.flowBias || 0) - (a.proto.flowBias || 0)),
  price:  (a, b) => ((b.screener.dayPct || 0) - (a.screener.dayPct || 0)),
  sym:    (a, b) => a.symbol.localeCompare(b.symbol),
};
let visible = DATA.items;
function render(){
  const q = $('#q').value.trim().toUpperCase(), st = $('#st').value, dp = $('#dp').value, srt = $('#srt').value || 'lean';
  visible = DATA.items.filter((it) =>
    (!q || it.symbol.includes(q)) && (!st || it.gates.status === st) && (!dp || it.depth === dp));
  visible.sort(SORTS[srt] || SORTS.lean);
  $('#shown').innerHTML = 'showing <b>' + visible.length + '</b>';
  const tb = $('#tb');
  tb.innerHTML = visible.slice(0, 600).map((it) =>
    '<tr data-i="' + DATA.items.indexOf(it) + '">' + rowHtml(it) + '</tr>').join('');
  tb.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
    const it = DATA.items[+tr.dataset.i];
    const host = $('#cards');
    const d = document.createElement('details');
    d.open = true; d.innerHTML = detailHtml(it);
    host.prepend(d);
    d.scrollIntoView({ block: 'nearest' });
  }));
}
['#q', '#st', '#dp', '#srt'].forEach((s) => $(s).addEventListener('input', render));
render();
</script>
</body></html>`;
}

if (require.main === module) {
  const payload = build();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html(payload));
  const jsonOut = out.replace(/\.html$/, '.json');
  fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2));
  console.log('shadow board: ' + out);
  console.log('payload:      ' + jsonOut);
  console.log('rows ' + payload.counts.rows + ' · deep ' + payload.counts.deep
    + ' · BLOCKED ' + payload.counts.blocked + ' · WATCH ' + payload.counts.watch + ' · PASS ' + payload.counts.pass);
  console.log('config ' + payload.configHash + ' · GB scan ' + payload.generatedAt
    + ' · age ' + (payload.ageMs == null ? 'n/a' : Math.round(payload.ageMs / 1000) + 's'));
}

module.exports = { build, directionOf, html };

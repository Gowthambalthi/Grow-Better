/**
 * gb_scoring_v2/record-session.js — THE DAILY RECORDER RUNNER.
 *
 * V3 spec Section 7.1: "Append-only log of raw feed messages as received, with
 * receipt timestamps, one file set per session. Also log the old engine's output
 * at each scan." Phase 0 done-when: "raw recorder running daily."
 *
 * WHY A SEPARATE PROCESS. The isolation rule (Section 2) forbids editing existing
 * backend files, so there is no in-process hook available. This runner is a
 * standalone OBSERVER: it polls the artifact GB already writes and records it.
 * That is also the safer arrangement -- if the recorder crashes or hangs, the
 * trading server never notices, because they share no memory and no write path.
 *
 *   node gb_scoring_v2/record-session.js            # watch (polls every 5s)
 *   node gb_scoring_v2/record-session.js --once     # one pass, then exit
 *   node gb_scoring_v2/record-session.js --sessions # list recorded sessions
 *   node gb_scoring_v2/record-session.js --prune    # apply the retention window
 */
const { loadGB, snapshots, provenanceSummary } = require('./adapter');
const { recorder, listSessions, readSession, prune } = require('./recorder');
const { hash, CONFIG } = require('./config/index');   // explicit: a draft config.js sits beside config/

const POLL_MS = Math.max(1000, Number(process.env.GB_V2_POLL_MS || 5000));

function stamp() {
  const d = new Date(Date.now() + (5.5 * 60 + new Date().getTimezoneOffset()) * 60000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}

let lastGeneratedAt = null;

/** One observation: read -> snapshot -> record. Returns a small status object. */
function pass(verbose = true) {
  const gb = loadGB();
  if (!gb.ok) { if (verbose) console.log('[' + stamp() + '] gb unavailable: ' + gb.reason); return { ok: false }; }
  // Don't re-record the same scan. The scan is republished unchanged between
  // cycles; recording it twice would silently double-weight one moment in time.
  if (gb.generatedAt && gb.generatedAt === lastGeneratedAt) {
    if (verbose) console.log('[' + stamp() + '] same scan (' + gb.generatedAt + '), skipped');
    return { ok: true, skipped: true };
  }
  lastGeneratedAt = gb.generatedAt;
  const snaps = snapshots(gb);
  const prov = provenanceSummary(snaps);
  recorder.recordScan(gb, snaps, { provenance: prov.counts, configHash: hash() });
  if (verbose) {
    console.log('[' + stamp() + '] recorded ' + gb.rows.length + ' rows / ' + snaps.length + ' snapshots'
      + '  age ' + Math.round((gb.ageMs || 0) / 1000) + 's'
      + '  marketOpen ' + gb.marketOpen
      + '  config ' + hash()
      + '  queue ' + recorder.queue.length);
  }
  return { ok: true, rows: gb.rows.length, snapshots: snaps.length, provenance: prov };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--sessions')) {
    for (const f of listSessions()) console.log(f + '  ' + readSession(f).length + ' records');
    return;
  }
  if (args.includes('--prune')) { console.log('pruned ' + prune() + ' session file(s) older than ' + CONFIG.recording.retentionDays + 'd'); return; }

  console.log('GB V2 recorder  ·  config ' + hash() + '  ·  file ' + recorder.file);
  if (args.includes('--once')) { pass(); recorder.stop(); console.log(JSON.stringify(recorder.stats(), null, 1)); return; }

  pass();
  const timer = setInterval(() => pass(), POLL_MS);
  const bye = () => { clearInterval(timer); recorder.stop(); console.log('\n' + JSON.stringify(recorder.stats(), null, 1)); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { pass, POLL_MS };

if (require.main === module) main();

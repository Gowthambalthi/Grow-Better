/**
 * gb_scoring_v2/recorder/index.js — THE RAW APPEND-ONLY RECORDER.
 *
 * V3 spec Section 2 rule: "Raw snapshot recording starts before the engine exists."
 * Section 7.1:
 *   - append-only log, one file set per session
 *   - ALSO log the old engine's output at each scan
 *   - "Asynchronous writer so recording never slows the live path."
 *   - retention policy defined up front
 *
 * Design consequences taken seriously:
 *   - The write path is fire-and-forget. Recording is an OBSERVER of the live system;
 *     if it backs up, it drops and counts rather than ever applying back-pressure
 *     (spec: "recording never slows the live path").
 *   - One file per session, so a session can be replayed in isolation and a corrupt
 *     file can be discarded without losing the others.
 *   - Every record carries the config hash (spec Section 2 rule 5), so an outcome
 *     recorded today can be reproduced against the exact numbers that produced it.
 *   - Appends are serialized through a queue and batched on a timer, because
 *     fs.appendFile per row at 800 rows a scan is a needless syscall storm.
 */
const fs = require('fs');
const path = require('path');
// Explicit path: a superseded draft config.js sits beside the V3 config/ directory
// and Node resolves a file before a directory.
const { stamp, CONFIG } = require('../config/index');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, CONFIG.recording.dir);

function pad(n) { return String(n).padStart(2, '0'); }
function istParts(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  return { y: ist.getFullYear(), m: pad(ist.getMonth() + 1), d: pad(ist.getDate()), h: pad(ist.getHours()), mi: pad(ist.getMinutes()), s: pad(ist.getSeconds()) };
}
/** The session's IST date -- the trading day, not the UTC day. */
function sessionDay(d = new Date()) { const p = istParts(d); return p.y + '-' + p.m + '-' + p.d; }

class RawRecorder {
  constructor(opts = {}) {
    this.dir = opts.dir || DIR;
    this.sessionDay = sessionDay();
    this.file = path.join(this.dir, 'raw_' + this.sessionDay + '.jsonl');
    this.queue = [];
    this.dropped = 0;
    this.written = 0;
    this.byType = {};
    this.timer = null;
    this.stopped = false;
    this.flushMs = opts.flushMs || CONFIG.recording.flushIntervalMs;
    this.maxQueue = opts.maxQueue || CONFIG.recording.writeQueueMax;
    this.stamp = stamp();
  }

  ensureDir() {
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) {}
  }

  /**
   * record(type, data) -- never throws, never blocks, never returns a promise the
   * caller must await. This is the whole contract: the live path calls it and moves on.
   */
  record(type, data) {
    if (this.stopped) return false;
    if (this.queue.length >= this.maxQueue) { this.dropped++; return false; }
    let line;
    try {
      line = JSON.stringify({ ts: Date.now(), ist: istParts().h + ':' + istParts().mi + ':' + istParts().s, type, ...this.stamp, data });
    } catch (e) {
      // A circular or unserializable payload is a bug, not a reason to stop recording.
      line = JSON.stringify({ ts: Date.now(), type, configHash: this.stamp.configHash, error: 'unserializable: ' + e.message });
    }
    this.queue.push(line);
    this.byType[type] = (this.byType[type] || 0) + 1;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
    return true;
  }

  /** Record one whole scan: the old engine's output AND the normalized snapshots. */
  recordScan(gb, snaps, extra = {}) {
    const ok = this.record('gb_scan', {
      generatedAt: gb && gb.generatedAt, ageMs: gb && gb.ageMs, marketOpen: gb && gb.marketOpen,
      market: gb && gb.market, counts: gb && gb.counts, pacing: gb && gb.pacing,
      rowCount: (gb && gb.rows ? gb.rows.length : 0), ...extra,
    });
    if (snaps && snaps.length) this.record('snapshot_batch', { count: snaps.length, snapshots: snaps });
    return ok;
  }

  /** Batched async append. One write syscall per flush, not per record. */
  flush() {
    this.timer = null;
    if (!this.queue.length) return;
    const batch = this.queue.join('\n') + '\n';
    const n = this.queue.length;
    this.queue = [];
    this.ensureDir();
    fs.appendFile(this.file, batch, err => {
      if (err) { this.dropped += n; return; }
      this.written += n;
    });
  }

  /** Flush synchronously (tests, shutdown). The live path never calls this. */
  flushSync() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.queue.length) return this.written;
    const batch = this.queue.join('\n') + '\n';
    const n = this.queue.length;
    this.queue = [];
    this.ensureDir();
    try { fs.appendFileSync(this.file, batch); this.written += n; } catch (_) { this.dropped += n; }
    return this.written;
  }

  stop() { this.stopped = true; if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.flushSync(); }

  stats() { return { file: this.file, sessionDay: this.sessionDay, written: this.written, queued: this.queue.length, dropped: this.dropped, byType: this.byType, configHash: this.stamp.configHash }; }
}

// Read side: the replay harness and the baseline both consume these.
function listSessions(dir = DIR) {
  try { return fs.readdirSync(dir).filter(f => f.startsWith('raw_') && f.endsWith('.jsonl')).sort(); } catch (_) { return []; }
}

/** Parse one session file into records. Skips a torn final line rather than dying. */
function readSession(file) {
  const full = path.isAbsolute(file) ? file : path.join(DIR, file);
  const out = [];
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (_) { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* torn tail -- ignored on purpose */ }
  }
  return out;
}

/** Retention: delete session files older than the configured window. */
function prune(retentionDays = CONFIG.recording.retentionDays, dir = DIR) {
  const cutoff = Date.now() - retentionDays * 86400000;
  let removed = 0;
  for (const f of listSessions(dir)) {
    const m = /^raw_(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f);
    if (!m) continue;
    const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00Z');
    if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (_) {} }
  }
  return removed;
}

module.exports = { RawRecorder, recorder: new RawRecorder(), listSessions, readSession, prune, DIR, sessionDay };

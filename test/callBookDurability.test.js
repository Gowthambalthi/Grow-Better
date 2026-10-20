'use strict';

/**
 * THE DAY'S CALL BOOK MUST SURVIVE BOTH ENGINES WRITING IT.
 *
 * `data/orderflow/daily_calls_<date>.json` is written by TWO live engines — the minute order-flow
 * engine and the Sweep+FVG engine — because they share a journalDir and an id format. A writer that
 * serialises only its own in-memory calls therefore DELETES the other engine's calls on its next
 * arm or close, and it does it silently, which is the worst possible failure for a call history:
 * the owner's question is "what happened to the calls you gave me", and the answer would be "some
 * of them were never recorded".
 *
 * This is not hypothetical. On 2026-10-12 the Sweep+FVG signal journal holds five records at 11:24
 * and the book was rewritten at 19:29 by the minute engine; not one sweep record survives in it.
 *
 * Both directions are pinned here: the minute engine must carry over what it does not hold, and a
 * repeated save must not duplicate anything.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// The engine resolves its data directory at require time, so the sandbox must be declared first.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'callbook-durability-'));
process.env.GB_ORDERFLOW_DIR = DIR;

const liveEngine = require('../strategies/orderflow/liveMinuteEngine');

const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const bookFile = () => path.join(DIR, `daily_calls_${istToday()}.json`);

/** A Sweep+FVG record, as that engine writes it. */
const SWEEP_RECORD = {
  id: 'CALL-SAMBHV-TEST-001',
  engine: 'SWEEP_FVG',
  sector: 'INDUSTRIALS',
  symbol: 'SAMBHV',
  side: 'SHORT',
  status: 'WON',
  exitReason: 'target',
  netBps: 41,
};

function seedBook(records) {
  fs.writeFileSync(bookFile(), JSON.stringify(records, null, 2), 'utf8');
}

function readBook() {
  return JSON.parse(fs.readFileSync(bookFile(), 'utf8'));
}

test('the minute engine does not erase another engine\'s calls from the day\'s book', () => {
  seedBook([SWEEP_RECORD]);
  // This engine's own call, as it would hold it in memory.
  liveEngine.calls.set('CALL-TESTMOM-001', {
    id: 'CALL-TESTMOM-001', engine: 'OF_MOMENTUM', symbol: 'TESTMOM', side: 'LONG',
    status: 'ARMED', limitEntry: 100, stopLoss: 99, target: 102,
  });

  liveEngine.saveCalls();

  const book = readBook();
  const ids = book.map((c) => c.id).sort();
  assert.ok(ids.includes('CALL-SAMBHV-TEST-001'),
    'the sweep call is still in the day\'s record: ' + JSON.stringify(ids));
  assert.ok(ids.includes('CALL-TESTMOM-001'), 'and so is this engine\'s own call');
  assert.equal(book.length, 2, 'exactly two records — nothing doubled, nothing lost');

  // The sweep record must come back VERBATIM. A "merge" that rewrites another engine's fields is
  // just a quieter way of losing the record.
  const swept = book.find((c) => c.id === 'CALL-SAMBHV-TEST-001');
  assert.deepEqual(swept, SWEEP_RECORD, 'the carried record is untouched, field for field');

  // Saving again is the normal case — every arm and every close calls this — so it must be
  // idempotent. A merge that appends on each save would inflate the day's call count without bound.
  liveEngine.saveCalls();
  liveEngine.saveCalls();
  assert.equal(readBook().length, 2, 'repeated saves do not duplicate records');

  // This engine's own newer record must win over a stale copy of itself on disk.
  seedBook([SWEEP_RECORD, Object.assign({}, liveEngine.calls.get('CALL-TESTMOM-001'), { status: 'WON', exitReason: 'TARGET_HIT' })]);
  liveEngine.saveCalls();
  const after = readBook().find((c) => c.id === 'CALL-TESTMOM-001');
  assert.equal(after.status, 'ARMED',
    'the live in-memory record replaces the stale on-disk copy rather than both being written');
  assert.equal(readBook().length, 2, 'and the count is still two');
});

test('a call the engine holds only in memory is written even with no other engine present', () => {
  fs.rmSync(bookFile(), { force: true });
  liveEngine.saveCalls();
  const book = readBook();
  assert.equal(book.length, 1, 'the day is still recorded when this engine is the only writer');
  assert.equal(book[0].id, 'CALL-TESTMOM-001');
  assert.ok(fs.existsSync(bookFile()), 'the file exists at the path the history reader reads');
});

// ---------------------------------------------------------------------------
// A BOOK THAT CANNOT BE READ MUST NOT BE OVERWRITTEN
//
// This is how 2026-10-19's book came to be two bytes. The read/parse sat in a try/catch whose
// fallback was "this engine's own records", so a file that a SECOND writer was mid-way through —
// `writeFileSync` truncates its target before writing, and both live engines write this one path —
// made the reader fall back to its own empty map and write `[]` over the day. Six calls armed at
// 09:36 and every call the other engine had written were gone from the board and from the next
// restart's book: the owner's "why is my call book empty" asked exactly that.
// ---------------------------------------------------------------------------

test('an unreadable book is never overwritten, and both halves are preserved', () => {
  // A half-written document, exactly as a concurrent writer leaves it.
  const halfWritten = '["id": "CALL-SAMBHV-TEST-001", "symbol": "SAMBH';
  fs.writeFileSync(bookFile(), halfWritten, 'utf8');
  const before = fs.readFileSync(bookFile(), 'utf8');
  liveEngine.calls.set('CALL-TESTNEW-002', {
    id: 'CALL-TESTNEW-002', engine: 'OF_MOMENTUM', symbol: 'TESTNEW', side: 'LONG',
    status: 'ARMED', limitEntry: 50, stopLoss: 49, target: 52,
  });

  liveEngine.saveCalls();

  assert.equal(fs.readFileSync(bookFile(), 'utf8'), before,
    'the unreadable book is left BYTE FOR BYTE as it was — nothing is truncated over it');

  const files = fs.readdirSync(DIR);
  const corrupt = files.filter((f) => /^daily_calls_.*\.corrupt-/.test(f));
  const unmerged = files.filter((f) => /^daily_calls_.*\.unmerged-/.test(f));
  assert.equal(corrupt.length, 1, 'the half-written text is kept beside it: ' + JSON.stringify(files));
  assert.equal(unmerged.length, 1, 'and so is what this engine was trying to save');
  assert.equal(fs.readFileSync(path.join(DIR, corrupt[0]), 'utf8'), before,
    'the kept copy IS the unreadable text, so the day can be reconciled by hand');
  const saved = JSON.parse(fs.readFileSync(path.join(DIR, unmerged[0]), 'utf8'));
  assert.ok(saved.some((c) => c.id === 'CALL-TESTNEW-002'),
    'the unmerged copy holds the record the refusal could not write: ' + JSON.stringify(saved.map((c) => c.id)));
});

test('a later save still works once the book is readable again', () => {
  // The refusal must not wedge the engine for the rest of the session: repair the file (as an
  // operator would) and the next save merges and writes normally.
  seedBook([SWEEP_RECORD]);
  liveEngine.saveCalls();
  const ids = readBook().map((c) => c.id).sort();
  assert.deepEqual(ids, ['CALL-SAMBHV-TEST-001', 'CALL-TESTMOM-001', 'CALL-TESTNEW-002'],
    'the repaired book takes both engines\' records again, and nothing the engine holds is lost: ' + JSON.stringify(ids));
});

test('the write is atomic — no half-written book, and no temp file left behind', () => {
  seedBook([SWEEP_RECORD]);
  liveEngine.saveCalls();
  const leftovers = fs.readdirSync(DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [],
    'the temp file is renamed into place, never left for the other engine to read: ' +
    JSON.stringify(leftovers));
  // And the content it wrote is a complete document, not a prefix of one.
  assert.ok(Array.isArray(readBook()), 'the book parses after the rename');
});

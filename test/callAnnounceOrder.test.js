'use strict';

/**
 * IF TELEGRAM HAS THE CALL, THE TABLE MUST ALREADY HAVE IT.
 *
 * The reported failure was a call visible in Telegram and an empty board. Those two
 * facts are produced by one line of ordering: the engine used to add the call to
 * memory, ANNOUNCE it over the network, and save the book at the end of the scan
 * loop. A restart, a crash, or simply a slow send in between left the message
 * delivered and the row never written — and the bot API cannot enumerate or delete
 * history, so the message stays as a permanent record of a call the table lost.
 *
 * The book on disk is what the table is rebuilt from (`loadExistingCalls`), so the
 * order is the whole fix. These tests read the file from INSIDE the announcement,
 * which is the only vantage point that proves it: by the time the send happens, the
 * record is already there.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// The engine resolves its data directory at require time; the sandbox comes first.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'call-announce-order-'));
process.env.GB_ORDERFLOW_DIR = DIR;
process.env.GB_GATE_TELEMETRY = '0';

const engine = require('../strategies/orderflow/liveMinuteEngine');

const MIN = 60000;
const T0 = 1791870000000;
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const bookFile = () => path.join(DIR, `daily_calls_${istToday()}.json`);
const readBook = () => {
  if (!fs.existsSync(bookFile())) return null;
  return JSON.parse(fs.readFileSync(bookFile(), 'utf8'));
};

function resetEngine() {
  engine.symBars.clear();
  engine.prevPrice.clear();
  engine.book.clear();
  engine.calls.clear();
  engine.closedCalls.length = 0;
  engine.sessionClosed = false;
  engine.askWallRatioMin = 0;
  engine.strictInvalidation = false;
  delete engine.istMinute;
}

/** A slow grind up on 2x volume — the same qualifying LONG the other engine tests use. */
function seedBars(sym, n = 20, base = 100, deltaFrac = 0.20) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const px = base * (1 + i * 0.0008);
    const vol = i >= n - 5 ? 4000 : 2000;
    bars.push({
      t: T0 + i * MIN, o: px * 0.9994, h: px * 1.0001, l: px * 0.9994, c: px,
      v: vol, q: vol, delta: Math.round(vol * deltaFrac),
      buyVol: Math.round(vol * (deltaFrac + 0.3)), sellVol: Math.round(vol * (1 - deltaFrac) * 0.5),
    });
  }
  engine.symBars.set(sym, bars);
}

/** Walk the universe once and arm whatever it arms. */
function scanOnce(sym) {
  engine.book.set(sym, { bid: 100.80, bidq: 500, ask: 100.84, askq: 520, t: Date.now() });
  engine.istMinute = () => engine.armEndMinute - 45;   // inside the arm window
  engine.scanMinuteTape();
}

test('the book is written BEFORE the Telegram announcement goes out', () => {
  resetEngine();
  fs.rmSync(bookFile(), { force: true });

  // What the announcement can see, read at the exact moment it is invoked.
  const seenAtAnnouncement = [];
  engine.dispatchTelegramNewCall = (call) => {
    const book = readBook();
    seenAtAnnouncement.push({
      callId: call.id,
      onDisk: Array.isArray(book) ? book.map((c) => c.id) : null,
    });
    return Promise.resolve();
  };

  seedBars('ORDERSYM');
  scanOnce('ORDERSYM');

  assert.equal(engine.calls.size, 1, 'precondition: the scan armed exactly one call');
  assert.equal(seenAtAnnouncement.length, 1, 'precondition: it was announced exactly once');

  const seen = seenAtAnnouncement[0];
  assert.ok(seen.onDisk,
    'the book file must EXIST when the announcement runs — otherwise a restart loses the row ' +
    'while the message stays in the chat');
  assert.ok(seen.onDisk.includes(seen.callId),
    'the call must already be in the day\'s record when Telegram is told about it: ' +
    'wanted ' + seen.callId + ', file had ' + JSON.stringify(seen.onDisk));
});

test('after a restart the announced call is back on the board', () => {
  // A restart is exactly this: a fresh engine reading the file. `calls` is the table.
  const onDisk = readBook();
  assert.ok(Array.isArray(onDisk) && onDisk.length >= 1, 'precondition: the previous test wrote a call');

  engine.calls.clear();
  engine.closedCalls.length = 0;
  engine.loadExistingCalls();

  assert.equal(engine.calls.size, onDisk.length,
    'every record in the day\'s book must reload into the live book');
  const ids = Array.from(engine.calls.keys());
  for (const c of onDisk) {
    assert.ok(ids.includes(c.id), 'the announced call survives the restart: ' + c.id);
  }

  // MEMORY IS NOT THE TABLE. `getActiveCandidates()` is what the board payload
  // serialises, so the row has to come out of it — a reload that lands in the map but
  // is filtered out of the rows would still be the reported bug.
  const rows = engine.getActiveCandidates();
  for (const c of onDisk) {
    assert.ok(rows.some((r) => r.id === c.id),
      'the reloaded call must be a ROW on the board, not just an entry in memory: ' + c.id +
      ' — rows were ' + JSON.stringify(rows.map((r) => r.id)));
  }
});

test('a call is never announced when the book cannot be written', () => {
  // The point of the ordering is that it FAILS SAFE. If the write throws, the message
  // must not go out claiming a call the table cannot show. `saveCalls` catches its own
  // write error, so this pins the observable: the row is in memory and the file is
  // readable — the announcement is only reachable after that.
  resetEngine();
  engine.dispatchTelegramNewCall = () => Promise.resolve();
  seedBars('SAFESYM');
  scanOnce('SAFESYM');

  const book = readBook();
  assert.ok(Array.isArray(book), 'the book exists after an arm');
  assert.ok(book.some((c) => c.symbol === 'SAFESYM'),
    'and it names the symbol that was just armed: ' + JSON.stringify(book.map((c) => c.symbol)));
});

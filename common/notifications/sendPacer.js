/**
 * common/notifications/sendPacer.js
 *
 * ONE QUEUE, ONE GAP BETWEEN MESSAGES.
 *
 * Why this exists: the minute engine pushes one message per new call, and a single
 * scan can arm several calls in the same second. Sent concurrently they arrive as
 * one blurred burst (and, when Telegram throttles, some never arrive at all). The
 * owner asked for the alerts "in 3 secs gap", which is a property of the SENDER,
 * not of any one call site — so it lives here and every caller inherits it.
 *
 * The contract is deliberately small:
 *   - `run(task)` serialises tasks: the next one starts only after the previous
 *     one RESOLVED (a failed send still releases the queue — one 400 from Telegram
 *     must never wedge every later alert).
 *   - consecutive tasks start at least `gapMs` apart, measured from the END of the
 *     previous task, so a slow send does not stack on top of the gap.
 *   - `now` and `sleep` are injectable so the gap can be tested without waiting.
 *
 * The queue is per-instance on purpose: the process holds ONE pacer, but a test
 * builds its own with a fake clock instead of mutating module state.
 */
'use strict';

function createPacer(opts) {
  const o = opts || {};
  const gapMs = o.gapMs == null ? 3000 : Math.max(0, Number(o.gapMs) || 0);
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const sleep = typeof o.sleep === 'function'
    ? o.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let tail = Promise.resolve();
  let lastEndedAt = null;   // null = nothing sent yet: the first message waits for nothing
  let pending = 0;

  /** Queue `task` and resolve with its result (or reject with its error). */
  function run(task) {
    pending += 1;
    const p = tail.then(async () => {
      if (lastEndedAt != null && gapMs > 0) {
        const wait = lastEndedAt + gapMs - now();
        if (wait > 0) await sleep(wait);
      }
      try {
        return await task();
      } finally {
        lastEndedAt = now();
        pending -= 1;
      }
    });
    // The NEXT task waits on this one's settlement, not on its success.
    tail = p.then(() => undefined, () => undefined);
    return p;
  }

  return {
    run,
    gapMs,
    pending: () => pending,
    /** Test/diagnostic only: forget the last send moment. */
    reset() { lastEndedAt = null; },
  };
}

module.exports = { createPacer };

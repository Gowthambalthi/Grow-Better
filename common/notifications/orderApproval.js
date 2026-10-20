/**
 * common/notifications/orderApproval.js — AN ORDER THAT HAS NOT HAPPENED YET.
 *
 * THE POINT. A press on the page must not reach the broker by itself. It becomes a PROPOSAL: a
 * sized order carrying its stop and target, held here and offered on Telegram, and nothing is sent
 * until a human says yes. That inversion is the whole feature — the press expresses intent, the
 * approval is the decision.
 *
 * THREE THINGS THIS HAS TO GET RIGHT, and each one is a way money can be lost:
 *
 *  1. ONE DECISION ONLY. A double tap on a Telegram button delivers two callback_query updates for
 *     the same order. Approving twice would buy twice. `decide` is therefore a one-way transition:
 *     the first call wins, every later call is told `already-decided` and returns the state it was
 *     already left in. This is the property the tests exist for.
 *
 *  2. A PROPOSAL GOES STALE. A price that was reasonable five minutes ago is not a price anymore,
 *     so every proposal carries an expiry and an expired one cannot be approved. The default is
 *     short on purpose: a confirmation that outlives its level is a way to buy the wrong thing.
 *
 *  3. IT SURVIVES A RESTART. The server restarts on its own (it did on 2026-10-19 at 09:51), and a
 *     proposal held only in memory would vanish while the Telegram message still sat in the chat —
 *     the operator would tap ✅ on an order the process no longer knows about. So the store is
 *     written to disk on every transition and read back at boot.
 *
 * Everything here is pure: the clock is injected, the file path is injectable, and no network call
 * is made. The Telegram side lives in telegramApprovals.js and the broker side in Server.js, so the
 * state machine that decides whether a rupee may move is testable without either.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** PENDING while it is still a choice; the rest are terminal. */
const STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
});

let seq = 0;

/**
 * A short, human-typeable id. The operator may have to type it ("yes A7K2") if buttons are
 * unavailable, so it is uppercase base-36 and short — but it also has to stay unique across a
 * restart, which is why it mixes the clock in rather than counting from zero.
 */
function makeId(nowMs, symbol) {
  const t = Math.floor(nowMs / 1000).toString(36).toUpperCase().slice(-4);
  const n = (seq++ % 36).toString(36).toUpperCase();
  const s = String(symbol || 'X').replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || 'X';
  return s + t + n;
}

/** The identity of a proposal's ECONOMIC content, used to refuse a duplicate press. */
function proposalKey(p) {
  return [p.symbol, p.side, p.entry, p.stop, p.target, p.quantity].join('|');
}

/**
 * createApprovalStore({ file, now }) → { create, decide, get, list, pending, reload }
 *
 * `file` of null keeps everything in memory (a test, or a replay). `now` is a function so expiry is
 * tested without waiting five minutes.
 */
function createApprovalStore({ file = null, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  let items = [];

  function reload() {
    if (!file) { items = []; return items; }
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = Array.isArray(raw) ? raw : [];
    } catch (_) {
      // A missing or half-written file is not a reason to refuse to work: an empty store can only
      // mean "nothing is waiting", and any live proposal it lost is already unapprovable in memory.
      items = [];
    }
    return items;
  }

  function persist() {
    if (!file) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(items, null, 2));
      return true;
    } catch (e) {
      console.error('[orderApproval] could not write approvals:', e.message);
      return false;
    }
  }

  /** Mark anything past its expiry before it is read, so no caller has to remember to. */
  function sweep(nowMs) {
    let changed = false;
    for (const it of items) {
      if (it.status === STATUS.PENDING && nowMs >= it.expiresAt) {
        it.status = STATUS.EXPIRED;
        it.decidedAt = null;
        changed = true;
      }
    }
    if (changed) persist();
    return changed;
  }

  function create(proposal, { nowMs = now(), ttl = ttlMs } = {}) {
    sweep(nowMs);

    // A DUPLICATE PRESS IS NOT A SECOND ORDER. If the same proposal is already waiting, the caller
    // gets that one back instead of a new message and a second chance to buy the same thing twice.
    const key = proposalKey(proposal);
    const dupe = items.find((it) => it.status === STATUS.PENDING && it.key === key);
    if (dupe) return { ok: true, duplicate: true, approval: dupe };

    const approval = {
      id: makeId(nowMs, proposal.symbol),
      key,
      status: STATUS.PENDING,
      proposal,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: nowMs + ttl,
      decidedAt: null,
      channel: null,
      result: null,
    };
    // The id is short enough to collide on a busy desk; re-roll rather than overwrite a live order.
    while (items.some((it) => it.id === approval.id)) approval.id = makeId(nowMs + (seq + 1), proposal.symbol);
    items.push(approval);
    persist();
    return { ok: true, duplicate: false, approval };
  }

  function get(id) {
    sweep(now());
    return items.find((it) => it.id === id) || null;
  }

  function list({ status = null } = {}) {
    sweep(now());
    return status ? items.filter((it) => it.status === status) : items.slice();
  }

  function pending() {
    return list({ status: STATUS.PENDING });
  }

  /**
   * The one-way transition. Returns the state it ended in, always — never throws on a second
   * decision, because the second caller (a double tap) still needs to be answered.
   */
  function decide(id, decision, { nowMs = now(), channel = null } = {}) {
    sweep(nowMs);
    const it = items.find((x) => x.id === id);
    if (!it) return { ok: false, status: 'unknown', problems: ['no proposal with id ' + id] };
    if (it.status !== STATUS.PENDING) {
      return {
        ok: false,
        status: it.status,
        approval: it,
        problems: [it.status === STATUS.EXPIRED
          ? 'this proposal expired at ' + new Date(it.expiresAt).toISOString() + ' and can no longer be approved'
          : 'this proposal was already ' + it.status.toLowerCase()],
      };
    }
    const wants = String(decision || '').toLowerCase();
    if (wants === 'approve' || wants === 'yes') {
      it.status = STATUS.APPROVED;
    } else if (wants === 'cancel' || wants === 'no') {
      it.status = STATUS.CANCELLED;
    } else {
      return { ok: false, status: it.status, approval: it, problems: ['decision must be approve or cancel, got "' + decision + '"'] };
    }
    it.decidedAt = new Date(nowMs).toISOString();
    it.channel = channel;
    persist();
    return { ok: true, status: it.status, approval: it };
  }

  /** Record what the broker did with an approved proposal, so the message can be edited to say it. */
  function settle(id, { status = STATUS.FAILED, result = null, nowMs = now() } = {}) {
    const it = items.find((x) => x.id === id);
    if (!it) return null;
    it.status = status;
    it.result = result;
    it.settledAt = new Date(nowMs).toISOString();
    persist();
    return it;
  }

  reload();
  return { create, decide, get, list, pending, settle, reload, STATUS };
}

module.exports = {
  createApprovalStore,
  proposalKey,
  makeId,
  DEFAULT_TTL_MS,
  STATUS,
  // The server and the Telegram poller both need ONE store, or a click could be checked against a
  // different list than the one the press wrote to.
  defaultStore: createApprovalStore({
    file: process.env.GB_APPROVALS_FILE || path.join(__dirname, '..', '..', 'data', 'terminal', 'order_approvals.json'),
  }),
};

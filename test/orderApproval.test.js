/**
 * test/orderApproval.test.js
 *
 * The store decides whether a rupee is allowed to move, so the tests pin the states rather than the
 * happy path: a double tap must buy ONCE, an expired proposal must not be approvable, and a
 * restart must not leave a Telegram message approving an order the process has forgotten. The clock
 * is injected, so "five minutes later" is a number rather than a wait.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApprovalStore, proposalKey, STATUS } = require('../common/notifications/orderApproval');

const PROPOSAL = {
  symbol: 'BANKINDIA', side: 'BUY', entry: 135.49, stop: 134.74, target: 136.61, quantity: 8,
};

function freshStore(opts = {}) {
  let clock = 1_700_000_000_000;
  const store = createApprovalStore({ file: null, now: () => clock, ...opts });
  return { store, tick: (ms) => { clock += ms; }, at: () => clock };
}

test('a press becomes a PENDING proposal with an expiry, not an order', () => {
  const { store, at } = freshStore();
  const { ok, approval } = store.create(PROPOSAL);
  assert.equal(ok, true);
  assert.equal(approval.status, STATUS.PENDING);
  assert.equal(approval.proposal.quantity, 8, 'the sized proposal is carried as-is');
  assert.ok(approval.expiresAt > at());
});

test('approving twice buys once — the second call is refused, not repeated', () => {
  const { store } = freshStore();
  const { approval } = store.create(PROPOSAL);

  const first = store.decide(approval.id, 'approve');
  assert.equal(first.ok, true);
  assert.equal(first.status, STATUS.APPROVED);

  const second = store.decide(approval.id, 'approve');
  assert.equal(second.ok, false, 'a double tap must not approve a second time');
  assert.equal(second.status, STATUS.APPROVED, 'it reports the state it was already left in');
  assert.match(second.problems[0], /already approved/);
});

test('an expired proposal cannot be approved', () => {
  const { store, tick } = freshStore();
  const { approval } = store.create(PROPOSAL, { ttl: 5000 });
  tick(6000);
  const res = store.decide(approval.id, 'approve');
  assert.equal(res.ok, false);
  assert.equal(res.status, STATUS.EXPIRED);
  assert.match(res.problems[0], /expired/);
});

test('expiry is swept on read, so no caller has to remember to check it', () => {
  const { store, tick } = freshStore();
  store.create(PROPOSAL, { ttl: 1000 });
  tick(2000);
  assert.equal(store.list({ status: STATUS.PENDING }).length, 0);
  assert.equal(store.list({ status: STATUS.EXPIRED }).length, 1);
});

test('a second identical press returns the waiting proposal instead of a second chance to buy', () => {
  const { store } = freshStore();
  const a = store.create(PROPOSAL);
  const b = store.create({ ...PROPOSAL });
  assert.equal(b.duplicate, true);
  assert.equal(b.approval.id, a.approval.id);
  assert.equal(store.list().length, 1, 'one message, one order');
});

test('a different proposal is a different approval, even for the same symbol', () => {
  const { store } = freshStore();
  const a = store.create(PROPOSAL);
  const b = store.create({ ...PROPOSAL, entry: 136.0 });
  assert.equal(b.duplicate, false);
  assert.notEqual(b.approval.id, a.approval.id);
  assert.notEqual(proposalKey(a.approval.proposal), proposalKey(b.approval.proposal));
});

test('cancelling is terminal and blocks a later approve', () => {
  const { store } = freshStore();
  const { approval } = store.create(PROPOSAL);
  assert.equal(store.decide(approval.id, 'cancel').status, STATUS.CANCELLED);
  const late = store.decide(approval.id, 'approve');
  assert.equal(late.ok, false);
  assert.equal(late.status, STATUS.CANCELLED);
});

test('an unknown id and a nonsense decision are both refused without throwing', () => {
  const { store } = freshStore();
  const missing = store.decide('NOPE', 'approve');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'unknown');

  const { approval } = store.create(PROPOSAL);
  const junk = store.decide(approval.id, 'maybe');
  assert.equal(junk.ok, false);
  assert.equal(store.get(approval.id).status, STATUS.PENDING, 'a bad word must not consume the decision');
});

test('the store survives a restart — a proposal written to disk is readable by a new process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-approvals-'));
  const file = path.join(dir, 'order_approvals.json');
  try {
    const clock = 1_700_000_000_000;
    const first = createApprovalStore({ file, now: () => clock });
    const { approval } = first.create(PROPOSAL);

    // A fresh store object reading the same file is what a restarted server does.
    const second = createApprovalStore({ file, now: () => clock });
    const reloaded = second.get(approval.id);
    assert.ok(reloaded, 'a pending proposal must not vanish with the process');
    assert.equal(reloaded.status, STATUS.PENDING);
    assert.equal(reloaded.proposal.quantity, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a decision taken before a restart is still final after one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-approvals-'));
  const file = path.join(dir, 'order_approvals.json');
  try {
    const clock = 1_700_000_000_000;
    const first = createApprovalStore({ file, now: () => clock });
    const { approval } = first.create(PROPOSAL);
    first.decide(approval.id, 'approve');

    const second = createApprovalStore({ file, now: () => clock });
    const again = second.decide(approval.id, 'approve');
    assert.equal(again.ok, false, 'a restart must not reopen a decision that was already made');
    assert.equal(again.status, STATUS.APPROVED);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settle records what the broker actually did, so the message can say it', () => {
  const { store } = freshStore();
  const { approval } = store.create(PROPOSAL);
  store.decide(approval.id, 'approve');
  const settled = store.settle(approval.id, {
    status: STATUS.FAILED,
    result: { stage: 'sizing', problems: ['the account has no cash to size from'] },
  });
  assert.equal(settled.status, STATUS.FAILED);
  assert.match(settled.result.problems[0], /no cash/);
});

test('two proposals created in the same second still get different ids', () => {
  const { store } = freshStore();
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    ids.add(store.create({ ...PROPOSAL, entry: 100 + i }).approval.id);
  }
  assert.equal(ids.size, 20, 'a collision would silently overwrite a live order');
});

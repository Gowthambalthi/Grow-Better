/**
 * test/orderPreflight.test.js
 *
 * The preflight exists to answer "is live ordering working" WITHOUT placing an order, so the two
 * properties that matter are:
 *
 *   1. it never POSTs to the order endpoint - a preflight that could send is worse than no preflight;
 *   2. the body it shows is the same body placeOrder sends. Two build paths would let the page show
 *      one order and the broker receive another, which is exactly the kind of difference nobody would
 *      notice until it cost money.
 *
 * axios is a singleton require, so the module under test and this file share one object; the POST is
 * replaced with a spy for the duration of each test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AngelTrading = require(path.join(ROOT, 'angelone', 'trading')); // module.exports is the class itself

const SESSION = { jwtToken: 'test-jwt', apiKey: 'test-key' };

const VALID_ORDER = {
  tradingsymbol: 'SAMBHV-EQ',
  symboltoken: '757767',
  exchange: 'NSE',
  transactionType: 'BUY',
  orderType: 'LIMIT',
  productType: 'INTRADAY',
  quantity: 2,
  price: 158.34,
  validity: 'DAY'
};

function withStubbedAxios(fn) {
  const realPost = axios.post;
  const realGet = axios.get;
  const posts = [];
  axios.post = async (url, body) => {
    posts.push({ url, body });
    return { data: { status: true, data: { orderid: 'TEST-ORDER-1' } } };
  };
  axios.get = async () => ({ data: { status: true, data: [] } });
  return Promise.resolve()
    .then(() => fn(posts))
    .finally(() => {
      axios.post = realPost;
      axios.get = realGet;
    });
}

test('preflight returns the exact body placeOrder would send, and sends nothing', async () => {
  await withStubbedAxios(async (posts) => {
    const angel = new AngelTrading(SESSION);

    const pre = await angel.preflightOrder(VALID_ORDER);

    assert.equal(posts.length, 0, 'preflight POSTed to the broker');
    assert.equal(pre.ok, true, 'a valid order should preflight clean');
    assert.equal(pre.sessionOk, true);
    assert.equal(pre.wouldSend.tradingsymbol, 'SAMBHV-EQ');
    assert.equal(pre.wouldSend.symboltoken, '757767');
    assert.equal(pre.wouldSend.ordertype, 'LIMIT', 'unified orderType must be mapped for the broker');
    assert.equal(pre.wouldSend.producttype, 'INTRADAY');
    assert.equal(pre.wouldSend.quantity, '2', 'quantity must reach the broker body as a string');
    assert.equal(pre.wouldSend.price, '158.34');
    assert.equal(pre.wouldSend.triggerprice, '0');
    assert.ok(pre.endpoint.includes('/placeOrder'), 'preflight must name the endpoint it is NOT calling');

    // And now the send, with the same input: exactly one POST, carrying the SAME body.
    const sent = await angel.placeOrder(VALID_ORDER);
    assert.equal(posts.length, 1, 'placeOrder must POST exactly once');
    assert.deepEqual(posts[0].body, pre.wouldSend,
      'the preflight body and the sent body differ - the page would show one order and send another');
    assert.equal(sent.orderId, 'TEST-ORDER-1');
  });
});

test('preflight reports every validation reason and still sends nothing', async () => {
  await withStubbedAxios(async (posts) => {
    const angel = new AngelTrading(SESSION);

    await assert.rejects(
      () => angel.preflightOrder(Object.assign({}, VALID_ORDER, { quantity: 0 })),
      /quantity must be a positive integer/,
      'a non-positive quantity must be refused before anything is sent'
    );
    await assert.rejects(
      () => angel.preflightOrder(Object.assign({}, VALID_ORDER, { orderType: 'WHATEVER' })),
      /orderType must be one of/,
      'an unknown order type must be refused'
    );
    await assert.rejects(
      () => angel.preflightOrder(Object.assign({}, VALID_ORDER, { price: 0 })),
      /price is required/,
      'a LIMIT order without a price must be refused'
    );
    assert.equal(posts.length, 0, 'a refused preflight still POSTed');
  });
});

test('preflight (and placeOrder) refuse an order with no instrument token', async () => {
  await withStubbedAxios(async (posts) => {
    const angel = new AngelTrading(SESSION);
    const noToken = Object.assign({}, VALID_ORDER);
    delete noToken.symboltoken;

    await assert.rejects(() => angel.preflightOrder(noToken), /requires order\.symboltoken/);
    assert.equal(posts.length, 0, 'an order missing its token was still handed to the broker');
  });
});

test('a failing order-book read makes the preflight say so instead of claiming all is well', async () => {
  const realPost = axios.post;
  const realGet = axios.get;
  axios.post = async () => { throw new Error('must not be called'); };
  axios.get = async () => {
    const err = new Error('Forbidden');
    err.response = { status: 403 };
    throw err;
  };
  try {
    const angel = new AngelTrading(SESSION);
    const pre = await angel.preflightOrder(VALID_ORDER);
    assert.equal(pre.sessionOk, false, 'a dead REST session must be reported as not ok');
    assert.equal(pre.ok, false, 'a dead session must not preflight clean');
    assert.equal(pre.warnings.length, 1);
    assert.match(pre.warnings[0], /403/, 'the status code is the useful part of the warning');
  } finally {
    axios.post = realPost;
    axios.get = realGet;
  }
});

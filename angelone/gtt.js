/**
 * angelone/gtt.js — Good Till Triggered rules (Angel SmartAPI GTT v1).
 *
 * Docs: https://smartapi.angelbroking.com/docs/GTT
 *
 * A GTT is an order that waits: it sits in the broker (visible in the Angel One
 * app) until the trigger price is touched, then sends the order. Two shapes:
 *
 *   SINGLE — one leg. For an entry setup: trigger on the breakout level, limit
 *            price just through it, transactiontype BUY (or SELL to short).
 *   OCO    — two legs (stoploss + target). For a protected position: whichever
 *            leg triggers cancels the other, so the trade is bracketed at the
 *            broker without this process having to stay alive.
 *
 * Every call is a POST with the standard SmartAPI headers; the session is the
 * same one the rest of the Angel client uses.
 */

'use strict';

const axios = require('axios');
const env = require('../config/env');

class AngelGtt {
  constructor(session) {
    if (!session || !session.jwtToken) throw new Error('AngelGtt requires a session with jwtToken');
    this.session = session;
    this.baseUrl = env.angel.baseUrl();
  }

  _headers() {
    const { jwtToken, apiKey } = this.session;
    return {
      Authorization: `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': apiKey || env.angel.apiKey(),
    };
  }

  // Angel answers with EITHER {status:false,message,errorcode} (older shape) OR
  // {success:false,message,errorCode} (GTT shape). Checking only the first let a
  // hard failure look like an empty rule list, so both are treated as errors.
  _assertOk(path, data) {
    if (data && (data.status === false || data.success === false)) {
      throw new Error(`Angel GTT ${path} rejected: ${data.message || 'unknown'} (${data.errorCode || data.errorcode || '-'})`);
    }
    return data;
  }

  async _post(path, body) {
    const { data } = await axios.post(`${this.baseUrl}${path}`, body || {}, { headers: this._headers(), timeout: 10000 });
    return this._assertOk(path, data);
  }

  /** Rule list is documented as POST in some SDK versions and GET in others. */
  async getRuleList() {
    const path = '/rest/secure/angelbroking/gtt/v1/ruleList';
    try {
      const d = await this._post(path, {});
      return d.data || [];
    } catch (e) {
      try {
        const { data } = await axios.get(`${this.baseUrl}${path}`, { headers: this._headers(), timeout: 10000 });
        this._assertOk(path, data);
        return data.data || [];
      } catch (_) {
        throw e;
      }
    }
  }

  /**
   * rule: {
   *   tradingsymbol, symboltoken, exchange: 'NSE',
   *   transactiontype: 'BUY'|'SELL', producttype: 'DELIVERY'|'INTRADAY'|'MARGIN',
   *   quantity, price, triggerprice, timeperiod (days, max 365),
   *   gttType: 'SINGLE' | 'OCO',
   *   stoploss: { triggerprice, price, quantity },   // OCO only
   *   target:   { triggerprice, price, quantity }    // OCO only
   * }
   */
  async createRule(rule) {
    const body = Object.assign({ timeperiod: 30 }, rule);
    const d = await this._post('/rest/secure/angelbroking/gtt/v1/createRule', body);
    const id = d && d.data ? (d.data.id != null ? d.data.id : d.data.ruleid) : null;
    // No id means Angel did NOT create a rule, whatever its status flag said —
    // treat it as a failure and show the raw body so the reason is visible.
    if (id == null || id === '') {
      throw new Error('Angel GTT create returned no rule id: ' + JSON.stringify(d).slice(0, 400));
    }
    return { ruleId: id, raw: d };
  }

  async cancelRule(id, symboltoken) {
    const d = await this._post('/rest/secure/angelbroking/gtt/v1/cancelRule', { id: String(id), symboltoken: String(symboltoken) });
    return { ok: true, raw: d };
  }

  async modifyRule(rule) {
    const d = await this._post('/rest/secure/angelbroking/gtt/v1/modifyRule', rule);
    return { ok: true, raw: d };
  }
}

module.exports = AngelGtt;

/**
 * public/js/core/api.js
 * API Client & Network Communications Module
 */

const API_KEY_STORAGE = 'openalgo_api_key';
const DEFAULT_SERVER_API_KEY = '0de1184a7c9e9c11a1a6108562aeaf0bb810084fd173be4d';

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || DEFAULT_SERVER_API_KEY;
}

export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const key = getApiKey();
  if (key) headers['X-API-Key'] = key;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

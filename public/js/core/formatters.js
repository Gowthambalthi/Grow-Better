/**
 * public/js/core/formatters.js
 * Currency & Number Formatting Helpers Module
 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(n) {
  return n == null ? '—' : `₹${inr.format(n)}`;
}

export function rawMoney(n) {
  return inr.format(n || 0);
}

export function plClass(n) {
  return n == null ? '' : n >= 0 ? 'pl-positive' : 'pl-negative';
}

export function plSign(n) {
  return n == null ? '' : n >= 0 ? '+' : '';
}

export function pct(n) {
  return n == null ? '—' : `${plSign(n)}${n.toFixed(2)}%`;
}

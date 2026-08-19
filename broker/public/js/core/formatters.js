/**
 * public/js/core/formatters.js
 * Currency & Number Formatting Helpers Module
 */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export function money(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return `₹${inr.format(Number(n))}`;
}

export function rawMoney(n) {
  if (n == null || isNaN(Number(n))) return '0.00';
  return inr.format(Number(n));
}

export function plClass(n) {
  if (n == null || isNaN(Number(n))) return '';
  return Number(n) >= 0 ? 'pl-positive' : 'pl-negative';
}

export function plSign(n) {
  if (n == null || isNaN(Number(n))) return '';
  return Number(n) >= 0 ? '+' : '';
}

export function pct(n) {
  if (n == null || isNaN(Number(n))) return '—';
  const val = Number(n);
  return `${plSign(val)}${val.toFixed(2)}%`;
}

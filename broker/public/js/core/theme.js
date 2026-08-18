/**
 * public/js/core/theme.js
 * Theme Manager (Light & Dark mode toggle)
 */

const THEME_STORAGE_KEY = 'openalgo_theme';

export function getSavedTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
}

export function setTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
  localStorage.setItem(THEME_STORAGE_KEY, themeName);
}

export function initTheme() {
  setTheme(getSavedTheme());
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  }
}

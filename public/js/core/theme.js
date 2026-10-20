/**
 * public/js/core/theme.js
 * Theme Manager (Light & Dark mode toggle)
 */

const THEME_STORAGE_KEY = 'openalgo_theme';
// A SEPARATE KEY THAT ONLY A DELIBERATE TOGGLE WRITES.
//
// initTheme() used to call setTheme() — which persists — on every load, so the
// DEFAULT was written into localStorage and became indistinguishable from a
// choice the user actually made. That is what let a flipped default stick: one
// load after the default changed to 'light' and the browser reported 'light'
// forever, with no way to tell it apart from someone who deliberately picked it.
//
// Now the marker is written by the toggle and by nothing else. Its absence means
// the stored value was written by the old auto-persisting init and is not a real
// preference, so the default is used instead.
const THEME_CHOICE_KEY = 'openalgo_theme_chosen';
const DEFAULT_THEME = 'dark';

/** True only when the user themselves picked a theme via the toggle. */
function hasExplicitChoice() {
  try {
    return localStorage.getItem(THEME_CHOICE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function getSavedTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch (_) {
    stored = null;
  }
  // A stored value with no choice marker came from the old auto-persisting init,
  // not from the user, so it is ignored and the default applies.
  if (!stored || !hasExplicitChoice()) return DEFAULT_THEME;
  return stored;
}

/** Apply a theme WITHOUT persisting it. Used for the initial paint. */
export function applyTheme(themeName) {
  document.documentElement.setAttribute('data-theme', themeName);
}

/** Apply AND persist. This is the user's choice, so it is remembered. */
export function setTheme(themeName) {
  applyTheme(themeName);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeName);
    localStorage.setItem(THEME_CHOICE_KEY, '1');
  } catch (_) {}
}

export function initTheme() {
  // DARK BY DEFAULT, THE WAY THE APP HAS ALWAYS OPENED. The workspace canvas is
  // dark with white sidebar/topbar chrome; opening it white end to end is what
  // read as "not the old app" even with every sidebar entry present. This was
  // briefly flipped to 'light' to suit the Terminal's panels — the Terminal is
  // gone, so the reason went with it.
  applyTheme(getSavedTheme());
  const themeBtn = document.getElementById('themeToggleBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  }
}

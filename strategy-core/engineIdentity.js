/**
 * strategy-core/engineIdentity.js — IS THIS FILE A RENAMED COPY OF AN ENGINE WE ALREADY HAVE?
 *
 * WHY THIS EXISTS. On 2026-10-17 two files appeared in `strategies/` — `codex.js` and
 * `swing.js` — and both were presented as new strategies. Neither was new: `codex.js`
 * was `orderFlow.js` with `setup: 'OF03'` renamed to `'CODEX'`, and `swing.js` was the
 * same file with only its header rewritten. Nothing in the tree objected. A renamed
 * copy is worse than useless here, and not because of the disk space:
 *
 *   - it gets its OWN backtest artifact and its own row, so the page can show the same
 *     rule twice under two names and a sample of N=25 can read as two independent
 *     measurements of two ideas;
 *   - it silently forks from the original. Every later fix (the dead 12:30 cutoff, a
 *     retightened threshold) has to be applied twice, and the day it is not applied
 *     twice, two files that claim to be different engines disagree about the market;
 *   - a hand-rolled harness pointed at it produces an "OFFICIAL BACKTEST REPORT" for a
 *     strategy that is a copy — which is exactly how a duplicate got reported to the
 *     owner as progress.
 *
 * SO THE TEST IS CONTENT, NOT NAMES. Comments, whitespace, line endings and the
 * engine's own identifiers are stripped, then the sources are compared as SETS OF
 * 8-CHARACTER SHINGLES (Jaccard similarity). Renaming an id or rewriting a header
 * barely moves that number; two genuinely different rule sets do not come close. The
 * threshold is deliberately loose (0.90) because the cost of a false positive is a
 * clear error message and the cost of a false negative is a duplicated strategy
 * presented as a second one.
 *
 * WHAT IT DOES NOT DO. It does not judge strategy QUALITY — two engines with different
 * rules may both be bad, and a file that is merely similar in style (shared helpers,
 * shared structure) is not a copy. The number is printed with every complaint so a
 * borderline case can be read rather than guessed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Two sources this similar are treated as the same engine. */
const DUPLICATE_THRESHOLD = 0.90;

/**
 * Comments and whitespace out, string LITERALS kept. Keeping literals means a
 * `setup: 'CODEX'` rename is visible as a small difference — which is the point: the
 * ratio should be high but not exactly 1, and printing the ratio is what tells a
 * reader whether they are looking at a rename or a different engine that ran out of
 * ideas.
 */
function normalise(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // block comments (the headers live here)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')  // line comments, not a URL's "//"
    .replace(/\s+/g, '')                    // all whitespace, so CRLF vs LF cannot matter
    .replace(/[;,]$/gm, '');
}

/** n-character shingles of the normalised source, as a Set. */
function shingles(src, n) {
  const size = n || 8;
  const s = normalise(src);
  const out = new Set();
  if (s.length <= size) { if (s) out.add(s); return out; }
  for (let i = 0; i + size <= s.length; i++) out.add(s.slice(i, i + size));
  return out;
}

/** Jaccard similarity of two sources, 0..1. */
function similarity(a, b, n) {
  const A = shingles(a, n);
  const B = shingles(b, n);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (large.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * The closest REGISTERED engine to this source, if it is close enough to be a copy.
 *
 * @param {string} src        the candidate source (a file's contents)
 * @param {Array}  engines    registry entries: [{ key, mod, file }] (defaults to the registry)
 * @param {string} [exclude]  registry key to skip — used when comparing an engine to its peers
 * @returns {{key: string, file: string, ratio: number}|null}
 */
function duplicateOf(src, engines, exclude) {
  const { ENGINES } = require('./engines');
  const list = engines || ENGINES;
  let best = null;
  for (const e of list) {
    if (exclude && e.key === exclude) continue;
    const file = e.file || null;
    let other = null;
    if (file && fs.existsSync(path.resolve(__dirname, '..', file))) {
      other = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    } else if (e.mod) {
      other = moduleSource(e.mod);
    }
    if (other == null) continue;
    const ratio = similarity(src, other);
    if (!best || ratio > best.ratio) best = { key: e.key, file, ratio };
  }
  return best && best.ratio >= DUPLICATE_THRESHOLD ? best : null;
}

/**
 * The source of a required module, for engines whose `file` is missing or is a
 * re-export. `require.cache` is keyed by resolved path, so this asks Node where the
 * module actually came from instead of guessing a filename.
 */
function moduleSource(mod) {
  try {
    const hit = Object.values(require.cache).find((m) => m.exports === mod);
    return hit ? fs.readFileSync(hit.filename, 'utf8') : null;
  } catch (_) { return null; }
}

module.exports = { similarity, duplicateOf, normalise, shingles, moduleSource, DUPLICATE_THRESHOLD };

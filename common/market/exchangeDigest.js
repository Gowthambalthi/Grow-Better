'use strict';

/**
 * exchange.md -> a digest the dashboard can render.
 *
 * exchange.md is the shared memory of the two-AI research loop (Freebuff and
 * Antigravity), and it was readable only in a text editor. The owner asked for the
 * other AI's work to be visible where the decisions are made, so this module hands
 * the page the LATEST round of each side and the latest NEXT ACTION block.
 *
 * It re-words nothing. Whatever it returns is what was written in the file, so the
 * page cannot become a paraphrase of a research result — which matters, because a
 * summarised finding is a lost finding.
 *
 * Attribution is by the AI name carried in the `### Round` heading itself, not by
 * which section of the file the round sits in: Freebuff's later rounds are appended
 * after the changelog, so a section-based reader would silently show stale work.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROUND_LINES = 60;

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

/**
 * @param {string} rootDir directory containing exchange.md
 * @param {{file?: string, roundLines?: number}} [opts]
 */
function exchangeDigest(rootDir, opts) {
  const options = opts || {};
  const name = options.file || 'exchange.md';
  const clip = options.roundLines || DEFAULT_ROUND_LINES;
  const file = path.isAbsolute(name) ? name : path.join(rootDir, name);

  const text = readText(file);
  if (text == null) {
    return { ok: false, file: name, error: 'not readable' };
  }
  const lines = text.split(/\r?\n/);

  // Every `### Round` heading, attributed by the AI it names.
  const rounds = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!/^#{2,4}\s*Round/i.test(t)) return;
    const who = /freebuff/i.test(t) ? 'freebuff'
      : /antigravity/i.test(t) ? 'antigravity' : null;
    if (who) rounds.push({ who, title: t.replace(/^#+\s*/, ''), at: i });
  });

  /**
   * Body of a round: its heading up to the next heading or section rule, clipped.
   * Rounds in exchange.md are separated by a `------` rule as well as by `====`
   * section rules and `###` headings, so all three end the body — otherwise one
   * round's text runs into the next one's and the page shows two rounds fused.
   *
   * Only `##`/`###` END a round. `####` is a SUBSECTION inside one (the real Round 18
   * opens `#### 1. Full Comparison…` right after its date line), and breaking on it
   * returned a 2-line preamble instead of the round — the panel would have looked like
   * no research had happened. A deeper heading never starts a new round here.
   */
  const bodyAt = (at) => {
    const out = [];
    // Start AFTER the heading: the title is returned separately, so including it
    // here would print the round name twice on the page.
    for (let i = at + 1; i < lines.length && out.length < clip; i++) {
      const t = lines[i].trim();
      if (/^#{2,3}\s/.test(t) || /^=+\s*$/.test(t) || /^-{3,}\s*$/.test(t)) break;
      out.push(lines[i]);
    }
    return out.join('\n').trim();
  };

  const latest = { freebuff: null, antigravity: null };
  for (const who of ['freebuff', 'antigravity']) {
    const mine = rounds.filter((r) => r.who === who);
    if (!mine.length) continue;
    const last = mine[mine.length - 1];
    latest[who] = {
      title: last.title,
      body: bodyAt(last.at),
      roundCount: mine.length,
    };
  }

  // The latest NEXT ACTION block, verbatim, with its `====` rules stripped.
  let nextAction = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^\s*NEXT ACTION\s*$/.test(lines[i])) continue;
    const out = [];
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^=+\s*$/.test(l.trim())) { if (out.length) break; continue; }
      out.push(l);
    }
    nextAction = out.join('\n').trim();
    break;
  }

  let updatedAt = null;
  try { updatedAt = fs.statSync(file).mtime.toISOString(); } catch (_) { /* leave null */ }

  return {
    ok: true,
    file: name,
    lines: lines.length,
    updatedAt,
    rounds: rounds.map((r) => ({ who: r.who, title: r.title })),
    freebuff: latest.freebuff,
    antigravity: latest.antigravity,
    nextAction,
  };
}

module.exports = { exchangeDigest, DEFAULT_ROUND_LINES };

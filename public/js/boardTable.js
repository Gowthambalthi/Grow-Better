/**
 * public/js/boardTable.js — THE BOARD TABLE. One implementation, two pages.
 *
 * WHY THIS EXISTS. The Board and the Terminal were each rendering their own
 * version of the same thing, from the same snapshot, with different filters and
 * different columns:
 *
 *   Board      an "Intraday board" of every tracked name (its tape), and
 *              separately a "Board — Live Calls + Rules" of the calls (its plan)
 *   Terminal   a "Live Plan" panel of the calls, and separately a "Board" panel
 *              of every tracked name, and separately again a "Plan detail" table
 *
 * Three columns of the same data, two of them on the same page. The blocked
 * logic lived only in the tape view, the execution arithmetic only in the calls
 * view, so neither could be read alone and a symbol could appear in both with
 * different things said about it.
 *
 * This file renders ONE row per tracked name, carrying the tape AND the call
 * AND the plan AND the working, with the blocked reason in the row it belongs to.
 * Both pages mount it; the Terminal passes `executable: true` to get the
 * OK / EXECUTE button, which is the only thing the Terminal adds.
 *
 * It injects its own styles with fallbacks for the CSS variables, because the two
 * pages do not share a stylesheet — the same approach public/js/auditSheet.js
 * takes, and for the same reason.
 *
 *   BoardTable.mount(hostElement, { executable: false, horizon: '1min', onExecute: fn })
 *     -> { setSnapshot(snap), setHorizon(h), refresh() }
 */
(function () {
  'use strict';

  var STYLE_ID = 'boardTableStyles';

  var CSS = '' +
    '.bt-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}' +
    '.bt-meta{font-size:11.5px;color:var(--text-muted,#66748c)}' +
    '.bt-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}' +
    '.bt-lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-dim,#8a97ad);font-weight:800}' +
    '.bt-btn{background:var(--bg-raised,#151d2b);color:var(--text-primary,#e6ebf5);border:1px solid var(--line-bright,#2a3346);' +
      'border-radius:8px;padding:4px 10px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit}' +
    '.bt-btn:hover{background:var(--bg-raised-hover,#1b2436)}' +
    '.bt-btn.on{border-color:var(--accent,#00B386);color:var(--gain,#00e091)}' +
    '.bt-btn:disabled{opacity:.45;cursor:not-allowed}' +
    '.bt-btn .c{opacity:.65;font-variant-numeric:tabular-nums}' +
    '.bt-scroll{overflow:auto;max-height:60vh;border:1px solid var(--line,#182645);border-radius:10px}' +
    '.bt-t{width:100%;border-collapse:collapse;font-size:12px}' +
    '.bt-t th{position:sticky;top:0;background:var(--bg-header,#0F2447);color:var(--text-muted,#66748c);' +
      'font-size:10px;text-transform:uppercase;letter-spacing:.05em;text-align:right;padding:7px 7px;' +
      'border-bottom:1px solid var(--line-bright,#2a3346);white-space:nowrap;z-index:2}' +
    '.bt-t th.l{text-align:left}' +
    '.bt-t th.grp{text-align:center;font-size:10px;border-bottom:1px solid var(--line-bright,#2a3346)}' +
    '.bt-t tr.grp th{top:0}' +
    '.bt-t tbody td{padding:6px 7px;border-bottom:1px solid var(--line,#182645);text-align:right;' +
      'font-variant-numeric:tabular-nums;white-space:nowrap}' +
    '.bt-t tbody td.l{text-align:left}' +
    '.bt-t tbody tr:hover{background:rgba(74,158,255,.07)}' +
    '.bt-sym{font-weight:700}' +
    '.bt-pos{color:var(--gain,#00e091)}.bt-neg{color:var(--loss,#ff4d6d)}.bt-mut{color:var(--text-dim,#8a97ad)}' +
    '.bt-tag{font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px;letter-spacing:.04em}' +
    '.bt-tag.BUY{background:rgba(0,224,145,.14);color:var(--gain,#00e091)}' +
    '.bt-tag.SHORT{background:rgba(255,77,109,.14);color:var(--loss,#ff4d6d)}' +
    '.bt-tag.WATCH{background:rgba(255,176,46,.14);color:var(--warn,#ffb02e)}' +
    '.bt-tag.QUIET{background:rgba(148,163,184,.12);color:var(--text-dim,#8a97ad)}' +
    '.bt-tag.LATE{background:rgba(255,176,46,.10);color:var(--text-dim,#8a97ad)}' +
    '.bt-tag.POS{background:rgba(0,179,134,.20);color:var(--gain,#00e091);border:1px solid rgba(0,179,134,.45)}' +
    '.bt-blk{background:rgba(255,77,109,.14);color:var(--loss,#ff4d6d);font-size:9.5px;font-weight:800;padding:1px 5px;border-radius:5px}' +
    '.bt-det{cursor:pointer;border:1px solid var(--accent-cyan,#38bdf8);background:rgba(56,189,248,.12);' +
      'color:var(--accent-cyan,#38bdf8);font-weight:800;font-size:10.5px;padding:3px 9px;border-radius:6px}' +
    '.bt-go{cursor:pointer;border:1px solid var(--gain,#00e091);background:rgba(0,224,145,.1);color:var(--gain,#00e091);' +
      'font-weight:800;font-size:10.5px;padding:3px 9px;border-radius:6px}' +
    '.bt-go:disabled{border-color:var(--line-bright,#2a3346);color:var(--text-dim,#8a97ad);background:transparent;cursor:default}' +
    '.bt-empty{padding:26px 14px;text-align:center;color:var(--text-dim,#8a97ad);font-size:12.5px;line-height:1.7}' +
    '.bt-why{white-space:normal;min-width:190px;max-width:330px}' +
    '.bt-mark{font-size:10px;color:var(--text-dim,#8a97ad);margin-left:6px;white-space:nowrap}' +
    '.bt-why{color:var(--text-dim,#8a97ad);font-size:11.5px;line-height:1.45}' +
    '.bt-why b{color:var(--warn,#ffb02e);font-weight:700}' +
    '.bt-note{font-size:11px;color:var(--text-dim,#8a97ad);margin-top:8px;line-height:1.7}';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // Copy a canonical info line to the clipboard using navigator.clipboard.writeText,
  // with a manual select-as-a-textarea fallback for strict-site contexts. Used for
  // the symbol cell (click to copy) and the detail-sheet COPY button.
  function copyToClipboard(text, cb) {
    var done = false;
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done = true; if (cb) cb(true); })
        .catch(function () { /* fall through to manual path */ });
    }
    if (done) return;
    // Manual path: build a tiny textarea, select, execCommand. Visible only for
    // the copy moment, removed immediately — no layout effect.
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-10000px';
    ta.style.top = '-10000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      if (document.execCommand && document.execCommand('copy')) { done = true; if (cb) cb(true); }
    } catch (_) { /* ignore */ }
    document.body.removeChild(ta);
    if (!done && cb) cb(false);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n(v, d) { return (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
  function int(v) { return (v == null || isNaN(v)) ? '—' : Math.round(v).toLocaleString('en-IN'); }
  function pct(v) { return (v == null || isNaN(v)) ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; }
  function cls(v) { return (v == null || isNaN(v)) ? 'bt-mut' : (v > 0 ? 'bt-pos' : v < 0 ? 'bt-neg' : 'bt-mut'); }

  // The sub-minute horizons cannot be built from 1-minute candles. They are shown
  // DISABLED with the reason attached rather than hidden, so the absence reads as
  // a missing input rather than a missing feature.
  var HORIZONS = [
    { key: '1min', label: '1min' },
    { key: '3min', label: '3min' },
    { key: '5min', label: '5min' },
    { key: '10s', label: '10s', off: true },
    { key: '15s', label: '15s', off: true },
    { key: '20s', label: '20s', off: true },
    { key: '30s', label: '30s', off: true }
  ];
  var CALLS = ['BUY', 'SHORT', 'WATCH', 'LATE', 'QUIET'];

  // WHAT THE CALL CELL SAYS, and why the words are not the engine's own. The
  // engine's vocabulary is BUY / SHORT / WATCH / LATE / QUIET, and it is stored
  // and filtered on exactly that — but READ it is a trade instruction, and the
  // board's rows are not all tradeable: WATCH means "wait", QUIET means "no call
  // at all". These are the words the page prints; the values behind them are
  // untouched, so nothing downstream has to know about the rename.
  var STATUS_LABEL = { BUY: 'BUY', SHORT: 'SELL', WATCH: 'WAIT', LATE: 'LATE', QUIET: 'NONE' };
  function statusLabel(s) { return STATUS_LABEL[s] || s || 'NONE'; }

  function mount(host, opts) {
    opts = opts || {};
    injectStyles();

    var state = {
      snap: null,
      horizon: opts.horizon || '1min',
      userFilter: 'all',
      callFilter: '',
    };

    host.classList.add('bt-root');
    // NO HORIZON SWITCHER HERE. It existed to pick which ROC the tape column
    // showed, and the tape is no longer a column on this table — it is the Tape tab
    // of the detail sheet, where all three horizons print side by side instead of
    // one at a time. mount() still accepts `horizon` and setHorizon() still works,
    // so a page that wants the tape back gets it without touching this file.
    host.innerHTML =
      '<div class="bt-bar">' +
        '<div class="bt-meta" data-bt="meta">loading…</div>' +
      '</div>' +
      '<div class="bt-bar">' +
        // THESE COUNT THE ROWS IN THIS TABLE, NOT THE WHOLE SCAN. The page's top
        // card carries the SCAN's own ALL / NOT BLOCKED / BLOCKED, which are a
        // different (larger) population: the snapshot holds a capped, partly
        // stale subset. Two numbers under one label is what made "not blocked
        // 228" here disagree with "not blocked 451" above, so this label now
        // names its scope and each button carries its own title.
        '<span class="bt-lbl" title="these count the rows IN THIS TABLE, not the whole scan — the scan totals are on the page\'s top card">in this table</span>' +
        '<button class="bt-btn" data-uf="all" title="rows in this table">ALL <span class="c" data-bt="nAll">—</span></button>' +
        '<button class="bt-btn" data-uf="ok" title="rows in this table that are not blocked">NOT BLOCKED <span class="c" data-bt="nOk">—</span></button>' +
        '<button class="bt-btn" data-uf="blocked" title="rows in this table that are blocked">BLOCKED <span class="c" data-bt="nBlocked">—</span></button>' +
        '<span class="bt-lbl" style="margin-left:12px">call</span>' +
        '<button class="bt-btn" data-cf="">ALL</button>' +
        CALLS.map(function (c) { return '<button class="bt-btn" data-cf="' + c + '">' + statusLabel(c) + '</button>'; }).join('') +
      '</div>' +
      '<div class="bt-scroll">' +
        '<table class="bt-t">' +
          // ONE ROW, THE VALUES THAT DECIDE. Symbol · call · entry · stop · T1 ·
          // T2 · R:R · risk · the working. The tape (price, volume, VWAP, POC,
          // range, all three ROC horizons), the engine and setup, the bars-ago
          // count and the gate/blocked reason all moved into the Tape tab of the
          // detail sheet — the same sheet every row already opens — so the row
          // reads at a glance without anything being thrown away.
          '<thead><tr>' +
            '<th class="l" rowspan="2">#</th><th class="l" rowspan="2">Symbol</th>' +
            '<th class="grp" colspan="' + (opts.executable ? 9 : 8) + '">the call and its plan</th>' +
          '</tr><tr>' +
            '<th class="l">Call</th>' +
            '<th>Entry</th><th>Stop</th><th>T1</th><th>T2</th><th>R:R</th><th>Risk %</th>' +
            (opts.executable ? '<th class="l">Action</th>' : '') +
            '<th class="l">Working</th>' +
          '</tr></thead>' +
          '<tbody data-bt="body"></tbody>' +
        '</table>' +
        '<div class="bt-empty" data-bt="empty" style="display:none"></div>' +
      '</div>' +
      '<div class="bt-note" data-bt="note"></div>';

    var q = function (name) { return host.querySelector('[data-bt="' + name + '"]'); };

    /** Every call by symbol, so a row can find its own plan. */
    function callIndex() {
      var map = {};
      ((state.snap && state.snap.calls) || []).forEach(function (c) {
        if (!map[c.symbol] || (c.ok && !map[c.symbol].ok)) map[c.symbol] = c;
      });
      return map;
    }

    /** Rows = the tape, plus any call the row budget did not keep. */
    function allRows() {
      var snap = state.snap || {};
      var seen = {};
      var rows = (snap.rows || []).map(function (r) { seen[r.symbol] = 1; return r; });
      (snap.calls || []).forEach(function (c) {
        if (seen[c.symbol]) return;
        rows.push({
          symbol: c.symbol, price: c.ltp, signal: c.status, engine: c.engine, setup: c.setup,
          gate: c.gate, blocked: false, blockReason: null, roc: null, partial: true,
          ledgerId: c.ledgerId, positive: c.positive, netR: c.netR, netPF: c.netPF,
        });
      });
      return rows;
    }

    function visible(r) {
      if (state.userFilter === 'blocked' && !r.blocked) return false;
      if (state.userFilter === 'ok' && r.blocked) return false;
      if (state.callFilter && (r.signal || 'QUIET') !== state.callFilter) return false;
      return true;
    }

    function whyFor(r, c) {
      if (c && c.reason && c.reason.length) return c.reason.join(' · ');
      if (c && c.gate) return 'GATE_' + c.gate;
      if (r.blockReason) return 'blocked from the 500: ' + r.blockReason;
      return r.gate ? ('GATE_' + r.gate) : '—';
    }

    /**
     * WHY THIS ROW IS NOT A CALL — one sentence, on the row itself. A row with no
     * BUY or SELL prints no plan numbers, so this cell is where the answer has to
     * live: what the engine did with the name, and the reason it gave. The full
     * working, with every failing gate, is still one click away in DETAIL.
     */
    function notCallWhy(r, c, status) {
      var label = statusLabel(status);
      var reason = whyFor(r, c);
      var hasSetup = !!(r.setupId || r.plan || (c && c.setupId));
      var head;
      if (!hasSetup) head = 'no setup fired on this name today';
      else if (r.planNote) head = r.planNote;
      else if ((r.plan && !r.plan.isCall) || (c && c.ok)) head = 'the engine is working this name but has issued no BUY or SELL';
      else head = 'the engine refused this setup';
      var tail = (reason && reason !== '—' && reason.indexOf(head) < 0) ? reason : null;
      return { html: '<b>not a call (' + esc(label) + ')</b> · ' + esc(head) + (tail ? ' — ' + esc(tail) : '') };
    }

    function rowHtml(r, i, calls) {
      var c = calls[r.symbol] || null;
      var status = r.signal || 'QUIET';
      var why = whyFor(r, c);
      // THE ROW'S OWN PLAN WHEN THE SNAPSHOT'S CALLS ARRAY CANNOT ANSWER FOR IT.
      // The engine computes levels for every verdict it fires; only ~120 calls
      // travelled in the snapshot, so ENTRY / STOP / T1 / T2 / R:R printed "—"
      // on the overwhelming majority of rows while the numbers existed. A row
      // plan is ENGINE WORKING, not a call, and `notCall` is what makes the row
      // say so instead of letting the numbers read as a direction.
      var plan = null;
      if (c && c.plan && c.plan.entry != null) {
        plan = c.plan;
      } else if (c && (c.entry != null || c.stop != null)) {
        plan = { entry: c.entry, stop: c.stop, t1: c.t1, t2: c.t2, rr: c.rr1, riskPct: c.riskPct };
      } else if (r.plan && (r.plan.entry != null || r.plan.stop != null)) {
        plan = r.plan;
      }
      var hasPlan = !!(plan && (plan.entry != null || plan.stop != null));
      // NUMBERS ARE FOR CALLS ONLY. Entry, stop, T1, T2, R:R and risk are a plan
      // somebody would act on, so they are printed ONLY when the row carries an
      // actual BUY or SELL. On a WAIT / LATE / NONE row those six cells collapse
      // into one and state the REASON the name is not a call, which is the thing
      // a reader actually needs; the arithmetic is still one click away in
      // DETAIL, where it is labelled as the engine's working and not a call.
      var isCall = (status === 'BUY' || status === 'SHORT');
      var notCall = notCallWhy(r, c, status);
      // The blocked marker stays on the NAME: which names are blocked is the one
      // thing a reader needs without opening anything. WHY is in the Tape tab.
      return '<tr>' +
        '<td class="l bt-mut">' + (i + 1) + '</td>' +
        '<td class="l bt-sym" title="click to copy symbol to clipboard" data-copy="' + esc(r.symbol) + '">' + esc(r.symbol) + (r.blocked ? ' <span class="bt-blk" title="blocked from the 500 — the reason is in its Tape tab">BLK</span>' : '') + ' <span class="bt-mark" title="click to copy">📋</span>' + '</td>' +
        // The CLASS keeps the engine's own value so the colours stay mapped to the
        // real status; the TEXT is the label the reader needs. A row that names a
        // direction carries the LEDGER verdict that permitted it, because "why is
        // this a BUY?" has to be answerable on the row: the board now lets a
        // direction through on the ledger's POSITIVE side, not only on the strict
        // speak gate, so the POSITIVE badge and the net PF sit beside the call.
        '<td class="l">' +
          '<span class="bt-tag ' + esc(status) + '" title="' +
            esc('engine status: ' + status + (r.ledgerId
              ? ' · ledger ' + r.ledgerId + ' is ' + (r.positive ? 'POSITIVE' : 'negative') +
                (r.netR != null ? ' (net ' + (Number(r.netR) > 0 ? '+' : '') + Number(r.netR).toFixed(3) + 'R)'
                  : (r.netPF != null ? ' (net PF ' + Number(r.netPF).toFixed(3) + ')' : ' (unmeasured)'))
              : ' · no ledger entry')) + '">' + esc(statusLabel(status)) + '</span>' +
          (r.positive
            ? ' <span class="bt-tag POS" title="the ledger measures this strategy NET POSITIVE after cost — net R, the money kept — which is what lets it name a direction">POS' +
              (r.netR != null ? ' ' + (Number(r.netR) > 0 ? '+' : '') + Number(r.netR).toFixed(2) + 'R'
                : (r.netPF != null ? ' ' + Number(r.netPF).toFixed(2) + 'x' : '')) + '</span>'
            : '') +
        '</td>' +
        (isCall
          ? '<td>' + (hasPlan ? n(plan.entry) : '—') + '</td>' +
            '<td>' + (hasPlan ? n(plan.stop) : '—') + '</td>' +
            '<td>' + (plan && plan.t1 != null ? n(plan.t1) : '—') + '</td>' +
            '<td>' + (plan && plan.t2 != null ? n(plan.t2) : '—') + '</td>' +
            '<td>' + (plan && plan.rr != null ? Number(plan.rr).toFixed(2) + 'R' : '—') + '</td>' +
            '<td>' + (plan && plan.riskPct != null ? Number(plan.riskPct).toFixed(2) + '%' : '—') + '</td>'
          : '<td class="l bt-why" colspan="6">' + notCall.html + '</td>') +
        (opts.executable
          ? '<td class="l">' + (c && (c.status === 'BUY' || c.status === 'SHORT')
            ? '<button class="bt-go" data-exec="' + esc(JSON.stringify({
                setupId: c.setupId, symbol: c.symbol, engine: c.engine, setup: c.setup, side: c.status,
                signalTime: c.signalTime, entry: c.entry, stop: c.stop, t1: c.t1, t2: c.t2,
                riskPct: c.riskPct, rr1: c.rr1, reason: c.reason,
              })) + '">OK / EXECUTE</button>'
            : '<span class="bt-mut">not a call</span>') + '</td>'
          : '') +
        '<td class="l">' + detFor(r, c) + '</td>' +
        '</tr>';
    }

    /**
     * EVERY ROW HAS A WORKING. A row whose call is in the snapshot opens it by
     * setupId; a row whose call the display cap dropped opens the same sheet by
     * SYMBOL (GET /api/terminal/plan/by-symbol/:symbol); a name no rule fired on
     * has no plan at all, and its button says that rather than opening an empty
     * sheet. The label beside the button keeps three different things apart: a
     * call, an engine's arithmetic that is NOT a call, and no setup at all.
     */
    function detFor(r, c) {
      // THE ROW'S OWN VERDICT, FIRST. `r.setupId` is the verdict behind this row's
      // Call and Engine · Setup cells, and its plan was re-derived from that same
      // verdict — so DETAIL opens the thing the row is describing. The snapshot's
      // `calls` entry is a per-SYMBOL pick and can be a different verdict, which
      // is how a row reading LIQUIDITY once opened a sheet reading ORDERFLOW.
      if (r.plan && r.plan.setupId) {
        return '<button class="bt-det" data-plan="' + esc(r.plan.setupId) + '">DETAIL</button>' +
          (r.plan.isCall ? '' : '<span class="bt-mark">engine working — not a call</span>');
      }
      if (r.setupId) {
        var note = r.planNote || 'the engine refused this one, so it published no levels';
        return '<button class="bt-det" data-plan="' + esc(r.setupId) + '" title="' + esc(note) + '">DETAIL</button>' +
          '<span class="bt-mark" title="' + esc(note) + '">refused — no valid plan</span>';
      }
      if (c && c.setupId) {
        return '<button class="bt-det" data-plan="' + esc(c.setupId) + '">DETAIL</button>' +
          '<span class="bt-mark">not a call</span>';
      }
      // A name no rule fired on. The sheet answers with that fact rather than an
      // empty plan, because there is no verdict to audit.
      return '<button class="bt-det" data-plan-sym="' + esc(r.symbol) + '">DETAIL</button>' +
        '<span class="bt-mark">no setup fired</span>';
    }

    function render() {
      var snap = state.snap || {};
      var rows = allRows();
      var calls = callIndex();
      var shown = rows.filter(visible);

      var blockedIn = rows.filter(function (r) { return r.blocked; }).length;
      var uni = snap.universe || {};
      // The ROC horizon is not a column any more, so the header no longer names
      // one — the Tape tab prints 1min / 3min / 5min together.
      // BOTH POPULATIONS, SIDE BY SIDE, ON ONE LINE. The row counts and the scan
      // totals used to be printed under the same words on two different cards,
      // which is why the two "not blocked" figures looked like a contradiction
      // instead of two answers to two questions. Naming the difference is the fix.
      q('meta').textContent = shown.length + ' of ' + rows.length + ' rows in this snapshot shown' +
        ' · the scan tracks ' + int(uni.tracked) + ' names (' + int(uni.notBlocked) + ' not blocked / ' +
        int(uni.blocked) + ' blocked) — the buttons here count only the ' + rows.length + ' rows in this table' +
        ' · ' + int(snap.callsTotal) + ' calls in the snapshot';
      q('nAll').textContent = int(rows.length);
      q('nBlocked').textContent = int(blockedIn);
      q('nOk').textContent = int(rows.length - blockedIn);

      if (!shown.length) {
        q('empty').style.display = 'block';
        q('empty').textContent = rows.length
          ? 'No rows match these filters.'
          : 'No snapshot yet — run `node scripts/buildBoard.js`.';
        q('body').innerHTML = '';
        return;
      }
      q('empty').style.display = 'none';
      q('body').innerHTML = shown.map(function (r, i) { return rowHtml(r, i, calls); }).join('');

      var tf = snap.timeframes;
      q('note').innerHTML = 'One table, one row per tracked name: the tape and the call are the same row, ' +
        'and a blocked name carries its reason beside it. A name no engine spoke about is shown as QUIET rather than left out.' +
        (tf && tf.engines ? ' The candles each logic reads, and the frame it measured better on, are in the Timeframes panel above.' : '');
    }

    // ---- events, delegated on the host ----
    host.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var hz = t.closest('[data-hz]');
      if (hz) {
        if (hz.disabled) return;
        state.horizon = hz.getAttribute('data-hz');
        host.querySelectorAll('[data-hz]').forEach(function (b) { b.classList.toggle('on', b === hz); });
        render();
        return;
      }
      var uf = t.closest('[data-uf]');
      if (uf) {
        state.userFilter = uf.getAttribute('data-uf');
        host.querySelectorAll('[data-uf]').forEach(function (b) { b.classList.toggle('on', b === uf); });
        render();
        return;
      }
      var cf = t.closest('[data-cf]');
      if (cf) {
        state.callFilter = cf.getAttribute('data-cf');
        host.querySelectorAll('[data-cf]').forEach(function (b) { b.classList.toggle('on', b === cf); });
        render();
        return;
      }
      if (opts.executable) {
        var go = t.closest('[data-exec]');
        if (go && opts.onExecute) { opts.onExecute(go); return; }
      }    // [data-plan] is intentionally NOT handled here: AuditSheet binds it on
    // document, so a DETAIL click goes to the one shared sheet on both pages.
    // Copy the row's symbol to the clipboard when the symbol cell is clicked.
    var copy = t.closest('[data-copy]');
    if (copy) {
      var text = copy.getAttribute('data-copy');
      copyToClipboard(text, function (ok) {
        copy.title = ok ? 'Copied ✓' : 'Copy failed — try the COPY button in the plan sheet';
        // Brief flash feedback
        if (ok) {
          var orig = copy.innerHTML;
          copy.innerHTML = '<span class="bt-mark">✓ Copied</span>';
          setTimeout(function () { copy.innerHTML = orig; }, 1200);
        }
      });
      return;
    }
    });

    function markDefaults() {
      host.querySelectorAll('[data-uf]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-uf') === state.userFilter); });
      host.querySelectorAll('[data-cf]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-cf') === state.callFilter); });
      host.querySelectorAll('[data-hz]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-hz') === state.horizon); });
    }
    markDefaults();

    return {
      setSnapshot: function (s) { state.snap = s; render(); },
      setHorizon: function (h) { state.horizon = h; markDefaults(); render(); },
      refresh: render,
    };
  }

  window.BoardTable = { mount: mount, esc: esc, n: n, int: int, pct: pct, cls: cls, statusLabel: statusLabel };
})();

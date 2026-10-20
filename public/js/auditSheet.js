/**
 * public/js/auditSheet.js — THE PLAN SHEET
 */
(function () {
  'use strict';

  var STYLE_ID = 'auditSheetStyles';
  var OVL_ID = 'auditSheet';

  var CSS = '' +
    '.as-ovl{position:fixed;inset:0;z-index:9999;background:rgba(4,7,12,.78);padding:22px;overflow:auto;display:none}' +
    '.as-ovl.on{display:block}' +
    '.as-sheet{max-width:1180px;margin:0 auto;background:var(--bg-card,#111722);color:var(--text,#e6ebf5);' +
      'border:1px solid var(--border,#2a3346);border-radius:12px;padding:14px 16px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px}' +
    '.as-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}' +
    '.as-head h2{margin:0;font-size:15px}' +
    '.as-chip{font-size:11px;color:var(--text-muted,#66748c);border:1px solid var(--border,#2a3346);border-radius:10px;padding:2px 8px}' +
    '.as-x{margin-left:auto;cursor:pointer;border:1px solid var(--border,#2a3346);border-radius:8px;' +
      'background:var(--bg,#0b0f16);color:var(--text-dim,#8a97ad);padding:4px 12px;font-size:11.5px}' +
    '.as-x:hover{background:var(--bg-raised-hover,#1b2436);color:var(--text-primary,#e6ebf5)}' +
    '.as-x.copied{background:rgba(0,224,145,.15);color:var(--gain,#00e091);border-color:rgba(0,224,145,.4)}' +
    '.as-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}' +
    '.as-tab{padding:5px 12px;border:1px solid var(--border,#2a3346);border-radius:8px;background:var(--bg,#0b0f16);' +
      'color:var(--text-dim,#8a97ad);cursor:pointer;font-size:11.5px;font-weight:700}' +
    '.as-tab.on{border-color:var(--info,#49a8ff);color:var(--info,#49a8ff);background:rgba(73,168,255,.1)}' +
    '.as-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}' +
    '@media (max-width:900px){.as-grid{grid-template-columns:1fr}}' +
    '.as-card{border:1px solid var(--border,#2a3346);border-radius:10px;background:var(--bg,#0b0f16);overflow:hidden;margin-bottom:12px}' +
    '.as-card h4{margin:0;padding:8px 11px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;' +
      'color:var(--text-muted,#66748c);background:var(--bg-header,#0F2447);border-bottom:1px solid var(--border,#2a3346);' +
      'display:flex;align-items:center;justify-content:space-between}' +
    '.as-card .as-b{padding:8px 11px}' +
    '.as-row{display:grid;grid-template-columns:1fr auto;gap:10px;padding:3px 0;font-size:11.5px;' +
      'font-variant-numeric:tabular-nums;border-bottom:1px solid rgba(42,51,70,.28)}' +
    '.as-row:last-child{border-bottom:none}' +
    '.as-row .as-v{font-weight:700}' +
    '.as-row.hi .as-v{color:var(--info,#49a8ff)}' +
    '.as-t{width:100%;border-collapse:collapse;font-size:11px}' +
    '.as-t th,.as-t td{padding:5px 7px;border-bottom:1px solid rgba(42,51,70,.4);text-align:left}' +
    '.as-t td.n{text-align:right;font-variant-numeric:tabular-nums}' +
    '.as-pass{color:var(--gain,#00e091);font-weight:700}' +
    '.as-ok{color:var(--gain,#00e091);font-weight:700}' +
    '.as-no{color:var(--loss,#ff4d6d);font-weight:700}' +
    '.as-warn{color:var(--warn,#ffb02e);font-weight:700}' +
    '.as-FAIL,.as-MISMATCH,.as-refused{color:var(--loss,#ff4d6d);font-weight:800}' +
    '.as-unmeasured{color:var(--text-muted,#66748c)}' +
    '.as-agrees{color:var(--gain,#00e091);font-weight:700}' +
    '.as-both-refused{color:var(--warn,#ffb02e);font-weight:700}' +
    '.as-code{margin:0;padding:10px 12px;background:#080c12;border:1px solid var(--border,#2a3346);border-radius:9px;' +
      'overflow:auto;max-height:46vh;font-size:11px;line-height:1.55;white-space:pre;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c9d6ea}' +
    '.as-head2{display:flex;align-items:center;gap:8px;margin:10px 0 5px;font-size:11px;color:var(--text-muted,#66748c)}' +
    '.as-head2 b{color:var(--info,#49a8ff);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}' +
    '.as-verdict{padding:9px 12px;border-radius:9px;font-size:12px;font-weight:600;line-height:1.55;margin-bottom:10px}' +
    '.as-verdict.ok{background:rgba(0,224,145,.1);border:1px solid rgba(0,224,145,.35);color:var(--gain,#00e091)}' +
    '.as-verdict.no{background:rgba(255,176,46,.1);border:1px solid rgba(255,176,46,.35);color:var(--warn,#ffb02e)}' +
    '.as-verdict.bad{background:rgba(255,77,109,.12);border:1px solid rgba(255,77,109,.45);color:var(--loss,#ff4d6d)}' +
    '.as-meth li{margin-bottom:7px;line-height:1.6;font-size:12px}' +
    '.as-meth b{color:var(--info,#49a8ff)}' +
    '.as-dim{color:var(--text-muted,#66748c)}' +
    '.as-copy-btn{margin-left:8px;cursor:pointer;border:1px solid var(--border,#2a3346);border-radius:6px;' +
      'background:var(--bg,#0b0f16);color:var(--text-dim,#8a97ad);padding:2px 8px;font-size:10px;font-weight:600;' +
      'font-family:inherit;flex-shrink:0}' +
    '.as-copy-btn:hover{background:var(--bg-raised-hover,#1b2436);color:var(--text-primary,#e6ebf5)}' +
    '.as-copy-btn.copied{background:rgba(0,224,145,.15);color:var(--gain,#00e091);border-color:rgba(0,224,145,.4)}';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nf(v, d) { return (v == null || isNaN(v)) ? null : Number(v).toFixed(d == null ? 4 : d); }
  function i18(v) { return (v == null || isNaN(v)) ? null : Number(v).toLocaleString('en-IN'); }

  function val(v, suffix, isText) {
    if (v == null || v === '') return '<span class="as-dim">—</span>';
    if (typeof v === 'boolean') return esc(String(v));
    if (isText || typeof v === 'string') return esc(String(v)) + (suffix ? esc(suffix) : '');
    var n = nf(v, 4);
    return esc(n == null ? String(v) : n) + (suffix ? esc(suffix) : '');
  }
  function arow(label, valueHtml, hi) {
    return '<div class="as-row' + (hi ? ' hi' : '') + '"><span>' + esc(label) +
      '</span><span class="as-v">' + valueHtml + '</span></div>';
  }
  function codeBlock(f) {
    return '<div class="as-head2">the live function that produced these numbers &nbsp;' +
      '<b>' + esc(f.name) + '()</b> — ' + esc(f.file) + ' &nbsp; <button class="as-copy-btn" data-copy-fn="' + esc(f.name) + '">COPY</button></div>' +
      '<pre class="as-code">' + esc(f.code) + '</pre>';
  }

  function mount() {
    if (document.getElementById(OVL_ID)) return;
    if (!document.getElementById(STYLE_ID)) {
      var st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var ovl = document.createElement('div');
    ovl.className = 'as-ovl';
    ovl.id = OVL_ID;
    ovl.innerHTML =
      '<div class="as-sheet">' +
        '<div class="as-head">' +
          '<h2 id="asTitle">Plan</h2>' +
          '<span class="as-chip" id="asMeta">—</span>' +
          '<span class="as-chip" id="asVerdictChip">—</span>' +
          '<button class="as-x" id="asCopyPlan" title="Copy the whole plan">COPY</button>' +
          '<button class="as-x" id="asClose">Close</button>' +
        '</div>' +
        '<div class="as-tabs">' +
          '<div class="as-tab on" data-atab="working">Working</div>' +
          '<div class="as-tab" data-atab="gates">Gates</div>' +
          '<div class="as-tab" data-atab="inputs">Inputs</div>' +
          '<div class="as-tab" data-atab="code">Code</div>' +
          '<div class="as-tab" data-atab="method">Backtest &amp; method</div>' +
          '<div class="as-tab" data-atab="tape">Tape</div>' +
        '</div>' +
        '<div id="asBody"></div>' +
      '</div>';
    document.body.appendChild(ovl);
    bindCopyButton();
  }

  var SHEET = null;
  var TAB = 'working';

  var STATUS_LABEL = { BUY: 'BUY', SHORT: 'SELL', WATCH: 'WAIT', LATE: 'LATE', QUIET: 'NONE' };
  function statusLabel(s) { return STATUS_LABEL[s] || s || 'NONE'; }

  function open(setupId) {
    openPlan('/api/terminal/plan/' + encodeURIComponent(setupId), 'Plan · ' + setupId);
  }

  function openBySymbol(symbol) {
    openPlan('/api/terminal/plan/by-symbol/' + encodeURIComponent(symbol), 'Plan · ' + symbol);
  }

  function openPlan(url, title) {
    mount();
    var ovl = document.getElementById(OVL_ID);
    ovl.classList.add('on');
    TAB = 'working';
    document.getElementById('asTitle').textContent = title;
    document.getElementById('asMeta').textContent = 'loading the working…';
    document.getElementById('asVerdictChip').textContent = '—';
    document.getElementById('asBody').innerHTML = '<div class="as-dim">loading…</div>';
    document.querySelectorAll('.as-tab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-atab') === 'working');
    });

    fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        SHEET = d;
        if (!d || !d.call) throw new Error(d && d.error ? d.error : 'no plan in the snapshot');
        var c = d.call;
        document.getElementById('asTitle').textContent =
          (c.symbol || '?') + ' · ' + (c.engine || '') + ' · ' + (c.setup || '');
        var entryShown = c.entry != null ? c.entry : (d.audit && d.audit.entry != null ? d.audit.entry : null);
        document.getElementById('asMeta').textContent =
          statusLabel(c.status) + ' · ' + (c.signalTime || '') + ' · entry ' +
          (entryShown == null ? '—' : nf(entryShown, 2));
        var v = d.audit && d.audit.verdict;
        var mism = v && v.mismatches ? v.mismatches.length : 0;
        var chip = document.getElementById('asVerdictChip');
        var isCall = d.isCall === true;
        chip.textContent = mism ? ('ARITHMETIC MISMATCH ×' + mism)
          : (isCall ? 'engine accepted — a call'
            : (c.ok ? 'engine working only — not a call' : 'engine refused — still auditable'));
        chip.style.color = mism ? 'var(--loss,#ff4d6d)' : (isCall ? 'var(--gain,#00e091)' : 'var(--warn,#ffb02e)');
        render();
      })
      .catch(function (e) {
        document.getElementById('asBody').innerHTML = '<div class="as-dim">Could not read the plan — ' +
          esc(e.message) + '.</div>';
      });
  }

  function close() { var o = document.getElementById(OVL_ID); if (o) o.classList.remove('on'); }

  function render() {
    var body = document.getElementById('asBody');
    if (!SHEET || (!SHEET.audit && TAB !== 'tape')) {
      body.innerHTML = '<div class="as-dim">' + esc(SHEET && SHEET.error ? SHEET.error : 'no audit') + '</div>';
      return;
    }
    var a = SHEET.audit;
    var v = (a && a.verdict) || {};
    var cls = (v.mismatches && v.mismatches.length) ? 'bad' : (v.engineAccepted ? 'ok' : 'no');
    var isCall = (SHEET.isCall === true)
      || !!(SHEET.call && (SHEET.call.status === 'BUY' || SHEET.call.status === 'SHORT'));
    var out = '';

    if (TAB === 'working') {
      out += '<div class="as-verdict ' + cls + '">' + esc(v.statement) + '</div>';
      var fg = (v.failedGates || []);
      if (fg.length) {
        out += '<div class="as-verdict bad"><b>' + esc(v.summary || 'REJECT') + '</b><table class="as-t" style="margin-top:6px">' +
          fg.map(function (f) {
            return '<tr><td class="as-FAIL">✗ ' + esc(f.gate) + '</td><td>' + esc(f.check || '') +
              (f.detail ? ' <span class="as-dim">' + esc(f.detail) + '</span>' : '') + '</td></tr>';
          }).join('') + '</table></div>';
      } else if (v.engineAccepted) {
        out += '<div class="as-verdict ok">No gate is failing on the recomputation.</div>';
      }
      if (!isCall) {
        out += '<div class="as-verdict no"><b>Not a call — no entry, stop, T1, T2, R:R or risk is printed.</b>' +
          '<div style="margin-top:5px;font-weight:500">Levels are only published for a BUY or a SELL.</div></div>';
      } else {
      out += '<div class="as-grid">';

      out += '<div class="as-card"><h4>Stop — recomputed from raw numbers <button class="as-copy-btn" data-copy-section="stop">COPY</button></h4><div class="as-b">' +
        a.stop.steps.map(function (s, i) {
          return arow(s.label, val(s.value, s.suffix || '', s.text), i === a.stop.steps.length - 2);
        }).join('') + '</div></div>';

      out += '<div class="as-card"><h4>Targets — the nearest opposing structure <button class="as-copy-btn" data-copy-section="targets">COPY</button></h4><div class="as-b">' +
        a.targets.steps.map(function (s) { return arow(s.label, val(s.value, s.suffix || '', s.text)); }).join('') +
        (a.targets.considered.length
          ? '<table class="as-t" style="margin-top:8px"><thead><tr><th>candidate price</th><th class="n">room</th><th>verdict</th></tr></thead><tbody>' +
            a.targets.considered.map(function (t) {
              return '<tr><td>' + val(t.price) + '</td><td class="n">' + val(t.room) + '</td><td>' + esc(t.verdict) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<div class="as-dim" style="margin-top:6px;font-size:11.5px">the engine offered no candidate levels for this plan</div>') +
        '</div></div>';

      out += '<div class="as-card"><h4>Reward : risk, with the division shown <button class="as-copy-btn" data-copy-section="rr">COPY</button></h4><div class="as-b">' +
        a.rewardRisk.steps.map(function (s) { return arow(s.label, val(s.value)); }).join('') +
        arow('minimum acceptable', nf(a.rewardRisk.minRR1, 2) + 'R') +
        arow('verdict', '<span class="as-' + a.rewardRisk.verdict + '">' + esc(a.rewardRisk.verdict) + '</span>' +
          (a.rewardRisk.why ? ' <span class="as-dim">' + esc(a.rewardRisk.why) + '</span>' : '')) +
        '</div></div>';

      out += '<div class="as-card"><h4>Cross-check — what the engine published vs the same arithmetic now <button class="as-copy-btn" data-copy-section="crosscheck">COPY</button></h4><div class="as-b">' +
        '<table class="as-t"><thead><tr><th>field</th><th class="n">the engine published</th><th class="n">recomputed now</th><th>verdict</th></tr></thead><tbody>' +
        a.crossCheck.map(function (c) {
          return '<tr><td>' + esc(c.field) + '</td><td class="n">' + (c.published != null ? val(c.published) : val(c.recomputed)) + '</td>' +
            '<td class="n">' + (c.published != null ? val(c.recomputed) : '<span class="as-dim">—</span>') + '</td>' +
            '<td class="as-' + esc(c.verdict) + '">' + esc(c.verdict) +
            (c.detail ? ' <span class="as-dim">' + esc(c.detail) + '</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';

      out += '</div>';
      }
    }

    if (TAB === 'tape') {
      var t = SHEET.tape;
      var tapeNum = function (v, suffix, signedColour) {
        if (v == null || isNaN(v)) return '—';
        var nv = Number(v);
        var text = (nv > 0 && signedColour ? '+' : '') + nv.toFixed(2) + (suffix || '');
        if (!signedColour) return esc(text);
        return '<span class="as-' + (nv > 0 ? 'ok' : (nv < 0 ? 'no' : 'dim')) + '">' + esc(text) + '</span>';
      };
      var statusCls = function (s) {
        return s === 'BUY' ? 'as-ok' : (s === 'SHORT' ? 'as-no' : (s === 'WATCH' ? 'as-warn' : 'as-dim'));
      };
      if (!t) {
        out += '<div class="as-dim">this plan carries no tape</div>';
      } else {
        var c = SHEET.call || {};
        out += '<div class="as-grid">';

        out += '<div class="as-card"><h4>The tape — the last recorded 1-minute bar <button class="as-copy-btn" data-copy-section="tape">COPY</button></h4><div class="as-b">' +
          arow('price', tapeNum(t.price)) +
          arow('move on the bar', tapeNum(t.changePct, '%', true)) +
          arow('volume, 1 minute', t.vol1m == null ? '—' : Number(t.vol1m).toLocaleString('en-IN')) +
          arow('volume vs its own floor', tapeNum(t.volRatio, '×')) +
          arow('last bar', esc(String(t.lastBarTime || '—'))) +
          '</div></div>';

        out += '<div class="as-card"><h4>Where the price sat <button class="as-copy-btn" data-copy-section="position">COPY</button></h4><div class="as-b">' +
          arow('VWAP', tapeNum(t.vwap)) +
          arow('VWAP distance', tapeNum(t.vwapDistPct, '%', true)) +
          arow('POC (volume point of control)', tapeNum(t.poc)) +
          arow('POC distance', tapeNum(t.pocDistPct, '%', true)) +
          arow("position in the bar's range", t.rangePosPct == null ? '—' : Math.round(t.rangePosPct) + '%') +
          '</div></div>';

        var roc = t.roc || {};
        out += '<div class="as-card"><h4>Rate of change — every horizon at once <button class="as-copy-btn" data-copy-section="roc">COPY</button></h4><div class="as-b">' +
          arow('1 minute', tapeNum(roc['1min'], '%', true)) +
          arow('3 minutes', tapeNum(roc['3min'], '%', true)) +
          arow('5 minutes', tapeNum(roc['5min'], '%', true)) +
          '<div class="as-dim" style="margin-top:6px;font-size:11.5px">10s / 15s / 20s / 30s need the live tick tape.</div>' +
          '</div></div>';

        out += '<div class="as-card"><h4>The call this row named <button class="as-copy-btn" data-copy-section="call">COPY</button></h4><div class="as-b">' +
          arow('call', '<span class="' + statusCls(t.signal) + '">' +
            esc(statusLabel(t.signal)) + '</span> <span class="as-dim">engine status: ' + esc(t.signal || '—') + '</span>') +
          arow('engine · setup', esc(t.engine ? (t.engine + ' · ' + t.setup) : '—')) +
          arow('bars ago', c.barsAgo != null ? c.barsAgo : '—') +
          arow('blocked from the scan', t.blocked ? 'yes — ' + esc(String(t.blockReason || 'unstated')) : 'no') +
          arow('gate', t.gate ? esc('GATE_' + t.gate) : 'none') +
          '</div></div>';

        if (t.flows && t.flows.reason) {
          out += '<div class="as-card"><h4>Flows <button class="as-copy-btn" data-copy-section="flows">COPY</button></h4><div class="as-b">' +
            arow('big buyers', t.flows.bigBuyers == null ? '—' : tapeNum(t.flows.bigBuyers)) +
            arow('reason', esc(String(t.flows.reason))) + '</div></div>';
        }

        out += '</div>';
      }
    }

    if (TAB === 'gates') {
      out += '<div class="as-card"><h4>Extension gate <button class="as-copy-btn" data-copy-section="extgate">COPY</button></h4><div class="as-b">' +
        '<table class="as-t"><thead><tr><th>check</th><th class="n">measured</th><th class="n">threshold</th><th>verdict</th></tr></thead><tbody>' +
        a.extensionGate.rows.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td class="n">' + val(r.value) + '</td>' +
            '<td class="n">' + esc(r.threshold) + '</td><td class="as-' + esc(r.verdict) + '">' + esc(r.verdict) +
            (r.why ? ' <span class="as-dim">' + esc(r.why) + '</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="as-head2">the thresholds this plan was judged against</div>' +
        '<table class="as-t"><tbody>' + Object.keys(a.extensionGate.thresholds).map(function (k) {
          return '<tr><td>' + esc(k) + '</td><td class="n">' + val(a.extensionGate.thresholds[k]) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';

      var vg = a.volumeGate || {};
      out += '<div class="as-card"><h4>Volume gate <button class="as-copy-btn" data-copy-section="volgate">COPY</button></h4><div class="as-b">' +
        arow('threshold', esc(String(vg.threshold))) + arow('measured', val(vg.measured, '×')) +
        arow('verdict', '<span class="as-' + esc(vg.verdict) + '">' + esc(vg.verdict) + '</span>') +
        arow('where the threshold lives', esc(String(vg.source))) +
        '</div></div>';
    }

    if (TAB === 'inputs') {
      out += '<div class="as-card"><h4>Every number the engine read <button class="as-copy-btn" data-copy-section="inputs">COPY</button></h4><div class="as-b">' +
        '<table class="as-t"><thead><tr><th>input</th><th class="n">value</th></tr></thead><tbody>' +
        a.inputs.map(function (r) {
          return '<tr><td>' + esc(r.name) + '</td><td class="n">' + val(r.value, r.suffix || '', r.text) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }

    if (TAB === 'code') {
      var code = SHEET.code || {};
      out += '<div class="as-verdict no">Printed from the live function objects (fn.toString()).</div>';
      out += (code.engine || []).map(codeBlock).join('');
      out += (code.shared || []).map(codeBlock).join('');
      out += (code.fill || []).map(codeBlock).join('');
      if (code.configs) {
        out += '<div class="as-head2">the config this plan was judged against <button class="as-copy-btn" data-copy-section="config">COPY</button></div><pre class="as-code">' +
          esc(JSON.stringify(code.configs, null, 2)) + '</pre>';
      }
    }

    if (TAB === 'method') {
      out += methodHtml(SHEET.method);
      if (SHEET.rules) {
        out += '<div class="as-head2">did this engine measure an edge? <button class="as-copy-btn" data-copy-section="rules">COPY</button></div>' +
          '<table class="as-t"><thead><tr><th>engine</th><th class="n">trades</th><th class="n">net PF</th><th>may put a direction on the board</th></tr></thead><tbody>' +
          SHEET.rules.map(function (r) {
            return '<tr><td>' + esc(r.engine) + '</td><td class="n">' + r.trades + '</td>' +
              '<td class="n">' + (nf(r.netPF, 3) || '—') + '</td><td>' +
              (r.speak ? '<span class="as-pass">yes</span>' + (r.thin ? ' <span class="as-dim">but the sample is thin</span>' : '')
                       : '<span class="as-dim">no — its calls print as WATCH</span>') + '</td></tr>';
          }).join('') + '</tbody></table>';
      }
    }

    body.innerHTML = out;
  }

  function methodHtml(m) {
    if (!m) return '<div class="as-dim">no backtest measurement attached</div>';
    var h = '<div class="as-card"><h4>Backtest method <button class="as-copy-btn" data-copy-section="method">COPY</button></h4><div class="as-b"><ol class="as-meth">' + (m.rules || []).map(function (r) {
      return '<li><b>' + esc(r.title) + '.</b> ' + esc(r.body) + '</li>';
    }).join('') + '</ol></div></div>';
    if (m.corpus) {
      h += arow('corpus', i18(m.corpus.symbols) + ' symbols · ' + i18(m.corpus.bars) + ' one-minute bars') +
        arow('costs tested', (m.costs || []).map(function (c) { return Number(c).toFixed(2) + '%'; }).join(' / '));
    }
    if (m.code) h += m.code.map(codeBlock).join('');
    return h;
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var det = t.closest('[data-plan]');
    if (det) {
      var id = det.getAttribute('data-plan');
      if (id) { open(id); return; }
    }
    var detSym = t.closest('[data-plan-sym]');
    if (detSym) {
      var sym = detSym.getAttribute('data-plan-sym');
      if (sym) { openBySymbol(sym); return; }
    }
    var tab = t.closest('.as-tab');
    if (tab) {
      TAB = tab.getAttribute('data-atab');
      document.querySelectorAll('.as-tab').forEach(function (x) { x.classList.remove('on'); });
      tab.classList.add('on');
      render();
      return;
    }
    if (t.id === 'asClose') { close(); return; }
    if (t.id === OVL_ID) { close(); return; }
  });

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy-fn]');
    if (!btn) return;
    var fnName = btn.getAttribute('data-copy-fn');
    var code = SHEET.code || {};
    var found = null;
    var search = function (arr) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].name === fnName) { found = arr[i]; return; }
      }
    };
    search(code.engine); search(code.shared); search(code.fill);
    if (found) {
      copyToClipboard('function ' + found.name + '() {\n' + found.code + '\n}', function (ok) {
        btn.classList.toggle('copied', ok);
        btn.textContent = ok ? 'Copied!' : 'Copy failed';
        setTimeout(function () {
          btn.classList.remove('copied');
          btn.textContent = 'COPY';
        }, 1500);
      });
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy-section]');
    if (!btn) return;
    var section = btn.getAttribute('data-copy-section');
    var text = buildSectionCopyText(section);
    if (!text) { btn.title = 'Nothing to copy'; return; }
    copyToClipboard(text, function (ok) {
      btn.classList.toggle('copied', ok);
      btn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(function () {
        btn.classList.remove('copied');
        btn.textContent = 'COPY';
      }, 1500);
    });
  });

  function copyLine(label, value, suffix) {
    var v = nf(value, 4);
    if (v == null && value != null && value !== '') v = String(value);
    if (v == null) return label + ': —\n';
    return label + ': ' + v + (suffix || '') + '\n';
  }
  function pctLine(v) {
    var n = nf(v);
    if (n == null) return '—';
    var sign = n > 0 ? '+' : '';
    return sign + n + '%';
  }

  function buildCopyText(d) {
    if (!d || !d.call) return '';
    var c = d.call, t = d.tape;
    var lines = [];
    lines.push('=' + (c.symbol || '?') + ' | ' + (c.engine || '') + ' · ' + (c.setup || '') + ' | ' + (c.signalTime || '') + ' | ' + (c.status || ''));
    lines.push('Call: ' + (c.status === 'SHORT' ? 'SELL' : (c.status === 'BUY' ? 'BUY' : (c.status || '—'))));
    if (t) {
      lines.push('Tape: price ' + (nf(t.price) || '—') + ' · move ' + pctLine(t.changePct) + ' · vol1m ' + (t.vol1m == null ? '—' : Number(t.vol1m).toLocaleString('en-IN')) + '× · volRatio ' + (t.volRatio == null ? '—' : Number(t.volRatio).toFixed(2)) + '× · VWAP ' + (nf(t.vwap) || '—') + ' · VWAP dist ' + (nf(t.vwapDistPct) || '—') + ' · POC ' + (nf(t.poc) || '—') + ' · range pos ' + (t.rangePosPct == null ? '—' : Math.round(t.rangePosPct)) + '% · last bar ' + (t.lastBarTime || '—'));
      lines.push('ROC: 1m ' + pctLine(t.roc && t.roc['1min']) + ' · 3m ' + pctLine(t.roc && t.roc['3min']) + ' · 5m ' + pctLine(t.roc && t.roc['5m']));
      lines.push('Blocked: ' + (t.blocked ? 'yes — ' + (t.blockReason || 'unstated') : 'no') + ' · gate: ' + (t.gate ? 'GATE_' + t.gate : 'none'));
    }
    if (d.audit) {
      var a = d.audit;
      var v = a.verdict;
      lines.push('Verdict: ' + esc((v && v.statement) || '—'));
      lines.push('Call? ' + (d.isCall === true ? 'yes' : (c && (c.status === 'BUY' || c.status === 'SHORT') ? 'yes' : 'no')));
      if (a.stop) lines.push('Stop: entry ' + (nf(a.stop.entry) || '—') + ' · rawStop ' + (nf(a.stop.rawStop) || '—') + ' · stop ' + (nf(a.stop.stop) || '—') + ' · risk ' + (nf(a.stop.risk) || '—') + ' · riskPct ' + pctLine(a.stop.riskPct == null ? null : a.stop.riskPct * 100));
      if (a.targets) {
        var t1 = a.targets.t1, t2 = a.targets.t2;
        lines.push('Targets: T1 ' + (nf(t1) || '—') + ' · T2 ' + (nf(t2) || '—'));
      }
      if (a.rewardRisk) lines.push('Reward/Risk: ' + (nf(a.rewardRisk.rr1) || '—') + 'R (min ' + (nf(a.rewardRisk.minRR1) || '—') + 'R) · verdict ' + (a.rewardRisk.verdict || '—'));
      if (v && v.failedGates && v.failedGates.length) lines.push('Failing gates: ' + v.failedGates.map(function (f) { return f.gate + ' (' + (f.check || '') + ')'; }).join(' · '));
    }
    lines.push('---');
    return lines.join('');
  }

  function buildSectionCopyText(section) {
    if (!SHEET || !SHEET.call) return '';
    var c = SHEET.call, t = SHEET.tape, a = SHEET.audit;
    var lines = [];
    var sym = c.symbol || '?';
    switch (section) {
      case 'stop':
        lines.push(sym + ' — Stop (recomputed from raw numbers)');
        if (a && a.stop) {
          a.stop.steps.forEach(function (s) {
            var v = nf(s.value, 4);
            lines.push('  ' + s.label + ': ' + (v == null ? (s.value != null ? String(s.value) : '—') : v) + (s.suffix || ''));
          });
        }
        break;
      case 'targets':
        lines.push(sym + ' — Targets');
        if (a && a.targets) {
          a.targets.steps.forEach(function (s) {
            var v = nf(s.value, 4);
            lines.push('  ' + s.label + ': ' + (v == null ? (s.value != null ? String(s.value) : '—') : v) + (s.suffix || ''));
          });
          if (a.targets.considered && a.targets.considered.length) {
            lines.push('  Candidates:');
            a.targets.considered.forEach(function (tc) {
              lines.push('    ' + nf(tc.price) + ' — room ' + nf(tc.room) + ' — ' + tc.verdict);
            });
          }
        }
        break;
      case 'rr':
        lines.push(sym + ' — Reward : Risk');
        if (a && a.rewardRisk) {
          a.rewardRisk.steps.forEach(function (s) {
            var v = nf(s.value, 4);
            lines.push('  ' + s.label + ': ' + (v == null ? (s.value != null ? String(s.value) : '—') : v));
          });
          lines.push('  minimum acceptable: ' + nf(a.rewardRisk.minRR1, 2) + 'R');
          lines.push('  verdict: ' + (a.rewardRisk.verdict || '—'));
          if (a.rewardRisk.why) lines.push('  why: ' + a.rewardRisk.why);
        }
        break;
      case 'crosscheck':
        lines.push(sym + ' — Cross-check (engine vs recomputation)');
        if (a && a.crossCheck) {
          a.crossCheck.forEach(function (cc) {
            lines.push('  ' + cc.field + ': published=' + (nf(cc.published) || '—') + ' now=' + (nf(cc.recomputed) || '—') + ' → ' + cc.verdict);
          });
        }
        break;
      case 'tape':
        lines.push(sym + ' — Tape (last 1-min bar)');
        if (t) {
          lines.push('  price: ' + nf(t.price));
          lines.push('  move: ' + pctLine(t.changePct));
          lines.push('  volume 1m: ' + (t.vol1m == null ? '—' : Number(t.vol1m).toLocaleString('en-IN')));
          lines.push('  volRatio: ' + (t.volRatio == null ? '—' : Number(t.volRatio).toFixed(2)));
          lines.push('  VWAP: ' + nf(t.vwap));
          lines.push('  VWAP dist: ' + pctLine(t.vwapDistPct));
          lines.push('  POC: ' + nf(t.poc));
          lines.push('  POC dist: ' + pctLine(t.pocDistPct));
          lines.push('  range pos: ' + (t.rangePosPct == null ? '—' : Math.round(t.rangePosPct) + '%'));
          lines.push('  last bar: ' + (t.lastBarTime || '—'));
        }
        break;
      case 'position':
        lines.push(sym + ' — Price Position');
        if (t) {
          lines.push('  VWAP: ' + nf(t.vwap));
          lines.push('  VWAP dist: ' + pctLine(t.vwapDistPct));
          lines.push('  POC: ' + nf(t.poc));
          lines.push('  POC dist: ' + pctLine(t.pocDistPct));
          lines.push('  range pos: ' + (t.rangePosPct == null ? '—' : Math.round(t.rangePosPct) + '%'));
        }
        break;
      case 'roc':
        lines.push(sym + ' — Rate of Change');
        if (t && t.roc) {
          lines.push('  1m: ' + pctLine(t.roc['1min']));
          lines.push('  3m: ' + pctLine(t.roc['3min']));
          lines.push('  5m: ' + pctLine(t.roc['5min']));
        }
        break;
      case 'call':
        lines.push(sym + ' — Call Details');
        lines.push('  call: ' + statusLabel(c.status) + ' (engine: ' + (c.status || '—') + ')');
        lines.push('  engine · setup: ' + (c.engine ? (c.engine + ' · ' + c.setup) : '—'));
        lines.push('  signal time: ' + (c.signalTime || '—'));
        lines.push('  bars ago: ' + (c.barsAgo != null ? c.barsAgo : '—'));
        if (t) {
          lines.push('  blocked: ' + (t.blocked ? 'yes — ' + (t.blockReason || 'unstated') : 'no'));
          lines.push('  gate: ' + (t.gate ? 'GATE_' + t.gate : 'none'));
        }
        break;
      case 'flows':
        lines.push(sym + ' — Flows');
        if (t && t.flows) {
          lines.push('  big buyers: ' + (t.flows.bigBuyers == null ? '—' : nf(t.flows.bigBuyers)));
          lines.push('  reason: ' + (t.flows.reason || '—'));
        }
        break;
      case 'extgate':
        lines.push(sym + ' — Extension Gate');
        if (a && a.extensionGate) {
          a.extensionGate.rows.forEach(function (r) {
            lines.push('  ' + r.name + ': ' + (nf(r.value) || '—') + ' vs ' + r.threshold + ' → ' + r.verdict);
            if (r.why) lines.push('    why: ' + r.why);
          });
          lines.push('  Thresholds:');
          Object.keys(a.extensionGate.thresholds).forEach(function (k) {
            lines.push('    ' + k + ': ' + (nf(a.extensionGate.thresholds[k]) || a.extensionGate.thresholds[k]));
          });
        }
        break;
      case 'volgate':
        lines.push(sym + ' — Volume Gate');
        if (a && a.volumeGate) {
          lines.push('  threshold: ' + (a.volumeGate.threshold || '—'));
          lines.push('  measured: ' + (nf(a.volumeGate.measured) || a.volumeGate.measured || '—') + '×');
          lines.push('  verdict: ' + (a.volumeGate.verdict || '—'));
          lines.push('  source: ' + (a.volumeGate.source || '—'));
        }
        break;
      case 'inputs':
        lines.push(sym + ' — Inputs (every number the engine read)');
        if (a && a.inputs) {
          a.inputs.forEach(function (r) {
            var v = nf(r.value, 4);
            lines.push('  ' + r.name + ': ' + (v == null ? (r.value != null ? String(r.value) : '—') : v) + (r.suffix || ''));
          });
        }
        break;
      case 'config':
        lines.push(sym + ' — Config');
        if (SHEET.code && SHEET.code.configs) {
          lines.push(JSON.stringify(SHEET.code.configs, null, 2));
        }
        break;
      case 'method':
        lines.push(sym + ' — Backtest Method');
        var m = SHEET.method;
        if (m) {
          (m.rules || []).forEach(function (r) {
            lines.push('  ' + r.title + '. ' + r.body);
          });
          if (m.corpus) {
            lines.push('  corpus: ' + i18(m.corpus.symbols) + ' symbols · ' + i18(m.corpus.bars) + ' bars');
            lines.push('  costs tested: ' + (m.costs || []).map(function (c) { return Number(c).toFixed(2) + '%'; }).join(' / '));
          }
        }
        break;
      case 'rules':
        lines.push(sym + ' — Engine Rules');
        if (SHEET.rules) {
          SHEET.rules.forEach(function (r) {
            lines.push('  ' + r.engine + ': ' + r.trades + ' trades, net PF ' + (nf(r.netPF, 3) || '—'));
            lines.push('    speak: ' + (r.speak ? 'yes' + (r.thin ? ' (thin sample)' : '') : 'no — calls print as WATCH'));
          });
        }
        break;
      default:
        return '';
    }
    lines.push('---');
    return lines.join('');
  }

  function copyPlanButtonHtml() {
    return '<button class="as-x" id="asCopyPlan" title="Copy everything this plan knows to the clipboard">COPY</button>';
  }
  function bindCopyButton() {
    var ovl = document.getElementById(OVL_ID);
    if (!ovl) return;
    var btn = ovl.querySelector('#asCopyPlan');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var text = SHEET && SHEET.call ? buildCopyText(SHEET) : '';
      if (!text) { btn.title = 'Nothing to copy'; return; }
      copyToClipboard(text, function (ok) {
        btn.classList.toggle('copied', ok);
        btn.textContent = ok ? 'Copied!' : 'Copy failed';
        btn.title = ok ? 'Copied the plan' : 'Copy failed — paste manually from the sheet';
        setTimeout(function () {
          if (btn) {
            btn.classList.remove('copied');
            btn.textContent = 'COPY';
            btn.title = 'Copy the whole plan';
          }
        }, 2000);
      });
    });
  }

  function copyToClipboard(text, cb) {
    var done = false;
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done = true; if (cb) cb(true); })
        .catch(function () { /* fall through to manual path */ });
    }
    if (done) return;
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

  window.AuditSheet = { open: open, openBySymbol: openBySymbol, close: close, esc: esc, nf: nf, i18: i18, codeBlock: codeBlock };
})();

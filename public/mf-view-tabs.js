// MF View Tabs - Summary / Ranks / Risk vs Reward
// Injects tab buttons above the mutual fund table and switches columns
(function(){
  if(window._mfTabsInit) return;
  window._mfTabsInit = true;
  var currentTab = 'summary';
  var lastSchemes = null;

  // Build Summary table from scheme data
  function buildSummaryTable(schemes) {
    var tH = "padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;";
    var thead = '<th style="'+tH+'width:28px;"></th>'
      +'<th style="'+tH+'text-align:left;">Scheme name</th>'
      +'<th style="'+tH+'text-align:right;">Score /100</th>'
      +'<th style="'+tH+'text-align:right;">AUM (\u20B9 Cr)</th>'
      +'<th style="'+tH+'text-align:right;">Net expense ratio</th>'
      +'<th style="'+tH+'text-align:right;">Investors</th>'
      +'<th style="'+tH+'text-align:right;">Investor growth</th>'
      +'<th style="'+tH+'text-align:right;">Day change %</th>'
      +'<th style="'+tH+'text-align:right;">1 month %</th>'
      +'<th style="'+tH+'text-align:right;">3 month %</th>'
      +'<th style="'+tH+'text-align:right;">6 month %</th>'
      +'<th style="'+tH+'text-align:right;">1 year %</th>';

    function fp(v){ return (v>=0?"+":"")+v.toFixed(2)+"%"; }
    function rc2(v){ if(v==null) return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>'; var cl=v>=0?"#00B386":"#EB5B56"; return '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+fp(v)+'</td>'; }
    function rn2(sc){ var bg=sc>=80?"rgba(0,179,134,0.2)":sc>=60?"rgba(245,158,11,0.2)":"rgba(235,91,86,0.2)",fg=sc>=80?"#00B386":sc>=60?"#F59E0B":"#EB5B56"; return '<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+'</span></td>'; }
    function ic2(ch){ if(!ch||ch.change==null) return '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>'; var p=ch.changePct||0,cl=ch.change>=0?"#00B386":"#EB5B56",a=ch.change>=0?"\u25B2":"\u25BC",v=Math.abs(ch.change),vs=v>=100000?(v/100000).toFixed(1)+"L":v>=1000?(v/1000).toFixed(1)+"K":v.toFixed(0); return '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+' '+vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?"+":"")+p.toFixed(1)+"%)</span></td>"; }
    function fi(v){ if(Math.abs(v)>=100000) return (v/100000).toFixed(1)+"L"; if(Math.abs(v)>=1000) return (v/1000).toFixed(1)+"K"; return v.toFixed(0); }

    var rows = schemes.map(function(s){
      var nm = s.schemeName || '';
      var ct = s.category || '';
      var iv = s.investorChange1M;
      var ivGrowth = (iv && iv.changePct != null) ? iv.changePct : null;
      var score = s.confidenceScore || 50;

      var ivCell;
      if(iv && iv.change != null) {
        var p = iv.changePct || 0, cl = iv.change >= 0 ? "#00B386" : "#EB5B56", a = iv.change >= 0 ? "\u25B2" : "\u25BC";
        var v = Math.abs(iv.change), vs = fi(v);
        ivCell = '<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+' '+vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?"+":"")+p.toFixed(1)+'%)</span></td>';
      } else {
        ivCell = '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';
      }

      return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" data-cat="'+ct+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'">'
        +'<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
        +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);font-weight:400;margin-top:2px;">'+ct+'</div></td>'
        +rn2(score)
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(s.aumCr!=null?'\u20B9'+Number(s.aumCr).toLocaleString("en-IN",{maximumFractionDigits:0})+' Cr':'-')+'</td>'
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+(s.ter!=null?s.ter.toFixed(2)+'%':'-')+'</td>'
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;white-space:nowrap;">'+(s.investorCount!=null?(s.investorCount>10000?(s.investorCount/100000).toFixed(2)+'L':s.investorCount.toLocaleString("en-IN")):'-')+'</td>'
        +ivCell
        +rc2(s.returns && s.returns['1D'] != null ? s.returns['1D'] : null)
        +rc2(s.returns && s.returns['1M'] != null ? s.returns['1M'] : null)
        +rc2(s.returns && s.returns['3M'] != null ? s.returns['3M'] : null)
        +rc2(s.returns && s.returns['6M'] != null ? s.returns['6M'] : null)
        +rc2(s.returns && s.returns['1Y'] != null ? s.returns['1Y'] : null)
        +'</tr>';
    }).join('');

    return '<thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">'+thead+'</tr></thead><tbody>'+rows+'</tbody>';
  }

  // Build Ranks table
  function buildRanksTable(schemes) {
    var tH = "padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;";
    var thead = '<th style="'+tH+'width:28px;"></th>'
      +'<th style="'+tH+'text-align:left;">Scheme name</th>'
      +'<th style="'+tH+'text-align:right;">Checklist score / 100</th>'
      +'<th style="'+tH+'text-align:right;">Performance / 25</th>'
      +'<th style="'+tH+'text-align:right;">Portfolio / 25</th>'
      +'<th style="'+tH+'text-align:right;">Operational / 25</th>'
      +'<th style="'+tH+'text-align:right;">Risk & Reward / 25</th>';

    function rn2(sc){ var bg=sc>=80?"rgba(0,179,134,0.2)":sc>=60?"rgba(245,158,11,0.2)":"rgba(235,91,86,0.2)",fg=sc>=80?"#00B386":sc>=60?"#F59E0B":"#EB5B56"; return '<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+'</span></td>'; }

    var rows = schemes.map(function(s){
      var nm = s.schemeName || '';
      var ct = s.category || '';
      var sc = s.confidenceScore || 50;
      var pf = Math.round(sc * 0.25);
      var po = Math.round(sc * 0.22);
      var op = Math.round(sc * 0.26);
      var rw = sc - pf - po - op;

      return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" data-cat="'+ct+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'">'
        +'<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
        +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);font-weight:400;margin-top:2px;">'+ct+'</div></td>'
        +rn2(sc)
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+pf+'/25</td>'
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+po+'/25</td>'
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+op+'/25</td>'
        +'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);">'+rw+'/25</td>'
        +'</tr>';
    }).join('');

    return '<thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">'+thead+'</tr></thead><tbody>'+rows+'</tbody>';
  }

  // Build Risk vs Reward table
  function buildRiskTable(schemes) {
    var tH = "padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;";
    var riskKeys = ['Alpha','Beta','Sharpe','Sortino'];
    var riskPeriods = ['1M','3M','6M','1Y'];

    var thead = '<th style="'+tH+'width:28px;"></th>'
      +'<th style="'+tH+'text-align:left;">Scheme name</th>';
    for(var rk=0;rk<riskKeys.length;rk++) {
      for(var rp=0;rp<riskPeriods.length;rp++) {
        thead += '<th style="'+tH+'text-align:right;">'+riskKeys[rk]+' '+riskPeriods[rp]+'</th>';
      }
    }

    var rows = schemes.map(function(s){
      var nm = s.schemeName || '';
      var ct = s.category || '';
      var m = s.metrics || {};

      var cells = '<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>'
        +'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);font-weight:400;margin-top:2px;">'+ct+'</div></td>';

      for(var rk=0;rk<riskKeys.length;rk++) {
        for(var rp=0;rp<riskPeriods.length;rp++) {
          var k = riskKeys[rk]+riskPeriods[rp];
          var v = m[k];
          if(v == null) {
            cells += '<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';
          } else {
            var cl = v >= 0 ? "#00B386" : "#EB5B56";
            cells += '<td style="padding:10px 12px;text-align:right;color:'+cl+';font-size:12px;font-weight:600;">'+v.toFixed(2)+'</td>';
          }
        }
      }

      return '<tr style="border-bottom:1px solid var(--line);cursor:pointer;" data-cat="'+ct+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'">'+cells+'</tr>';
    }).join('');

    return '<thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">'+thead+'</tr></thead><tbody>'+rows+'</tbody>';
  }

  // Inject tabs and replace table
  function injectTabsAndTable(tableEl, schemes) {
    lastSchemes = schemes;

    // Check if tabs already exist
    if(document.getElementById('mfViewTabs')) {
      // Just update the active state
      updateTabStyles();
      return;
    }

    // Create tab container
    var tabDiv = document.createElement('div');
    tabDiv.id = 'mfViewTabs';
    tabDiv.style.cssText = 'display:flex;gap:6px;margin-bottom:12px;align-items:center;';

    var label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text-muted);font-weight:600;margin-right:6px;';
    label.textContent = 'View:';
    tabDiv.appendChild(label);

    var tabs = [{k:'summary',l:'Summary'},{k:'ranks',l:'Ranks'},{k:'risk',l:'Risk vs Reward'}];
    tabs.forEach(function(t){
      var btn = document.createElement('button');
      btn.className = 'mf-view-tab-btn';
      btn.dataset.tab = t.k;
      btn.textContent = t.l;
      btn.style.cssText = 'background:var(--bg-input);color:var(--text-muted);border:1px solid var(--line);padding:5px 14px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;';
      btn.addEventListener('click', function(){
        currentTab = t.k;
        updateTabStyles();
        rebuildTable();
      });
      tabDiv.appendChild(btn);
    });

    // Insert tabs before the table wrapper
    tableEl.parentNode.insertBefore(tabDiv, tableEl);
    updateTabStyles();
  }

  function updateTabStyles() {
    var btns = document.querySelectorAll('.mf-view-tab-btn');
    btns.forEach(function(b){
      if(b.dataset.tab === currentTab) {
        b.style.background = 'var(--accent)';
        b.style.color = '#fff';
        b.style.borderColor = 'var(--accent)';
      } else {
        b.style.background = 'var(--bg-input)';
        b.style.color = 'var(--text-muted)';
        b.style.borderColor = 'var(--line)';
      }
    });
  }

  function rebuildTable() {
    var table = document.querySelector('[data-mf-table] table');
    if(!table) {
      // Fallback: find table inside overflow-x:auto div
      var divs = document.querySelectorAll('div[style*="overflow-x"]');
      for(var i=0;i<divs.length;i++){
        var t = divs[i].querySelector('table');
        if(t && t.querySelector('tbody') && t.querySelector('tbody').children.length > 0) {
          table = t;
          break;
        }
      }
    }
    if(!table || !lastSchemes) return;

    var html;
    if(currentTab === 'ranks') {
      html = buildRanksTable(lastSchemes);
    } else if(currentTab === 'risk') {
      html = buildRiskTable(lastSchemes);
    } else {
      html = buildSummaryTable(lastSchemes);
    }
    table.innerHTML = html;
  }

  // Find the table wrapper
  function findTableWrapper() {
    // Method 1: data-mf-table attribute
    var el = document.querySelector('[data-mf-table]');
    if(el) return el;

    // Method 2: div with overflow-x that contains a table
    var divs = document.querySelectorAll('div');
    for(var i=0;i<divs.length;i++){
      if(divs[i].style.overflowX === 'auto' || divs[i].getAttribute('style','').indexOf('overflow-x')!==-1) {
        if(divs[i].querySelector('table')) return divs[i].parentElement || divs[i];
      }
    }

    // Method 3: any div containing table with tbody rows
    for(var i=0;i<divs.length;i++){
      var tbl = divs[i].querySelector('table');
      if(tbl && tbl.querySelector('tbody') && divs[i].style.borderRadius) return divs[i];
    }

    return null;
  }

  // Observer for table appearing
  var injected = false;
  function tryInject() {
    var wrapper = findTableWrapper();
    if(!wrapper) return false;

    // Check for table rows with data
    var tbody = wrapper.querySelector('tbody');
    if(!tbody || tbody.children.length === 0) return false;

    // Get schemes from window._mfLastSchemes
    var schemes = window._mfLastSchemes;
    if(!schemes || schemes.length === 0) return false;

    injectTabsAndTable(wrapper, schemes);
    injected = true;
    return true;
  }

  // MutationObserver on the smart-money view
  var observer = new MutationObserver(function(mutations) {
    if(injected) {
      // Table was re-rendered (e.g., category filter), re-inject
      var wrapper = findTableWrapper();
      if(wrapper) {
        var schemes = window._mfLastSchemes;
        if(schemes && schemes.length > 0) {
          injectTabsAndTable(wrapper, schemes);
        }
      }
      return;
    }
    tryInject();
  });

  // Start observing
  var startObserving = function() {
    var target = document.getElementById('view-smart-money');
    if(target) {
      observer.observe(target, {childList:true, subtree:true});
      // Also try immediately
      tryInject();
    }
  };

  // Poll for the smart-money view to exist
  var pollCount = 0;
  var maxPolls = 120; // 60 seconds
  var pollTimer = setInterval(function(){
    pollCount++;
    if(pollCount > maxPolls) { clearInterval(pollTimer); return; }

    if(!injected) {
      tryInject();
    }

    if(pollCount === 5) {
      startObserving();
    }
  }, 500);

  // Also listen for when user clicks smart-money nav
  document.addEventListener('click', function(e) {
    var navItem = e.target.closest('[data-nav="smart-money"]');
    if(navItem) {
      injected = false;
      setTimeout(function(){
        tryInject();
      }, 1000);
    }
  });
})();

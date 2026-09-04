// MF View Tabs - Summary / Ranks / Risk vs Reward
// Uses only MutationObserver - no override of renderMfGrid needed
(function(){
  if(window._mfTabsInit) return;
  window._mfTabsInit = true;

  var _currentTab = 'Summary';
  var _lastSchemes = [];
  var _metricsData = {};
  var _injected = false;

  // Fetch metrics
  fetch('/api/mutual-funds/metrics').then(function(r){return r.json();}).then(function(d){
    if(d&&d.success&&d.metrics) _metricsData=d.metrics;
  }).catch(function(){});

  function calcScore(s){
    var perf=0,port=0,oper=0,risk=0;
    var r=s.returns||{};
    var avg=((r['1M']||0)+(r['3M']||0)+(r['6M']||0)+(r['1Y']||0))/4;
    if(avg>0)perf+=6;if(avg>5)perf+=4;if(avg>10)perf+=4;if(avg>15)perf+=3;if(avg>20)perf+=3;if((r['1Y']||0)>15)perf+=3;perf=Math.min(perf,25);
    var h=(s.topHoldings||[]).length;if(h>0)port+=5;if(h>10)port+=5;if(h>20)port+=5;if(s.aumCr&&s.aumCr>5000)port+=5;if(s.aumCr&&s.aumCr>20000)port+=5;port=Math.min(port,25);
    if(s.expenseRatio){if(s.expenseRatio<2)oper+=5;if(s.expenseRatio<1)oper+=5;if(s.expenseRatio<0.5)oper+=5;if(s.expenseRatio<0.3)oper+=5;}if(s.investorCount&&s.investorCount>500000)oper+=5;oper=Math.min(oper,25);
    risk=Math.round(((s.confidenceScore||50)/100)*25);
    return{total:Math.min(perf+port+oper+risk,100),perf:perf,port:port,oper:oper,risk:risk};
  }

  function fp(v){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?"#00B386":"#EB5B56";return'<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?"+":"")+v.toFixed(2)+'%</td>';}
  function fp1(v){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?"#00B386":"#EB5B56";return'<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?"+":"")+v.toFixed(1)+'%</td>';}
  function fAum(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(v!=null?"\u20b9"+Number(v).toLocaleString("en-IN",{maximumFractionDigits:0})+" Cr":"-")+'</td>';}
  function fInv(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;white-space:nowrap;">'+(v!=null?(v>100000?(v/100000).toFixed(2)+"L":v.toLocaleString("en-IN")):"-")+'</td>';}
  function fTer(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v!=null?v.toFixed(2)+"%":"-")+'</td>';}
  function fScore(sc){var bg=sc>=80?"rgba(0,179,134,0.2)":sc>=60?"rgba(245,158,11,0.2)":"rgba(235,91,86,0.2)";var fg=sc>=80?"#00B386":sc>=60?"#F59E0B":"#EB5B56";return'<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+'</span></td>';}
  function fName(s){var nm=s.schemeName||'';var ct=s.category||'';return'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+ct+'</div></td>';}
  function fRank(v){return'<td style="padding:10px 12px;text-align:center;font-size:12px;">'+v+'/25</td>';}
  function fMet(v,k){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">--</td>';if(k.indexOf('alpha')!==-1){var cl=v>=0?"#00B386":"#EB5B56";return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:'+cl+';font-weight:600;">'+(v>0?"+":"")+(v*100).toFixed(2)+'%</td>';}if(k.indexOf('stdDev')!==-1)return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v*100).toFixed(2)+'%</td>';return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+v.toFixed(2)+'</td>';}
  function tH(){return'padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;';}
  function th(l){return'<th style="'+tH()+'text-align:right;">'+l+'</th>';}
  function thL(l){return'<th style="'+tH()+'text-align:left;">'+l+'</th>';}
  function thC(l){return'<th style="'+tH()+'text-align:center;">'+l+'</th>';}
  function rowStart(s){var sid=(s.id||'').replace(/'/g,"\\\\");return'<tr class="vtab-row" data-cat="'+(s.category||'')+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\x27'+sid+'\x27)">';}

  function buildSummary(schemes){
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH()+'width:28px;"></th>'+thL('Scheme name')+thC('Score /100')+th('AUM (\u20b9 Cr)')+th('Net expense ratio')+th('Investors')+th('Investor growth')+th('Day change %')+th('1 month %')+th('3 month %')+th('6 month %')+th('1 year %');
    h+='</tr></thead><tbody>';
    schemes.forEach(function(s){
      var sc=calcScore(s),r=s.returns||{};
      var iv=s.investorChange1M;
      var dayV=r['1D']||r['day']||null;
      h+=rowStart(s)+fName(s)+fScore(sc.total)+fAum(s.aumCr)+fTer(s.expenseRatio)+fInv(s.investorCount)+fp1(iv&&iv.changePct!=null?iv.changePct:null)+fp(dayV)+fp(r['1M'])+fp(r['3M'])+fp(r['6M'])+fp(r['1Y'])+'</tr>';
    });
    return h+'</tbody></table>';
  }

  function buildRanks(schemes){
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH()+'width:28px;"></th>'+thL('Scheme name')+thC('Checklist score / 100')+th('Performance /25')+th('Portfolio /25')+th('Operational /25')+th('Risk & Reward /25');
    h+='</tr></thead><tbody>';
    schemes.forEach(function(s){
      var sc=calcScore(s);
      h+=rowStart(s)+fName(s)+fScore(sc.total)+fRank(sc.perf)+fRank(sc.port)+fRank(sc.oper)+fRank(sc.risk)+'</tr>';
    });
    return h+'</tbody></table>';
  }

  function buildRisk(schemes){
    var mc=[['alpha_1m','Alpha 1M'],['alpha_3m','Alpha 3M'],['alpha_6m','Alpha 6M'],['alpha_1y','Alpha 1Y'],['beta_1m','Beta 1M'],['beta_3m','Beta 3M'],['beta_6m','Beta 6M'],['beta_1y','Beta 1Y'],['sharpe_1m','Sharpe 1M'],['sharpe_3m','Sharpe 3M'],['sharpe_6m','Sharpe 6M'],['sharpe_1y','Sharpe 1Y'],['sortino_1m','Sortino 1M'],['sortino_3m','Sortino 3M'],['sortino_6m','Sortino 6M'],['sortino_1y','Sortino 1Y']];
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:2400px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH()+'width:28px;"></th>'+thL('Scheme name');
    mc.forEach(function(c){h+=th(c[1]);});
    h+='</tr></thead><tbody>';
    schemes.forEach(function(s){
      var m=_metricsData[s.id]||{};
      h+=rowStart(s)+fName(s);
      mc.forEach(function(c){h+=fMet(m[c[0]],c[0]);});
      h+='</tr>';
    });
    return h+'</tbody></table>';
  }

  // Extract scheme data from the existing table rows (built by _renderMfGridBody)
  function extractSchemesFromDOM(){
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid) return [];
    var rows=grid.querySelectorAll('tr.mf-table-row');
    if(rows.length===0) return [];
    // We need the original data objects, not DOM parsing
    // The data is in window._mfLastSchemes
    return window._mfLastSchemes||[];
  }

  function findTableWrapper(grid){
    // The table wrapper is a div containing overflow-x:auto with a table inside
    var divs=grid.querySelectorAll('div');
    for(var i=0;i<divs.length;i++){
      var d=divs[i];
      if(d.querySelector('table')&&d.querySelector('thead')&&d.getAttribute('style')&&d.getAttribute('style').indexOf('overflow-x:auto')!==-1){
        return d;
      }
    }
    return null;
  }

  function tryInject(){
    if(_injected) return;
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid) return;
    var rows=grid.querySelectorAll('tr.mf-table-row');
    if(rows.length===0) return;

    var schemes=extractSchemesFromDOM();
    if(schemes.length===0) return;

    _lastSchemes=schemes;
    var tableWrap=findTableWrapper(grid);
    if(!tableWrap) return;

    _injected=true;

    // Create view tab buttons
    var tabsDiv=document.createElement('div');
    tabsDiv.style.cssText='display:flex;gap:6px;margin:12px 0;align-items:center;';
    var tabDefs=[{k:'Summary',l:'Summary'},{k:'Ranks',l:'Ranks'},{k:'Risk',l:'Risk vs Reward'}];
    tabDefs.forEach(function(td){
      var btn=document.createElement('button');
      btn.className='mf-vtab';
      btn.setAttribute('data-vtab',td.k);
      btn.textContent=td.l;
      var a=_currentTab===td.k;
      btn.style.cssText='padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid '+(a?"#00B386":"var(--line)")+';background:'+(a?"#00B386":"var(--bg-input)")+';color:'+(a?"#fff":"var(--text-muted)")+';transition:all .15s;font-family:inherit;';
      btn.addEventListener('click',function(){
        _currentTab=td.k;
        tabsDiv.querySelectorAll('.mf-vtab').forEach(function(b){
          var isActive=b.getAttribute('data-vtab')===td.k;
          b.style.background=isActive?"#00B386":"var(--bg-input)";
          b.style.color=isActive?"#fff":"var(--text-muted)";
          b.style.borderColor=isActive?"#00B386":"var(--line)";
        });
        if(td.k==='Summary') tableWrap.innerHTML=buildSummary(_lastSchemes);
        else if(td.k==='Ranks') tableWrap.innerHTML=buildRanks(_lastSchemes);
        else tableWrap.innerHTML=buildRisk(_lastSchemes);
      });
      tabsDiv.appendChild(btn);
    });

    tableWrap.parentNode.insertBefore(tabsDiv,tableWrap);
    tableWrap.innerHTML=buildSummary(_lastSchemes);
  }

  // Watch for grid population using MutationObserver
  var obs=new MutationObserver(function(){
    tryInject();
  });
  var g=document.getElementById('mfSchemesGrid');
  if(g) obs.observe(g,{childList:true,subtree:true});

  // Also try at intervals in case observer misses it
  var attempts=0;
  var timer=setInterval(function(){
    attempts++;
    tryInject();
    if(_injected||attempts>30) clearInterval(timer);
  },500);
})();

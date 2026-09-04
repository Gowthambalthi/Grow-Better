// MF View Tab Switching - Summary / Ranks / Risk vs Reward
// Injected via MutationObserver after the grid renders
(function(){
  var _currentTab = 'Summary';
  var _schemes = [];
  var _metrics = {};
  
  // Load risk metrics
  fetch('/api/mutual-funds/metrics').then(function(r){return r.json();}).then(function(d){
    if(d&&d.success&&d.metrics) _metrics=d.metrics;
  }).catch(function(){});
  
  // Capture schemes when renderMfGrid is called
  var _origRender = window.renderMfGrid;
  window.renderMfGrid = function(schemes) {
    _schemes = schemes || [];
    if (_origRender) _origRender(schemes);
  };
  
  function calcScore(s) {
    var perf=0,port=0,oper=0,risk=0;
    var r=s.returns||{};
    var avg=((r['1M']||0)+(r['3M']||0)+(r['6M']||0)+(r['1Y']||0))/4;
    if(avg>0)perf+=6;if(avg>5)perf+=4;if(avg>10)perf+=4;if(avg>15)perf+=3;if(avg>20)perf+=3;if((r['1Y']||0)>15)perf+=3;perf=Math.min(perf,25);
    var h=(s.topHoldings||[]).length;if(h>0)port+=5;if(h>10)port+=5;if(h>20)port+=5;if(s.aumCr&&s.aumCr>5000)port+=5;if(s.aumCr&&s.aumCr>20000)port+=5;port=Math.min(port,25);
    if(s.expenseRatio){if(s.expenseRatio<2)oper+=5;if(s.expenseRatio<1)oper+=5;if(s.expenseRatio<0.5)oper+=5;if(s.expenseRatio<0.3)oper+=5;}if(s.investorCount&&s.investorCount>500000)oper+=5;oper=Math.min(oper,25);
    risk=Math.round(((s.confidenceScore||50)/100)*25);
    return{total:Math.min(perf+port+oper+risk,100),perf:perf,port:port,oper:oper,risk:risk};
  }
  
  function fmtAum(v){return v!=null?'\u20b9'+Number(v).toLocaleString('en-IN',{maximumFractionDigits:0})+' Cr':'-';}
  function fmtInv(v){return v!=null?(v>10000?(v/100000).toFixed(2)+'L':v.toLocaleString('en-IN')):'-';}
  function fmtPct(v){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?'#00B386':'#EB5B56';return'<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?'+':'')+v.toFixed(2)+'%</td>';}
  function fmtMetric(v,d){if(v==null)return'--';return d?(v*100).toFixed(2)+(d==='pct'?'%':''):v.toFixed(2);}
  
  function buildRanksTable() {
    var tH='padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;';
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH+'width:28px;"></th><th style="'+tH+'text-align:left;">Scheme name</th>';
    h+='<th style="'+tH+'text-align:center;">Score /100</th><th style="'+tH+'text-align:right;">Perf /25</th>';
    h+='<th style="'+tH+'text-align:right;">Portfolio /25</th><th style="'+tH+'text-align:right;">Operational /25</th>';
    h+='<th style="'+tH+'text-align:right;">Reward /25</th></tr></thead><tbody>';
    _schemes.forEach(function(s){
      var sc=calcScore(s),nm=s.schemeName||'',sid=(s.id||'').replace(/'/g,'\\\\');
      h+='<tr class="mf-table-row" data-cat="'+(s.category||'')+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\''+sid+'\')">';
      h+='<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>';
      h+='<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+(s.category||'')+'</div></td>';
      var bgc=sc.total>=80?'rgba(0,179,134,0.2)':sc.total>=60?'rgba(245,158,11,0.2)':'rgba(235,91,86,0.2)';
      var fgc=sc.total>=80?'#00B386':sc.total>=60?'#F59E0B':'#EB5B56';
      h+='<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bgc+';color:'+fgc+';font-size:11px;font-weight:800;">'+sc.total+'</span></td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.perf+'/25</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.port+'/25</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.oper+'/25</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.risk+'/25</td></tr>';
    });
    return h+'</tbody></table>';
  }
  
  function buildRiskTable() {
    var tH='padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;';
    var mc=[['alpha_1m','Alpha 1M'],['alpha_1y','Alpha 1Y'],['alpha_3y','Alpha 3Y'],['beta_1m','Beta 1M'],['beta_1y','Beta 1Y'],['beta_3y','Beta 3Y'],['sharpe_1m','Sharpe 1M'],['sharpe_1y','Sharpe 1Y'],['sharpe_3y','Sharpe 3Y'],['sortino_1m','Sortino 1M'],['sortino_1y','Sortino 1Y'],['sortino_3y','Sortino 3Y'],['treynor_1m','Treynor 1M'],['treynor_1y','Treynor 1Y'],['treynor_3y','Treynor 3Y'],['stdDev_1m','StdDev 1M'],['stdDev_1y','StdDev 1Y'],['stdDev_3y','StdDev 3Y']];
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:1800px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH+'width:28px;"></th><th style="'+tH+'text-align:left;">Scheme name</th>';
    mc.forEach(function(c){h+='<th style="'+tH+'text-align:right;">'+c[1]+'</th>';});
    h+='<th style="'+tH+'text-align:right;">AUM</th><th style="'+tH+'text-align:right;">Expense</th><th style="'+tH+'text-align:right;">Investors</th></tr></thead><tbody>';
    _schemes.forEach(function(s){
      var m=_metrics[s.id]||{},nm=s.schemeName||'',sid=(s.id||'').replace(/'/g,'\\\\');
      h+='<tr class="mf-table-row" data-cat="'+(s.category||'')+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\''+sid+'\')">';
      h+='<td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>';
      h+='<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+(s.category||'')+'</div></td>';
      mc.forEach(function(c){
        var v=m[c[0]];
        if(v!=null){
          if(c[0].indexOf('alpha')!==-1){var sg=v>0?'+':'';var cl=v>=0?'#00B386':'#EB5B56';h+='<td style="padding:10px 12px;text-align:right;font-size:12px;color:'+cl+';font-weight:600;">'+sg+(v*100).toFixed(2)+'%</td>';}
          else if(c[0].indexOf('stdDev')!==-1){h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v*100).toFixed(2)+'%</td>';}
          else{h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+v.toFixed(2)+'</td>';}
        }else{h+='<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">--</td>';}
      });
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;">'+fmtAum(s.aumCr)+'</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(s.expenseRatio!=null?s.expenseRatio.toFixed(2)+'%':'-')+'</td>';
      h+='<td style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;">'+fmtInv(s.investorCount)+'</td></tr>';
    });
    return h+'</tbody></table>';
  }
  
  function switchTab(tab) {
    _currentTab = tab;
    // Update button styles
    document.querySelectorAll('.mf-vtab').forEach(function(b){
      var a=b.getAttribute('data-vtab')===tab;
      b.style.background=a?'#00B386':'var(--bg-input)';
      b.style.color=a?'#fff':'var(--text-muted)';
      b.style.borderColor=a?'#00B386':'var(--line)';
    });
    if(tab==='Summary') {
      // Re-render original table
      var grid=document.getElementById('mfSchemesGrid');
      if(grid) {
        var wrap=grid.querySelector('div[style*="overflow"]');
        if(wrap) wrap.innerHTML=''; // Clear so renderMfGrid rebuilds
      }
      if(_origRender) _origRender(_schemes);
    } else {
      // Replace table content
      var grid2=document.getElementById('mfSchemesGrid');
      if(!grid2) return;
      var wrap2=grid2.querySelector('div[style*="overflow"]');
      if(!wrap2) return;
      wrap2.innerHTML=tab==='Ranks'?buildRanksTable():buildRiskTable();
    }
  }
  
  // Inject tab buttons via MutationObserver
  var obs=new MutationObserver(function(){
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid||document.querySelector('.mf-vtab')) return;
    // Find the category tabs div
    var catDiv=grid.querySelector('div[style*="flex-wrap"]');
    if(!catDiv||catDiv.parentNode!==grid) return;
    var td=document.createElement('div');
    td.style.cssText='display:flex;gap:6px;margin:12px 0;align-items:center;';
    ['Summary','Ranks','Risk vs Reward'].forEach(function(tb){
      var key=tb==='Risk vs Reward'?'Risk':tb;
      var b=document.createElement('button');
      b.className='mf-vtab';
      b.setAttribute('data-vtab',key);
      b.textContent=tb;
      b.style.cssText='padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid '+(key==='Summary'?'#00B386':'var(--line)')+';background:'+(key==='Summary'?'#00B386':'var(--bg-input)')+';color:'+(key==='Summary'?'#fff':'var(--text-muted)')+';transition:all .15s;font-family:inherit;';
      b.onclick=function(){switchTab(key);};
      td.appendChild(b);
    });
    catDiv.parentNode.insertBefore(td,catDiv.nextSibling);
  });
  var g=document.getElementById('mfSchemesGrid');
  if(g) obs.observe(g,{childList:true,subtree:true});
})();

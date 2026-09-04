// MF View Tab Switching - Summary / Ranks / Risk vs Reward
// All tabs show base columns (returns, AUM, investors, rating) + tab-specific extras
(function(){
  var _currentTab = 'Summary';
  var _schemes = [];
  var _metrics = {};
  
  fetch('/api/mutual-funds/metrics').then(function(r){return r.json();}).then(function(d){
    if(d&&d.success&&d.metrics) _metrics=d.metrics;
  }).catch(function(){});
  
  // Store original render
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
  
  var tH='padding:10px 12px;font-size:10px;color:var(--text-muted);font-weight:700;white-space:nowrap;';
  function th(l){return'<th style="'+tH+'text-align:right;">'+l+'</th>';}
  function thL(l){return'<th style="'+tH+'text-align:left;">'+l+'</th>';}
  function thC(l){return'<th style="'+tH+'text-align:center;">'+l+'</th>';}
  function cellPct(v){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var cl=v>=0?'#00B386':'#EB5B56';return'<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(v>=0?'+':'')+v.toFixed(2)+'%</td>';}
  function cellAum(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(v!=null?'\u20b9'+Number(v).toLocaleString('en-IN',{maximumFractionDigits:0})+' Cr':'-')+'</td>';}
  function cellAumChg(ch){if(!ch||ch.changePct==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var p=ch.changePct,cl=p>=0?'#00B386':'#EB5B56',a=p>=0?'\u25B2':'\u25BC';return'<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+' \u20b9'+Math.abs(ch.change).toLocaleString('en-IN')+' Cr</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?'+':'')+p.toFixed(1)+'%)</span></td>';}
  function cellInv(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;white-space:nowrap;">'+(v!=null?(v>10000?(v/100000).toFixed(2)+'L':v.toLocaleString('en-IN')):'-')+'</td>';}
  function cellInvChg(ch){if(!ch||ch.change==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var p=ch.changePct||0,cl=ch.change>=0?'#00B386':'#EB5B56',a=ch.change>=0?'\u25B2':'\u25BC',vs=ch.change>=10000?(ch.change/100000).toFixed(1)+'L':ch.change.toLocaleString('en-IN');return'<td style="padding:10px 12px;text-align:right;font-size:12px;"><span style="color:'+cl+';font-weight:700;">'+a+' '+vs+'</span> <span style="color:var(--text-muted);font-size:10px;">('+(p>=0?'+':'')+p.toFixed(1)+'%)</span></td>';}
  function cellRating(sc){var bg=sc>=80?'rgba(0,179,134,0.2)':sc>=60?'rgba(245,158,11,0.2)':'rgba(235,91,86,0.2)';var fg=sc>=80?'#00B386':sc>=60?'#F59E0B':'#EB5B56';return'<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+'</span></td>';}
  function cellName(s){var nm=s.schemeName||'';return'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+(s.category||'')+'</div></td>';}
  function cellMetric(v,k){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">--</td>';if(k.indexOf('alpha')!==-1){var sg=v>0?'+':'';var cl=v>=0?'#00B386':'#EB5B56';return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:'+cl+';font-weight:600;">'+sg+(v*100).toFixed(2)+'%</td>';}if(k.indexOf('stdDev')!==-1)return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v*100).toFixed(2)+'%</td>';return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+v.toFixed(2)+'</td>';}
  function cellTer(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v!=null?v.toFixed(2)+'%':'-')+'</td>';}
  
  function rowStart(s){
    var sid=(s.id||'').replace(/'/g,'\\\\');
    return'<tr class="mf-table-row" data-cat="'+(s.category||'')+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\''+sid+'\')"><td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>';
  }
  function baseCells(s){
    var sc=calcScore(s);
    return cellName(s)+cellPct(s.returns?s.returns['1M']:null)+cellPct(s.returns?s.returns['3M']:null)+cellPct(s.returns?s.returns['6M']:null)+cellPct(s.returns?s.returns['1Y']:null)+cellAum(s.aumCr)+cellAumChg(s.aumChange1M)+cellInv(s.investorCount)+cellInvChg(s.investorChange1M)+cellRating(sc.total);
  }
  function baseThead(){
    return'<th style="'+tH+'width:28px;"></th>'+thL('Scheme name')+th('1M')+th('3M')+th('6M')+th('1Y')+th('AUM')+th('Change in AUM')+th('Investors')+th('Change in investors')+thC('Rating');
  }
  
  function buildRanksTable(){
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:2200px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+=baseThead()+thC('Score /100')+th('Perf /25')+th('Portfolio /25')+th('Operational /25')+th('Reward /25')+'</tr></thead><tbody>';
    _schemes.forEach(function(s){
      var sc=calcScore(s);
      h+=rowStart(s)+baseCells(s)+cellRating(sc.total)+'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.perf+'/25</td><td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.port+'/25</td><td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.oper+'/25</td><td style="padding:10px 12px;text-align:right;font-size:12px;">'+sc.risk+'/25</td></tr>';
    });
    return h+'</tbody></table>';
  }
  
  function buildRiskTable(){
    var mc=[['alpha_1m','Alpha 1M'],['alpha_1y','Alpha 1Y'],['alpha_3y','Alpha 3Y'],['beta_1m','Beta 1M'],['beta_1y','Beta 1Y'],['beta_3y','Beta 3Y'],['sharpe_1m','Sharpe 1M'],['sharpe_1y','Sharpe 1Y'],['sharpe_3y','Sharpe 3Y'],['sortino_1m','Sortino 1M'],['sortino_1y','Sortino 1Y'],['sortino_3y','Sortino 3Y'],['treynor_1m','Treynor 1M'],['treynor_1y','Treynor 1Y'],['treynor_3y','Treynor 3Y'],['stdDev_1m','StdDev 1M'],['stdDev_1y','StdDev 1Y'],['stdDev_3y','StdDev 3Y']];
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:2600px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+=baseThead();
    mc.forEach(function(c){h+=th(c[1]);});
    h+=th('Expense Ratio')+'</tr></thead><tbody>';
    _schemes.forEach(function(s){
      var m=_metrics[s.id]||{};
      h+=rowStart(s)+baseCells(s);
      mc.forEach(function(c){h+=cellMetric(m[c[0]],c[0]);});
      h+=cellTer(s.expenseRatio)+'</tr>';
    });
    return h+'</tbody></table>';
  }
  
  // Find the table container (the div with overflow-x:auto that contains the table)
  function getTableWrap(){
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid)return null;
    // Find the specific div that wraps the table - it has border-radius:12px and overflow:hidden
    var divs=grid.querySelectorAll('div');
    for(var i=0;i<divs.length;i++){
      if(divs[i].querySelector('table') && divs[i].style.borderRadius && divs[i].style.borderRadius.indexOf('12px')!==-1){
        return divs[i];
      }
    }
    // Fallback: find div containing table with overflow
    for(var j=0;j<divs.length;j++){
      if(divs[j].querySelector('table') && divs[j].style.overflow){
        return divs[j];
      }
    }
    return null;
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
    
    var wrap=getTableWrap();
    
    if(tab==='Summary') {
      // Re-render original table
      if(wrap) wrap.innerHTML='';
      if(_origRender) _origRender(_schemes);
    } else if(wrap) {
      wrap.innerHTML=tab==='Ranks'?buildRanksTable():buildRiskTable();
    }
  }
  
  // Inject tab buttons via MutationObserver
  var obs=new MutationObserver(function(){
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid||document.querySelector('.mf-vtab')) return;
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

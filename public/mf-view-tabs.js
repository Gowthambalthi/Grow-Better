// MF View Tab Switching - Summary / Ranks / Risk vs Reward
(function(){
  var _currentTab = 'Summary';
  var _schemes = [];
  var _metrics = {};
  
  fetch('/api/mutual-funds/metrics').then(function(r){return r.json();}).then(function(d){
    if(d&&d.success&&d.metrics) _metrics=d.metrics;
  }).catch(function(){});
  
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
  function cellAum(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:700;white-space:nowrap;">'+(v!=null?Number(v).toLocaleString('en-IN',{maximumFractionDigits:0}):'-')+'</td>';}
  function cellInv(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:var(--text-primary);font-weight:600;white-space:nowrap;">'+(v!=null?(v>100000?(v/100000).toFixed(2)+'L':v.toLocaleString('en-IN')):'-')+'</td>';}
  function cellInvGrowth(ch){if(!ch||ch.changePct==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">-</td>';var p=ch.changePct,cl=p>=0?'#00B386':'#EB5B56';return'<td style="padding:10px 12px;text-align:right;color:'+cl+';font-weight:700;font-size:12px;">'+(p>=0?'+':'')+p.toFixed(1)+'%</td>';}
  function cellRating(sc){var bg=sc>=80?'rgba(0,179,134,0.2)':sc>=60?'rgba(245,158,11,0.2)':'rgba(235,91,86,0.2)';var fg=sc>=80?'#00B386':sc>=60?'#F59E0B':'#EB5B56';return'<td style="padding:10px 12px;text-align:center;"><span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:'+bg+';color:'+fg+';font-size:11px;font-weight:800;">'+sc+'</span></td>';}
  function cellName(s){var nm=s.schemeName||'';return'<td style="padding:10px 12px;font-weight:700;font-size:12px;color:var(--text-primary);max-width:320px;"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+nm+'</div><div style="font-size:10px;color:var(--text-muted);">'+(s.category||'')+'</div></td>';}
  function cellTer(v){return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v!=null?v.toFixed(2)+'%':'-')+'</td>';}
  function cellDayChg(s){var r=s.returns||{};var v=r['1D']||r['day']||null;return cellPct(v);}
  function cellMetric(v,k){if(v==null)return'<td style="padding:10px 12px;text-align:right;color:var(--text-muted);font-size:12px;">--</td>';if(k.indexOf('alpha')!==-1){var sg=v>0?'+':'';var cl=v>=0?'#00B386':'#EB5B56';return'<td style="padding:10px 12px;text-align:right;font-size:12px;color:'+cl+';font-weight:600;">'+sg+(v*100).toFixed(2)+'%</td>';}if(k.indexOf('stdDev')!==-1)return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+(v*100).toFixed(2)+'%</td>';return'<td style="padding:10px 12px;text-align:right;font-size:12px;">'+v.toFixed(2)+'</td>';}
  
  function rowStart(s){
    var sid=(s.id||'').replace(/'/g,'\\\\');
    return'<tr class="mf-table-row" data-cat="'+(s.category||'')+'" data-amc="'+(s.parentAmc||s.amc||'Other')+'" style="border-bottom:1px solid var(--line);cursor:pointer;" onclick="openMfDetailFromTable(\''+sid+'\')"><td style="padding:10px 8px;width:28px;"><span style="color:var(--text-muted);font-size:14px;">\u2606</span></td>';
  }
  
  // SUMMARY: Scheme name, Score/100, AUM, Net expense ratio, Investors, Investor growth, Day change%, 1M%, 3M%, 6M%, 1Y%
  function buildSummaryTable(){
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH+'width:28px;"></th>'+thL('Scheme name')+thC('Score /100')+th('AUM (\u20b9 Cr)')+th('Net expense ratio')+th('Investors')+th('Investor growth')+th('Day change %')+th('1 month %')+th('3 month %')+th('6 month %')+th('1 year %');
    h+='</tr></thead><tbody>';
    _schemes.forEach(function(s){
      var sc=calcScore(s),r=s.returns||{};
      h+=rowStart(s)+cellName(s)+cellRating(sc.total)+cellAum(s.aumCr)+cellTer(s.expenseRatio)+cellInv(s.investorCount)+cellInvGrowth(s.investorChange1M)+cellDayChg(s)+cellPct(r['1M'])+cellPct(r['3M'])+cellPct(r['6M'])+cellPct(r['1Y'])+'</tr>';
    });
    return h+'</tbody></table>';
  }
  
  // RANKS: Scheme name, Score/100, Day change%, 1M%, 3M%, 6M%, 1Y% (NO AUM, NO expense, NO investors)
  function buildRanksTable(){
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH+'width:28px;"></th>'+thL('Scheme name')+thC('Score /100')+th('Day change %')+th('1 month %')+th('3 month %')+th('6 month %')+th('1 year %');
    h+='</tr></thead><tbody>';
    _schemes.forEach(function(s){
      var sc=calcScore(s),r=s.returns||{};
      h+=rowStart(s)+cellName(s)+cellRating(sc.total)+cellDayChg(s)+cellPct(r['1M'])+cellPct(r['3M'])+cellPct(r['6M'])+cellPct(r['1Y'])+'</tr>';
    });
    return h+'</tbody></table>';
  }
  
  // RISK vs REWARD: Alpha 1Y/3Y/5Y/10Y, Beta 1Y/3Y/5Y/10Y, Sharpe 1Y/3Y/5Y/10Y, Sortino 1Y/3Y/5Y/10Y, Treynor 1Y/3Y/5Y/10Y, StdDev 1Y/3Y/5Y/10Y
  function buildRiskTable(){
    var mc=[
      ['alpha_1y','Alpha 1Yr'],['alpha_3y','Alpha 3Yr'],['alpha_5y','Alpha 5Yr'],['alpha_10y','Alpha 10Yr'],
      ['beta_1y','Beta 1Yr'],['beta_3y','Beta 3Yr'],['beta_5y','Beta 5Yr'],['beta_10y','Beta 10Yr'],
      ['sharpe_1y','Sharpe Ratio 1Yr'],['sharpe_3y','Sharpe Ratio 3Yr'],['sharpe_5y','Sharpe Ratio 5Yr'],['sharpe_10y','Sharpe Ratio 10Yr'],
      ['sortino_1y','Sortino Ratio 1Yr'],['sortino_3y','Sortino Ratio 3Yr'],['sortino_5y','Sortino Ratio 5Yr'],['sortino_10y','Sortino Ratio 10Yr'],
      ['treynor_1y','Treynor Ratio 1Yr'],['treynor_3y','Treynor Ratio 3Yr'],['treynor_5y','Treynor Ratio 5Yr'],['treynor_10y','Treynor Ratio 10Yr'],
      ['stdDev_1y','Std Dev 1Yr'],['stdDev_3y','Std Dev 3Yr'],['stdDev_5y','Std Dev 5Yr'],['stdDev_10y','Std Dev 10Yr']
    ];
    var h='<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:3000px;"><thead><tr style="background:var(--bg-header);border-bottom:2px solid var(--line);">';
    h+='<th style="'+tH+'width:28px;"></th>'+thL('Scheme name');
    mc.forEach(function(c){h+=th(c[1]);});
    h+='</tr></thead><tbody>';
    _schemes.forEach(function(s){
      var m=_metrics[s.id]||{};
      h+=rowStart(s)+cellName(s);
      mc.forEach(function(c){h+=cellMetric(m[c[0]],c[0]);});
      h+='</tr>';
    });
    return h+'</tbody></table>';
  }
  
  function getTableWrap(){
    var w=document.querySelector('[data-mf-table]');
    if(w) return w;
    // Fallback
    var grid=document.getElementById('mfSchemesGrid');
    if(!grid)return null;
    var divs=grid.querySelectorAll('div');
    for(var j=0;j<divs.length;j++){
      if(divs[j].querySelector('table') && divs[j].style.overflow) return divs[j];
    }
    return null;
  }
  
  function switchTab(tab) {
    _currentTab = tab;
    document.querySelectorAll('.mf-vtab').forEach(function(b){
      var a=b.getAttribute('data-vtab')===tab;
      b.style.background=a?'#00B386':'var(--bg-input)';
      b.style.color=a?'#fff':'var(--text-muted)';
      b.style.borderColor=a?'#00B386':'var(--line)';
    });
    var wrap=getTableWrap();
    if(!wrap) return;
    if(tab==='Summary') wrap.innerHTML=buildSummaryTable();
    else if(tab==='Ranks') wrap.innerHTML=buildRanksTable();
    else wrap.innerHTML=buildRiskTable();
  }
  
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

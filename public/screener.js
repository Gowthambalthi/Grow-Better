(function(){
var S={cat:'all',seg:'All',tab:'Summary',sortKey:'score',sortDir:-1,search:''};
var AF=[];
var cats=[{k:'all',n:'All Funds'},{k:'tax',n:'Tax Savings (ELSS)'},{k:'large',n:'Large-Cap Funds'},{k:'mid',n:'Mid-Cap Funds'},{k:'small',n:'Small-Cap Funds'},{k:'index',n:'Index Funds'},{k:'money',n:'Money Market Funds'}];
var segs=['All','Equity','Hybrid','Commodities'];
var tabNames=['Summary','Ranks','Risk vs Reward'];
var catCards=[{k:'large',n:'Large-Cap Funds',d1:'Established Companies',d2:'Lower Risk With Consistent Returns',cl:'#00B386'},{k:'mid',n:'Flexi Cap Funds',d1:'Moderate Risk',d2:'Long-term (> 5 years) Investments',cl:'#3B82F6'},{k:'small',n:'Small-Cap Funds',d1:'High Growth Potential',d2:'Higher Volatility & Risk',cl:'#F59E0B'},{k:'index',n:'Index Funds',d1:'Passive Tracking',d2:'Low Cost, Market Returns',cl:'#8B5CF6'},{k:'tax',n:'Tax Saver (ELSS)',d1:'Section 80C Benefits',d2:'3-Year Lock-in Period',cl:'#EC4899'},{k:'money',n:'Money Market Funds',d1:'Low Risk Liquid Funds',d2:'Short-term Parking',cl:'#10B981'}];

function fmtCr(n){return n!=null?n.toLocaleString('en-IN',{maximumFractionDigits:0}):'--';}
function fmtNum(n){return n!=null?n.toLocaleString('en-IN'):'--';}
function pctH(n){if(n==null||isNaN(n))return'<span style="color:var(--muted)">--</span>';var s=n>0?'+':'';var c=n>=0?'up':'down';return'<span class="'+c+'">'+s+n.toFixed(2)+'%</span>';}
function mapCat(c){c=(c||'').toLowerCase();if(c.indexOf('tax')!==-1||c.indexOf('elss')!==-1)return'tax';if(c.indexOf('index')!==-1||c.indexOf('etf')!==-1)return'index';if(c.indexOf('large')!==-1)return'large';if(c.indexOf('mid')!==-1||c.indexOf('flexi')!==-1||c.indexOf('focused')!==-1||c.indexOf('multi')!==-1||c.indexOf('contra')!==-1||c.indexOf('value')!==-1)return'mid';if(c.indexOf('small')!==-1)return'small';if(c.indexOf('money')!==-1||c.indexOf('liquid')!==-1||c.indexOf('overnight')!==-1)return'money';return'other';}
function mapSeg(c){c=(c||'').toLowerCase();if(c.indexOf('hybrid')!==-1||c.indexOf('balanced')!==-1)return'Hybrid';if(c.indexOf('commodit')!==-1||c.indexOf('gold')!==-1)return'Commodities';return'Equity';}
function catMatch(k,c){if(k==='all')return true;var fc=(c||'').toLowerCase();if(k==='large')return fc.indexOf('large')!==-1;if(k==='mid')return fc.indexOf('mid')!==-1||fc.indexOf('flexi')!==-1||fc.indexOf('focused')!==-1||fc.indexOf('multi')!==-1||fc.indexOf('contra')!==-1||fc.indexOf('value')!==-1;if(k==='small')return fc.indexOf('small')!==-1;if(k==='index')return fc.indexOf('index')!==-1||fc.indexOf('etf')!==-1;if(k==='tax')return fc.indexOf('elss')!==-1||fc.indexOf('tax')!==-1;if(k==='money'||k==='Money Market')return fc.indexOf('money')!==-1||fc.indexOf('liquid')!==-1||fc.indexOf('overnight')!==-1;return true;}
function cleanName(n){var r=(n||'').toLowerCase();var w=['plan','direct','regular','retail','institutional','growth','idcw','dividend','payout','re-investment','reinvestment','scheme'];for(var i=0;i<w.length;i++){while(r.indexOf(w[i])!==-1)r=r.replace(w[i],' ');}r=r.replace(/-+/g,' ').replace(/  +/g,' ').trim();var parts=r.split(' ').filter(function(x){return x.length>0;});r=parts.join(' ');if(r===r.toUpperCase()&&r.length>0){var caps=[];for(var j=0;j<parts.length;j++){caps.push(parts[j].charAt(0).toUpperCase()+parts[j].slice(1));}r=caps.join(' ');}return r;}
function computeScores(fund){var perf=0,portfolio=0,oper=0,risk=0;var r1=fund.returns||{};var avgRet=((r1['1M']||0)+(r1['3M']||0)+(r1['6M']||0)+(r1['1Y']||0))/4;if(avgRet>0)perf+=8;if(avgRet>5)perf+=4;if(avgRet>10)perf+=4;if(avgRet>15)perf+=3;if(avgRet>20)perf+=3;if((r1['1Y']||0)>15)perf+=3;perf=Math.min(perf,25);var hCount=(fund.topHoldings||[]).length;if(hCount>0)portfolio+=5;if(hCount>10)portfolio+=5;if(hCount>20)portfolio+=5;if(fund.aum&&fund.aum>5000)portfolio+=5;if(fund.aum&&fund.aum>20000)portfolio+=5;portfolio=Math.min(portfolio,25);if(fund.expenseRatio){if(fund.expenseRatio<2.0)oper+=5;if(fund.expenseRatio<1.0)oper+=5;if(fund.expenseRatio<0.5)oper+=5;if(fund.expenseRatio<0.3)oper+=5;}if(fund.investorCount&&fund.investorCount>500000)oper+=5;oper=Math.min(oper,25);var cs=fund.confidenceScore||50;risk=Math.round((cs/100)*25);var total=perf+portfolio+oper+risk;return{perf:perf,portfolio:portfolio,oper:oper,risk:risk,total:Math.min(total,100)};}

function renderCatCards(){
  var el=document.getElementById('catCards');if(!el)return;
  el.innerHTML=catCards.map(function(cd){
    var active=S.cat===cd.k?'active':'';
    return '<div class="catcard '+active+'" data-key="'+cd.k+'">'+
      '<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="'+cd.cl+'" stroke-width="2" stroke-dasharray="20 68" transform="rotate(-90 18 18)"/><circle cx="18" cy="18" r="14" fill="none" stroke="'+cd.cl+'" stroke-width="2" stroke-dasharray="35 53" stroke-dashoffset="-20" transform="rotate(-90 18 18)" opacity="0.4"/></svg>'+
      '<h3>'+cd.n+'</h3>'+
      '<p><span class="check">&#10003;</span> '+cd.d1+'</p>'+
      '<p><span class="check">&#10003;</span> '+cd.d2+'</p>'+
    '</div>';
  }).join('');
  el.querySelectorAll('.catcard').forEach(function(card){
    card.addEventListener('click',function(){S.cat=card.dataset.key;render();});
  });
}

function renderChips(){
  var chips=document.getElementById('chips');if(!chips)return;
  chips.innerHTML=segs.map(function(seg){
    return '<div class="chip '+(S.seg===seg?'active':'')+'" data-seg="'+seg+'">'+seg+'</div>';
  }).join('');
  chips.querySelectorAll('.chip').forEach(function(el){
    el.addEventListener('click',function(){S.seg=el.dataset.seg;render();});
  });
}

function renderTabs(){
  var t=document.getElementById('tabs');if(!t)return;
  t.innerHTML=tabNames.map(function(tb){
    return '<button type="button" class="tab '+(S.tab===tb?'active':'')+'" data-tab="'+tb+'">'+tb+'</button>';
  }).join('');
  t.querySelectorAll('.tab').forEach(function(el){
    el.addEventListener('click',function(){S.tab=el.dataset.tab;render();});
  });
}

function renderPageHead(){
  var cat=cats.find(function(c){return c.k===S.cat;});
  var title=cat?cat.n:'Mutual Funds';
  var el=document.getElementById('pageTitle');if(el)el.textContent='Top '+title+' 2026';
  var desc=document.getElementById('pageDesc');if(desc)desc.textContent='Compare all mutual funds in this category based on Checklist Score, AUM, Net Expense Ratio and Risk vs Reward.';
}

var colSets={
  Summary:[
    {key:'name',label:'Fund name',sortable:false},
    {key:'score',label:'Checklist score / 100'},
    {key:'perf',label:'Performance /25'},
    {key:'portfolio',label:'Portfolio /25'},
    {key:'oper',label:'Operational /25'},
    {key:'risk',label:'Reward /25'},
    {key:'aum',label:'AUM (\u20b9 Cr)'},
    {key:'ter',label:'Net expense ratio'},
    {key:'investors',label:'Investors'},
    {key:'invGrowth',label:'Investor growth'},
    {key:'m1',label:'1 month %'},
    {key:'m3',label:'3 month %'},
    {key:'m6',label:'6 month %'},
    {key:'y1',label:'1 year %'}
  ],
  Ranks:[
    {key:'name',label:'Fund name',sortable:false},
    {key:'score',label:'Score / 100'},
    {key:'perf',label:'Performance / 25'},
    {key:'portfolio',label:'Portfolio / 25'},
    {key:'oper',label:'Operations / 25'},
    {key:'risk',label:'Risk vs Reward / 25'}
  ],
  'Risk vs Reward':[
    {key:'name',label:'Fund Name',sortable:false},
    {key:'score',label:'Score / 100'},
    {key:'m1',label:'1 Month %'},
    {key:'m3',label:'3 Month %'},
    {key:'m6',label:'6 Month %'},
    {key:'y1',label:'1 Year %'},
    {key:'alpha',label:'Alpha 1Yr'},
    {key:'beta',label:'Beta 1Yr'},
    {key:'sharpe',label:'Sharpe 1Yr'},
    {key:'sortino',label:'Sortino 1Yr'},
    {key:'treynor',label:'Treynor 1Yr'},
    {key:'stddev',label:'Std Dev 1Yr'},
    {key:'aum',label:'AUM (₹ Cr)'},
    {key:'ter',label:'Expense Ratio'},
    {key:'investors',label:'Investors'}
  ]
};

function getFiltered(){
  var rows=AF.filter(function(f){
    if(!catMatch(S.cat,f.category))return false;
    if(S.seg!=='All'){var ms=mapSeg(f.category);if(ms!==S.seg)return false;}
    if(S.search.trim()){var q=S.search.toLowerCase();var nm=(f.schemeName||'').toLowerCase();var am=(f.amc||'').toLowerCase();if(nm.indexOf(q)===-1&&am.indexOf(q)===-1)return false;}
    return true;
  });
  rows.sort(function(a,b){
    var av=a[S.sortKey],bv=b[S.sortKey];
    if(av==null)av=S.sortDir>0?Infinity:-Infinity;
    if(bv==null)bv=S.sortDir>0?Infinity:-Infinity;
    if(typeof av==='number')return(av-bv)*S.sortDir;
    return String(av).localeCompare(String(bv))*S.sortDir;
  });
  return rows;
}

function cellHTML(fund,key){
  switch(key){
    case'name':
      return '<td><div class="fundcell"><span class="star">&#9734;</span><div style="display:flex;flex-direction:column;gap:2px;"><span class="fundname">'+cleanName(fund.schemeName)+'</span><span class="fundtag">Dir · Growth · '+(fund.amc||'')+'</span></div></div></td>';
    case'score':{
      var sc=fund._scores?fund._scores.total:50;
      var cl=sc>=75?'var(--up)':sc>=60?'#D98A2B':'var(--down)';
      var bg=sc>=75?'var(--brand-soft)':sc>=60?'#FBF0DF':'#FBE4E3';
      return '<td><span class="score-track"><span class="score-badge" style="color:'+cl+';background:'+bg+';">'+sc+'</span></span></td>';
    }
    case'perf':return '<td>'+(fund._scores?fund._scores.perf:0)+'/25</td>';
    case'portfolio':return '<td>'+(fund._scores?fund._scores.portfolio:0)+'/25</td>';
    case'oper':return '<td>'+(fund._scores?fund._scores.oper:0)+'/25</td>';
    case'risk':return '<td>'+(fund._scores?fund._scores.risk:0)+'/25</td>';
    case'aum':return '<td>'+fmtCr(fund.aum)+'</td>';
    case'ter':return '<td>'+(fund.expenseRatio!=null?fund.expenseRatio.toFixed(2)+'%':'--')+'</td>';
    case'investors':return '<td>'+fmtNum(fund.investorCount)+'</td>';
    case'invGrowth':return '<td>'+pctH(fund.investorChange1M)+'</td>';
    case'm1':return '<td>'+pctH(fund.returns?fund.returns['1M']:null)+'</td>';
    case'm3':return '<td>'+pctH(fund.returns?fund.returns['3M']:null)+'</td>';
    case'm6':return '<td>'+pctH(fund.returns?fund.returns['6M']:null)+'</td>';
    case'y1':return '<td>'+pctH(fund.returns?fund.returns['1Y']:null)+'</td>';
    case'm3y':return '<td>'+pctH(fund.returns?fund.returns['3Y']:null)+'</td>';
    case'aumChg':{var v=fund.aumChange1M;return '<td>'+(v!=null?(v>0?'+':'')+Math.round(v)+' Cr':'--')+'</td>';}
    case'aumChg3m':{var v3=fund.aumChange3M;return '<td>'+(v3!=null?(v3>0?'+':'')+Math.round(v3)+' Cr':'--')+'</td>';}
    case'aumChg1y':{var v4=fund.aumChange1Y;return '<td>'+(v4!=null?(v4>0?'+':'')+Math.round(v4)+' Cr':'--')+'</td>';}
    case'invChg':{var v2=fund.investorChange1M;return '<td>'+(v2!=null?(v2>0?'+':'')+Math.round(v2):'--')+'</td>';}
    case'alpha':{var m=fund._metrics;return '<td>'+(m&&m.alpha_1y!=null?pctH(m.alpha_1y):'<span style="color:var(--muted)">--</span>')+'</td>';}
    case'beta':{var m2=fund._metrics;return '<td>'+(m2&&m2.beta_1y!=null?m2.beta_1y.toFixed(2):'<span style="color:var(--muted)">--</span>')+'</td>';}
    case'sharpe':{var m3=fund._metrics;return '<td>'+(m3&&m3.sharpe_1y!=null?m3.sharpe_1y.toFixed(2):'<span style="color:var(--muted)">--</span>')+'</td>';}
    case'sortino':{var m4=fund._metrics;return '<td>'+(m4&&m4.sortino_1y!=null?m4.sortino_1y.toFixed(2):'<span style="color:var(--muted)">--</span>')+'</td>';}
    case'treynor':{var m5=fund._metrics;return '<td>'+(m5&&m5.treynor_1y!=null?m5.treynor_1y.toFixed(2):'<span style="color:var(--muted)">--</span>')+'</td>';}
    case'stddev':{var m6=fund._metrics;return '<td>'+(m6&&m6.stdDev_1y!=null?m6.stdDev_1y.toFixed(2)+'%':'<span style="color:var(--muted)">--</span>')+'</td>';}
    default:return '<td></td>';
  }
}
function render(){
  renderPageHead();renderCatCards();renderChips();renderTabs();
  var cols=colSets[S.tab]||colSets.Summary;
  var thead=document.getElementById('theadRow');
  if(thead){
    thead.innerHTML=cols.map(function(col){
      var arrow='';
      if(col.sortable!==false){
        arrow='<span class="arrow">'+(S.sortKey===col.key?(S.sortDir===1?'\u25b2':'\u25bc'):'\u2195')+'</span>';
      }
      return '<th data-key="'+col.key+'" data-sortable="'+(col.sortable!==false)+'">'+col.label+arrow+'</th>';
    }).join('');
    thead.querySelectorAll('th').forEach(function(th){
      if(th.dataset.sortable==='true'){
        th.style.cursor='pointer';
        th.addEventListener('click',function(){
          if(S.sortKey===th.dataset.key)S.sortDir*=-1;
          else{S.sortKey=th.dataset.key;S.sortDir=-1;}
          render();
        });
      }
    });
  }
  var rows=getFiltered();
  var tbody=document.getElementById('tbody');
  if(tbody){
    tbody.innerHTML=rows.map(function(f){
      return '<tr>'+cols.map(function(col){return cellHTML(f,col.key);}).join('')+'</tr>';
    }).join('')||'<tr><td colspan="'+cols.length+'" style="text-align:center;color:var(--muted);padding:40px;font-family:IBM Plex Sans,sans-serif;">No funds match these filters</td></tr>';
  }
  var rc=document.getElementById('rowCount');
  if(rc)rc.textContent=rows.length+' fund'+(rows.length===1?'':'s')+' shown';
}

window.exportCSV=function(){
  var rows=getFiltered();if(!rows.length)return;
  var cols=colSets[S.tab]||colSets.Summary;
  var header=cols.map(function(c){return '"'+c.label.replace(/"/g,'""')+'"';}).join(',');
  var lines=[header];
  rows.forEach(function(fund){
    var line=cols.map(function(c){
      var v='';
      switch(c.key){
        case'name':v=cleanName(fund.schemeName);break;
        case'score':v=fund._scores?fund._scores.total:0;break;
        case'perf':v=fund._scores?fund._scores.perf:0;break;
        case'portfolio':v=fund._scores?fund._scores.portfolio:0;break;
        case'oper':v=fund._scores?fund._scores.oper:0;break;
        case'risk':v=fund._scores?fund._scores.risk:0;break;
        case'aum':v=fund.aum||0;break;
        case'ter':v=fund.expenseRatio||'';break;
        case'investors':v=fund.investorCount||0;break;
        case'invGrowth':v=fund.investorChange1M!=null?fund.investorChange1M.toFixed(2)+'%':'';break;
        case'm1':v=fund.returns&&fund.returns['1M']!=null?fund.returns['1M'].toFixed(2)+'%':'';break;
        case'm3':v=fund.returns&&fund.returns['3M']!=null?fund.returns['3M'].toFixed(2)+'%':'';break;
        case'm6':v=fund.returns&&fund.returns['6M']!=null?fund.returns['6M'].toFixed(2)+'%':'';break;
        case'y1':v=fund.returns&&fund.returns['1Y']!=null?fund.returns['1Y'].toFixed(2)+'%':'';break;
        case'aumChg':v=fund.aumChange1M!=null?Math.round(fund.aumChange1M):'';break;
        case'invChg':v=fund.investorChange1M!=null?Math.round(fund.investorChange1M):'';break;
      }
      return '"'+String(v).replace(/"/g,'""')+'"';
    }).join(',');
    lines.push(line);
  });
  var blob=new Blob([lines.join('\n')],{type:'text/csv'});
  var a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='mutual-funds-screener.csv';
  a.click();
};

document.getElementById('searchInput').addEventListener('input',function(e){S.search=e.target.value;render();});

fetch('/api/mutual-funds/all-schemes-summary?limit=5000')
  .then(function(r){return r.json();})
  .then(function(data){
    if(data&&data.success&&data.schemes){
      AF=data.schemes;
      AF.forEach(function(f){f._scores=computeScores(f);f._metrics=_metricsMap[f.id]||null;});
      console.log('[Screener] Loaded '+AF.length+' schemes');
    }else{AF=[];}
    render();
  })
  .catch(function(err){console.error('[Screener] Error:',err);AF=[];render();});

})();

/* ── Risk Metrics Integration ── */
var _metricsMap = {};

function loadMetrics() {
  return fetch('/api/mutual-funds/metrics')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data && data.success && data.metrics) {
        _metricsMap = data.metrics;
        console.log('[Screener] Loaded metrics for ' + Object.keys(_metricsMap).length + ' schemes');
      }
    })
    .catch(function(e) { console.log('[Screener] Metrics not available yet'); });
}

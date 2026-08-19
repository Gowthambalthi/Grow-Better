const holdings = [
  { sym: 'RELIANCE', qty: 16, avg: 1321.48, ltp: 1312.30, prevClose: 1322.00 },
  { sym: 'EMMVEE', qty: 15, avg: 346.37, ltp: 315.50, prevClose: 317.70 },
  { sym: 'CUPID', qty: 48, avg: 287.16, ltp: 278.22, prevClose: 284.03 }
];

let totInv = 0, totCur = 0, totOvrPL = 0, totTodPL = 0;

for (const h of holdings) {
  const inv = h.qty * h.avg;
  const cur = h.qty * h.ltp;
  const ovrPL = cur - inv;
  const ovrPct = (ovrPL / inv) * 100;
  const todPL = h.qty * (h.ltp - h.prevClose);
  const todPct = ((h.ltp - h.prevClose) / h.prevClose) * 100;

  totInv += inv;
  totCur += cur;
  totOvrPL += ovrPL;
  totTodPL += todPL;

  console.log(h.sym, '=> INV:', inv.toFixed(2), '| CUR:', cur.toFixed(2), '| OVR G/L:', ovrPL.toFixed(2), `(${ovrPct.toFixed(2)}%)`, '| DAY G/L:', todPL.toFixed(2), `(${todPct.toFixed(2)}%)`);
}

const totOvrPct = (totOvrPL / totInv) * 100;
const totTodPct = (totTodPL / totInv) * 100;

console.log('--- SUMMARY CARDS ---');
console.log('INVESTED:', Math.round(totInv), '| CURRENT:', Math.round(totCur), '| OVERALL LOSS:', totOvrPL.toFixed(2), `(${totOvrPct.toFixed(2)}%)`, '| TODAY LOSS:', totTodPL.toFixed(2), `(${totTodPct.toFixed(2)}%)`);

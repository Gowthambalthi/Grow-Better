const fs = require('fs');

const codePath = 'strategies/fvg/candidate_sweep_15m_fvg.js';
const docPath = 'docs/EXPLORATORY_CANDIDATE_STUDY.md';

const codeLines = fs.readFileSync(codePath, 'utf8').split('\n');
const docText = fs.readFileSync(docPath, 'utf8');

const checks = [
  { name: 'shortOnly', startLine: 180, regex: /shortOnly:\s*false/, expected: 'shortOnly: false' },
  { name: 'armingStartMin', startLine: 180, regex: /armingStartMin:\s*585/, expected: 'armingStartMin: 585' },
  { name: 'armingEndMin', startLine: 180, regex: /armingEndMin:\s*780/, expected: 'armingEndMin: 780' },
  { name: 'swingWing', startLine: 180, regex: /swingWing:\s*3/, expected: 'swingWing: 3' },
  { name: 'minWickPct', startLine: 180, regex: /minWickPct:\s*0\.35/, expected: 'minWickPct: 0.35' },
  { name: 'fvgLookback15m', startLine: 180, regex: /fvgLookback15m:\s*20/, expected: 'fvgLookback15m: 20' },
  { name: 'displacementMult', startLine: 180, regex: /displacementMult:\s*1\.5/, expected: 'displacementMult: 1.5' },
  { name: 'fvgAtrMult', startLine: 180, regex: /fvgAtrMult:\s*0\.20/, expected: 'fvgAtrMult: 0.20' },
  { name: 'stopBufferBps', startLine: 180, regex: /stopBufferBps:\s*25\.0/, expected: 'stopBufferBps: 25.0' },
  { name: 'targetBps', startLine: 180, regex: /targetBps:\s*150\.0/, expected: 'targetBps: 150.0' },
  { name: 'minRr', startLine: 180, regex: /minRr:\s*0\.1/, expected: 'minRr: 0.1' },
  { name: 'flatTollBps', startLine: 180, regex: /flatTollBps:\s*15\.0/, expected: 'flatTollBps: 15.0' },
  { name: 'sessionCloseCutoff', startLine: 220, regex: /m > 914/, expected: 'm > 914' },
  { name: 'pessimisticTie', startLine: 230, regex: /hitStop && hitTgt/, expected: 'hitStop && hitTgt' }
];

let failed = 0;
console.log('=== INTERNAL CODE-PROTOCOL CONSISTENCY CHECK ===');

for (const chk of checks) {
  let codeLineIdx = -1;
  const start = chk.startLine ? (chk.startLine - 1) : 0;
  for (let i = start; i < codeLines.length; i++) {
    if (chk.regex.test(codeLines[i])) {
      codeLineIdx = i + 1;
      break;
    }
  }

  const inDoc = docText.includes(chk.name);

  if (codeLineIdx === -1 || !inDoc) {
    console.log(`[FAIL] ${chk.name}: CodeLine=${codeLineIdx}, InDoc=${inDoc}`);
    failed++;
  } else {
    console.log(`[PASS] ${chk.name.padEnd(20)} Line ${String(codeLineIdx).padStart(3)}: ${codeLines[codeLineIdx - 1].trim()}`);
  }
}

console.log(`\nResult: ${checks.length - failed}/${checks.length} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

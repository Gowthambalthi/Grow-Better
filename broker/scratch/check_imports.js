const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat && stat.isDirectory()) {
      if (!full.includes('node_modules') && !full.includes('.git')) {
        results = results.concat(walk(full));
      }
    } else if (file.endsWith('.js')) {
      results.push(full);
    }
  });
  return results;
}

const brokerDir = path.join(__dirname, '..');
const files = walk(brokerDir);
console.log('Total JS files checked:', files.length);

let caseMismatches = 0;

files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const reqRegex = /require\(['"](\.[^'"]+)['"]\)/g;
  let match;
  while ((match = reqRegex.exec(content)) !== null) {
    const reqPath = match[1];
    const dirOfF = path.dirname(f);
    let resolved = path.resolve(dirOfF, reqPath);
    if (!fs.existsSync(resolved) && fs.existsSync(resolved + '.js')) {
      resolved = resolved + '.js';
    }
    if (!fs.existsSync(resolved)) {
      console.log('MISSING IMPORT:', f, '->', reqPath);
    } else {
      const baseName = path.basename(resolved);
      const parentDir = path.dirname(resolved);
      const actualFiles = fs.readdirSync(parentDir);
      if (!actualFiles.includes(baseName)) {
        const actual = actualFiles.find(a => a.toLowerCase() === baseName.toLowerCase());
        console.log(`CASE MISMATCH in file: ${f}\n  require string: "${reqPath}"\n  exact disk name: "${actual}"`);
        caseMismatches++;
      }
    }
  }
});

console.log(`Scan completed. Total case mismatches found: ${caseMismatches}`);

const fs = require('fs');
const path = require('path');

const serverFile = path.join(__dirname, '..', 'Server.js');
let code = fs.readFileSync(serverFile, 'utf8');

// Regex replace for express.static
code = code.replace(
  /app\.use\(express\.static\(path\.join\(__dirname,\s*'public'\)[\s\S]*?\}\)\);/,
  `app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (filePath.includes('vendor')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.png') || filePath.endsWith('.svg') || filePath.endsWith('.ico')) {
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600');
    }
  }
}));`
);

// Regex replace for app.get(['/final', '/final.html'])
code = code.replace(
  /app\.get\(\['\/final',\s*'\/final\.html'\][\s\S]*?\}\);/,
  `app.get(['/final', '/final.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'final.html'));
});`
);

// Regex replace for root app.get('/')
code = code.replace(
  /app\.get\('\/'[\s\S]*?res\.sendFile\(path\.join\(__dirname,\s*'public',\s*'scalping\.html'\)\);[\s\S]*?\}\);/,
  `app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'scalping.html'));
});`
);

// Regex replace for /dashboard
code = code.replace(
  /app\.get\(\['\/dashboard'[\s\S]*?res\.sendFile\(path\.join\(__dirname,\s*'public',\s*'scalping\.html'\)\);[\s\S]*?\}\);/,
  `app.get(['/dashboard', '/dashboard.html', '/board', '/board.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'scalping.html'));
});`
);

fs.writeFileSync(serverFile, code, 'utf8');
console.log('Successfully updated Server.js!');

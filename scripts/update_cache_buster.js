const fs = require('fs');

const files = ['public/scalping.html', 'public/index.html'];
const newVersion = 'v=20261115_calendar_select_wish_v42';

files.forEach(f => {
  if (fs.existsSync(f)) {
    let content = fs.readFileSync(f, 'utf8');
    const updated = content.replace(/scalping-app\.js\?v=[a-zA-Z0-9_-]+/g, `scalping-app.js?${newVersion}`);
    fs.writeFileSync(f, updated, 'utf8');
    console.log(`Updated cache buster in ${f} to ${newVersion}`);
  }
});

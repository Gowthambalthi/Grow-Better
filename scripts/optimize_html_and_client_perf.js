const fs = require('fs');
const path = require('path');

// 1. Clean up public/final.html
const finalPath = path.join(__dirname, '..', 'public', 'final.html');
if (fs.existsSync(finalPath)) {
  let content = fs.readFileSync(finalPath, 'utf8');

  // Add preconnect & prefetch in <head>
  if (!content.includes('rel="preconnect"')) {
    content = content.replace(
      '<link href="https://fonts.googleapis.com/css2',
      `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="prefetch" href="/" as="document">
  <link href="https://fonts.googleapis.com/css2`
    );
  }

  // Remove dead news intervals & wireTick
  content = content.replace(/setInterval\(loadNews,\s*5000\);\s*loadNews\(\);/g, '');
  content = content.replace(/wireTick\(\);/g, '');
  content = content.replace(/fetch\('\/api\/news\/refresh',\s*\{\s*method:\s*'POST'\s*\}\)\.catch\(\(\)\s*=>\s*\{\}\);/g, '');
  content = content.replace(/setInterval\(loadFinalBoard,\s*1000\);/g, 'setInterval(loadFinalBoard, 3000);');

  fs.writeFileSync(finalPath, content, 'utf8');
  console.log('PASS: Optimized public/final.html');
}

// 2. Clean up public/board.html
const boardPath = path.join(__dirname, '..', 'public', 'board.html');
if (fs.existsSync(boardPath)) {
  let content = fs.readFileSync(boardPath, 'utf8');
  if (!content.includes('rel="preconnect"')) {
    content = content.replace(
      '<link href="https://fonts.googleapis.com/css2',
      `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="prefetch" href="/" as="document">
  <link href="https://fonts.googleapis.com/css2`
    );
  }
  content = content.replace(/setInterval\(loadNews,\s*5000\);\s*loadNews\(\);/g, '');
  content = content.replace(/setInterval\(loadFinalBoard,\s*1000\);/g, 'setInterval(loadFinalBoard, 3000);');
  fs.writeFileSync(boardPath, content, 'utf8');
  console.log('PASS: Optimized public/board.html');
}

// 3. Add prefetch in public/scalping.html and public/index.html
['public/scalping.html', 'public/index.html'].forEach(relFile => {
  const fPath = path.join(__dirname, '..', relFile);
  if (fs.existsSync(fPath)) {
    let content = fs.readFileSync(fPath, 'utf8');
    if (!content.includes('rel="prefetch"')) {
      content = content.replace(
        '<link href="https://fonts.googleapis.com/css2',
        `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="prefetch" href="/final.html" as="document">
  <link href="https://fonts.googleapis.com/css2`
      );
      fs.writeFileSync(fPath, content, 'utf8');
      console.log('PASS: Added preconnect & prefetch in', relFile);
    }
  }
});

// 4. Update sidebar links in src/scalping-app.jsx to include Individual / Family and Foreign Funds
const appPath = path.join(__dirname, '..', 'src', 'scalping-app.jsx');
if (fs.existsSync(appPath)) {
  let content = fs.readFileSync(appPath, 'utf8');
  const targetPattern = `/*#__PURE__*/React.createElement(\"span\", null, \"Smart Money\")), /*#__PURE__*/React.createElement(\"a\", {\n    className: \"nav-item\",\n    href: \"/final.html#alerts\"`;
  
  const replacement = `/*#__PURE__*/React.createElement(\"span\", null, \"Smart Money\")), /*#__PURE__*/React.createElement(\"a\", {\n    className: \"nav-item\",\n    href: \"/final.html#individual-family\"\n  }, /*#__PURE__*/React.createElement(\"svg\", {\n    className: \"nav-icon\",\n    viewBox: \"0 0 24 24\"\n  }, /*#__PURE__*/React.createElement(\"circle\", {\n    cx: \"9\",\n    cy: \"7\",\n    r: \"3\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  }), /*#__PURE__*/React.createElement(\"circle\", {\n    cx: \"17\",\n    cy: \"7\",\n    r: \"3\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  }), /*#__PURE__*/React.createElement(\"path\", {\n    d: \"M2 21v-2a5 5 0 0110 0v2\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  }), /*#__PURE__*/React.createElement(\"path\", {\n    d: \"M14 21v-1a4 4 0 014-4\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  })), /*#__PURE__*/React.createElement(\"span\", null, \"Individual / Family\")), /*#__PURE__*/React.createElement(\"a\", {\n    className: \"nav-item\",\n    href: \"/final.html#foreign-funds\"\n  }, /*#__PURE__*/React.createElement(\"svg\", {\n    className: \"nav-icon\",\n    viewBox: \"0 0 24 24\"\n  }, /*#__PURE__*/React.createElement(\"circle\", {\n    cx: \"12\",\n    cy: \"12\",\n    r: \"10\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  }), /*#__PURE__*/React.createElement(\"path\", {\n    d: \"M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z\",\n    fill: \"none\",\n    stroke: \"currentColor\",\n    strokeWidth: \"1.8\"\n  })), /*#__PURE__*/React.createElement(\"span\", null, \"Foreign Funds\")), /*#__PURE__*/React.createElement(\"a\", {\n    className: \"nav-item\",\n    href: \"/final.html#alerts\"`;

  if (content.replace(/\r\n/g, '\n').includes(targetPattern)) {
    content = content.replace(/\r\n/g, '\n').replace(targetPattern, replacement);
    fs.writeFileSync(appPath, content, 'utf8');
    console.log('PASS: Added Individual / Family and Foreign Funds in scalping-app.jsx sidebar');
  } else {
    console.log('SKIP: targetPattern for sidebar in scalping-app.jsx not matched');
  }
}

console.log('ALL OPTIMIZATIONS COMPLETE!');

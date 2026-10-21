/**
 * scripts/start-cloud-tunnel.js
 * 
 * Creates a free, self-healing Cloudflare Tunnel to expose your local 24/7 trading server
 * to the internet with a public HTTPS URL.
 * 
 * Features:
 * - 100% Free forever, no credit card required.
 * - Active self-healing watchdog: checks public health every 45 seconds. If Cloudflare drops
 *   the link, it immediately recycles the tunnel and generates a fresh live URL.
 * - Auto-dispatches the live URL to your Telegram bot so you always have the active link on your phone.
 * - Activates Windows Keep-Awake to prevent sleep when laptop lid is closed.
 * - Saves current public URL to logs/live-cloud-url.txt.
 */
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const CLOUDFLARED = path.join(ROOT, 'tools', 'cloudflared.exe');
const LOG_FILE = path.join(ROOT, 'logs', 'live-cloud-url.txt');
const TARGET_PORT = process.env.PORT || 4000;

if (!fs.existsSync(CLOUDFLARED)) {
  console.error(`❌ Cloudflared binary not found at ${CLOUDFLARED}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'logs'))) {
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
}

// 1. Keep-Awake Guard on Windows
let keepAwakeProc = null;
if (process.platform === 'win32') {
  const keepAwakeScript = path.join(__dirname, 'keep-awake.ps1');
  if (fs.existsSync(keepAwakeScript)) {
    try {
      keepAwakeProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', keepAwakeScript], {
        windowsHide: true,
        stdio: 'ignore'
      });
      console.log('⚡ Laptop Keep-Awake guard active (system will stay awake 24/7 with lid closed).');
    } catch (_) {}
  }

  // Check battery status
  exec('powershell -NoProfile -Command "(Get-CimInstance Win32_Battery).EstimatedChargeRemaining"', (err, stdout) => {
    if (!err && stdout) {
      const pct = parseInt(stdout.trim(), 10);
      if (pct <= 20) {
        console.log(`⚠️  BATTERY WARNING: Laptop battery is at ${pct}%. Keep charger plugged in for 24/7 uptime!`);
      }
    }
  });
}

console.log('=================================================================');
console.log(`🌐 Initializing 24/7 Cloudflare Tunnel -> http://localhost:${TARGET_PORT}...`);
console.log('=================================================================');

let tunnelProc = null;
let shuttingDown = false;
let currentUrl = null;
let watchdogTimer = null;
let failureCount = 0;

function notifyTelegram(url) {
  try {
    const { sendPhoneNotification } = require('../common/notifications/telegramService');
    const msg = `🌐 <b>Grow Better 24/7 Terminal Live</b>\n\n` +
      `🔗 <b>Dashboard:</b> ${url}\n` +
      `⚡ <b>Engine:</b> Port ${TARGET_PORT} (Angel One Active)\n\n` +
      `📱 <i>You can safely close your laptop lid. The server is online 24/7.</i>`;
    sendPhoneNotification(msg).catch(() => {});
  } catch (_) {}
}

function startTunnel() {
  if (shuttingDown) return;

  if (tunnelProc) {
    try { tunnelProc.kill(); } catch (_) {}
    tunnelProc = null;
  }

  failureCount = 0;
  console.log(`[${new Date().toLocaleTimeString()}] Spawning Cloudflare Tunnel process...`);

  tunnelProc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://localhost:${TARGET_PORT}`], {
    windowsHide: true,
  });

  let urlFound = false;

  tunnelProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !urlFound) {
      urlFound = true;
      currentUrl = match[0];
      try {
        fs.writeFileSync(LOG_FILE, currentUrl, 'utf8');
      } catch (_) {}

      console.log('\n=================================================================');
      console.log('🚀 YOUR 24/7 LIVE CLOUD TRADING URL IS READY!');
      console.log('=================================================================');
      console.log(`👉 PUBLIC CLOUD URL:  ${currentUrl}`);
      console.log(`👉 LOCAL BROWSER URL: http://localhost:${TARGET_PORT}`);
      console.log('=================================================================');
      console.log('📱 Opening link on mobile / remote browser...');
      console.log('💻 Close your laptop lid anytime; engine runs continuously.');
      console.log('=================================================================\n');

      notifyTelegram(currentUrl);
      startWatchdog();
    }
  });

  let retryDelay = 5000;
  tunnelProc.on('close', (code) => {
    if (shuttingDown) return;
    if (!urlFound) {
      retryDelay = Math.min(Math.round(retryDelay * 1.5), 60000);
    } else {
      retryDelay = 5000;
    }
    console.log(`⚠️ Cloudflare tunnel disconnected (exit code ${code}). Reconnecting in ${Math.round(retryDelay / 1000)}s...`);
    setTimeout(startTunnel, retryDelay);
  });

  tunnelProc.on('error', (err) => {
    if (shuttingDown) return;
    console.error(`⚠️ Cloudflare tunnel error: ${err.message}. Retrying in 5s...`);
    setTimeout(startTunnel, 5000);
  });
}

function startWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);

  watchdogTimer = setInterval(() => {
    if (shuttingDown || !currentUrl) return;

    const req = https.get(currentUrl + '/health', { timeout: 8000 }, (res) => {
      if (res.statusCode === 200) {
        failureCount = 0;
      } else {
        failureCount++;
        handleFailure();
      }
    });

    req.on('error', () => {
      failureCount++;
      handleFailure();
    });

    req.on('timeout', () => {
      req.destroy();
      failureCount++;
      handleFailure();
    });
  }, 45000);
}

function handleFailure() {
  if (failureCount >= 2) {
    console.log(`\n⚠️  [Watchdog] Public URL (${currentUrl}) became unreachable. Recycling tunnel to generate fresh live link...`);
    failureCount = 0;
    if (tunnelProc) {
      try { tunnelProc.kill(); } catch (_) {}
    }
    setTimeout(startTunnel, 2000);
  }
}

startTunnel();

function cleanup() {
  shuttingDown = true;
  if (watchdogTimer) clearInterval(watchdogTimer);
  console.log('\nStopping Cloudflare tunnel and keep-awake guard...');
  if (tunnelProc) {
    try { tunnelProc.kill(); } catch (_) {}
  }
  if (keepAwakeProc) {
    try { keepAwakeProc.kill(); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

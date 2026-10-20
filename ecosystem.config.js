/**
 * ecosystem.config.js — Production 24/7 PM2 Daemon Configuration
 * 
 * Works identically on Linux Cloud VPS (Oracle/AWS/DigitalOcean) and Windows.
 * Launches Server.js from the repository root with auto-restart on crash,
 * persistent tick capture, and short-only GB03 enforcement.
 * 
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: "growbetter-live",
      script: "./Server.js",
      cwd: __dirname,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        GB_TICK_CAPTURE: "1",
        GB03_SIDES: "short",
      },
      error_file: path.join(__dirname, "logs", "pm2-error.log"),
      out_file: path.join(__dirname, "logs", "pm2-out.log"),
      time: true
    }
  ]
};


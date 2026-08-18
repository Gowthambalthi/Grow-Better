module.exports = {
  apps: [
    {
      name: "growbetter-broker",
      script: "./Server.js",
      cwd: "c:/Users/goutham/openalgo/broker",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 4000
      }
    }
  ]
};

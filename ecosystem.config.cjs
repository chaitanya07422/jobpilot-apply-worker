/** PM2 process file — run from repo root: pm2 start ecosystem.config.cjs */
module.exports = {
  apps: [
    {
      name: 'jobpilot-apply-worker',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      min_uptime: '5s',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

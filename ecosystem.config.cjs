module.exports = {
  apps: [
    {
      name: 'telegram-bot-production',
      script: './dist/bot.js',
      instances: 1, // Telegram long-polling bot MUST run exactly 1 instance to prevent 409 Conflict
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '800M',
      exp_backoff_restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};

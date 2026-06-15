module.exports = {
  apps: [
    {
      name: 'chattikovia-server',
      script: 'src/index.js',
      instances: 1, // Chạy fork mode để Socket.io hoạt động ổn định trên VPS đơn mà không cần thiết lập Redis Adapter cồng kềnh
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G', // Tự động khởi động lại nếu tiến trình ngốn quá 1GB RAM để tránh tràn bộ nhớ
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true, // Tự động restart nếu bị crash đột xuất
      restart_delay: 2000 // Chờ 2 giây trước khi restart để tránh loop crash liên tục
    }
  ]
};

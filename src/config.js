/**
 * Cấu hình tập trung cho ChatTikovia Server
 * Tất cả constants được đọc từ biến môi trường (.env) với giá trị mặc định an toàn.
 */

const DEFAULT_JWT_SECRET = 'chattikovia_super_secret_key_12345';

const config = {
  PORT: parseInt(process.env.PORT, 10) || 5000,
  JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50,
  NODE_ENV: process.env.NODE_ENV || 'development',
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || 'mailto:admin@tikovia.com',
  SYSTEM_API_KEY: process.env.SYSTEM_API_KEY || '',

  // CORS: Danh sách domain được phép kết nối (phân cách bằng dấu phẩy)
  // Ví dụ: CORS_ORIGINS=https://chat.tikovia.com,http://localhost:5173
  CORS_ORIGINS:
    process.env.CORS_ORIGINS && process.env.CORS_ORIGINS.trim() !== '*'
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : '*',
};

// Cảnh báo bảo mật khi khởi động
if (config.JWT_SECRET === DEFAULT_JWT_SECRET && config.NODE_ENV === 'production') {
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  ⚠️  CẢNH BÁO BẢO MẬT: JWT_SECRET đang dùng giá trị mặc định! ║');
  console.error('║  Vui lòng đặt JWT_SECRET riêng trong file .env trước khi    ║');
  console.error('║  triển khai lên production.                                  ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
}

module.exports = config;

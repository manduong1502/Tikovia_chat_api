/**
 * Cấu hình tập trung cho ChatTikovia Server
 * Tất cả constants được đọc từ biến môi trường (.env) với giá trị mặc định cho môi trường dev.
 */

const DEFAULT_JWT_SECRET = 'chattikovia_super_secret_key_12345';

const config = {
  PORT: parseInt(process.env.PORT, 10) || 5000,
  JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  NODE_ENV: process.env.NODE_ENV || 'development',

  // CORS: Danh sách domain được phép kết nối (phân cách bằng dấu phẩy)
  // Ví dụ: CORS_ORIGINS=https://chat.tikovia.vn,https://admin.tikovia.vn
  CORS_ORIGINS: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
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
